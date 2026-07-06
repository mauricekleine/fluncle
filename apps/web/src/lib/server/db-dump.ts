// Pure SQL-dump / restore-verify / backup-retention logic for the Turso (libSQL)
// database. NO database client and NO Node/Bun built-ins — this module takes
// already-fetched rows and returns strings/plain objects, so it is Worker-safe,
// trivially unit-testable, and shared by every dump path:
//
//   - `apps/web/scripts/db-pull-prod.ts` — the dev seed (prod → .dev/seed.sql).
//   - `apps/web/scripts/restore-drill.ts` — the backup restore drill (the acceptance test).
//   - `docs/agents/hermes/scripts/backup-sweep.ts` — the on-box daily R2 backup cron.
//
// The box sweep is a SELF-CONTAINED file (it can't import the workspace on the box),
// so it MIRRORS `sqlLiteral` / `quoteIdent` / `buildDumpSql` / `chooseAnchor` /
// `selectExpiredBackupKeys` verbatim — keep the two in step (the same "mirror of the
// registry" discipline the healthcheck prober uses). The dump FORMAT is proven
// restorable continuously: this is the exact SQL `db-refresh.ts` loads into every
// worktree's local.db daily via `sqlite3`.

/** The JS value shapes a libSQL cell decodes to (matches `@libsql/client` defaults with `intMode:"bigint"`). */
export type SqlValue = ArrayBuffer | ArrayBufferView | bigint | boolean | number | string | null;

/** One schema object from `sqlite_master` (a table, index, trigger or view). */
export type SchemaObject = { name: string; sql: string; type: string };

/** One fetched table: its name, ordered column list, and every row (cells in column order). */
export type DumpTable = { columns: string[]; name: string; rows: SqlValue[][] };

/** Double-quote a SQL identifier, escaping embedded double-quotes. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Render one JS value as a SQLite literal for an INSERT. Byte-exact for blobs and integers. */
export function sqlLiteral(value: SqlValue): string {
  if (value === null || value === undefined) {
    return "NULL";
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }

  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    let hex = "";

    for (const byte of bytes) {
      hex += byte.toString(16).padStart(2, "0");
    }

    return `X'${hex}'`;
  }

  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Assemble a full, restorable SQL dump from the fetched schema + table data. The
 * order is the one SQLite's own `.dump` uses and `db-refresh.ts` proves daily:
 * tables first (so the INSERTs land), then every row, then indexes/triggers/views
 * last (after the rows they depend on exist). Wrapped in one transaction with
 * foreign keys off, so it loads as a single atomic unit.
 */
export function buildDumpSql(
  schema: readonly SchemaObject[],
  tables: readonly DumpTable[],
  header = "-- Fluncle database dump. Do not edit by hand.",
): string {
  const parts: string[] = [header, "PRAGMA foreign_keys=OFF;", "BEGIN TRANSACTION;"];

  for (const object of schema) {
    if (object.type === "table") {
      parts.push(`${object.sql};`);
    }
  }

  for (const table of tables) {
    if (table.rows.length === 0) {
      continue;
    }

    const columnList = table.columns.map(quoteIdent).join(", ");

    for (const row of table.rows) {
      const values = row.map(sqlLiteral).join(", ");

      parts.push(`INSERT INTO ${quoteIdent(table.name)} (${columnList}) VALUES (${values});`);
    }
  }

  for (const object of schema) {
    if (object.type !== "table") {
      parts.push(`${object.sql};`);
    }
  }

  parts.push("COMMIT;");

  return `${parts.join("\n")}\n`;
}

// ── Manifest (the integrity fingerprint captured at dump time) ───────────────

/** A content spot-check for the anchor table: engine-computed count + min/max of one column. */
export type DumpSpot = {
  column: string;
  count: number;
  max: string | null;
  min: string | null;
  table: string;
};

/**
 * The manifest captured alongside every dump. The restore drill recomputes the
 * same shape against the restored database and asserts equality — proving the
 * schema (`tableCount`), every table's full data (`tables`), and actual content
 * values (`spot`) all survived the round trip. `sqlBytes` is informational (a
 * restore re-serializes, so byte size is not compared).
 */
export type DumpManifest = {
  generatedAt: string;
  source: string;
  spot: DumpSpot | null;
  sqlBytes: number;
  tableCount: number;
  tables: Record<string, number>;
};

/** A table's identity for anchor selection: its name, row count, and first column. */
export type AnchorCandidate = { firstColumn: string; name: string; rowCount: number };

/**
 * Pick the deterministic anchor table+column for the spot check. Prefers `tracks`
 * (the heart of the archive), else the non-empty table with the most rows, ties
 * broken by name — so the box (dump time) and the drill (restore time) always
 * fingerprint the same table. Returns null when there is no non-empty table.
 */
export function chooseAnchor(candidates: readonly AnchorCandidate[]): {
  column: string;
  table: string;
} | null {
  const eligible = candidates.filter(
    (candidate) => candidate.rowCount > 0 && candidate.firstColumn !== "",
  );

  if (eligible.length === 0) {
    return null;
  }

  const tracks = eligible.find((candidate) => candidate.name === "tracks");
  const chosen =
    tracks ??
    [...eligible].sort((a, b) => b.rowCount - a.rowCount || a.name.localeCompare(b.name))[0];

  if (!chosen) {
    return null;
  }

  return { column: chosen.firstColumn, table: chosen.name };
}

/** Coerce a queried min/max cell to the manifest's stable string|null form. */
export function spotCell(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }

  // A blob min/max (rare, e.g. a BLOB primary key) — hex it, so the fingerprint is
  // stable + comparable across the dump and the restore.
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    let hex = "";
    for (const byte of bytes) {
      hex += byte.toString(16).padStart(2, "0");
    }
    return hex;
  }

  return JSON.stringify(value);
}

/** The subset of a manifest the restore drill recomputes and compares. */
export type ManifestCheck = Pick<DumpManifest, "spot" | "tableCount" | "tables">;

/** A restore-drill verdict: a list of concrete problems (empty ⇒ the restore matched the manifest). */
export type VerifyReport = { ok: boolean; problems: string[] };

/**
 * Compare a freshly-restored database's shape (`actual`) against the dump-time
 * manifest (`expected`). A single mismatched table count, a missing/extra table,
 * or a drifted spot value is a hard fail — a backup that restores to different
 * data is not a backup.
 */
export function verifyManifest(expected: ManifestCheck, actual: ManifestCheck): VerifyReport {
  const problems: string[] = [];

  if (actual.tableCount !== expected.tableCount) {
    problems.push(`table count: expected ${expected.tableCount}, restored ${actual.tableCount}`);
  }

  const expectedNames = Object.keys(expected.tables).sort();
  const actualNames = new Set(Object.keys(actual.tables));

  for (const name of expectedNames) {
    if (!actualNames.has(name)) {
      problems.push(`table "${name}" missing after restore`);
      continue;
    }

    if (actual.tables[name] !== expected.tables[name]) {
      problems.push(
        `table "${name}" row count: expected ${expected.tables[name]}, restored ${actual.tables[name]}`,
      );
    }
  }

  for (const name of actualNames) {
    if (expected.tables[name] === undefined) {
      problems.push(`unexpected table "${name}" after restore`);
    }
  }

  const { spot } = expected;

  if (spot) {
    const restored = actual.spot;

    if (!restored) {
      problems.push(`spot check "${spot.table}.${spot.column}" absent after restore`);
    } else if (
      restored.table !== spot.table ||
      restored.column !== spot.column ||
      restored.count !== spot.count ||
      restored.min !== spot.min ||
      restored.max !== spot.max
    ) {
      problems.push(
        `spot check "${spot.table}.${spot.column}" drifted: expected ${JSON.stringify({
          count: spot.count,
          max: spot.max,
          min: spot.min,
        })}, restored ${JSON.stringify({
          count: restored.count,
          max: restored.max,
          min: restored.min,
        })}`,
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

// ── Retention (which R2 backup keys the sweep prunes) ────────────────────────

/**
 * Given every backup object key currently in the bucket, return the keys to
 * DELETE to hold retention: keep the newest `keepDaily` daily dates and the
 * newest `keepMonthly` monthly months; everything older is expired. Keys are
 * grouped by the date/month segment right after each tier's prefix, so a dump
 * and its sidecar manifest under the same date are pruned together. Pure and
 * conservative: an unparseable key is never selected for deletion.
 *
 * Daily keys:   `<dailyPrefix><YYYY-MM-DD>/<file>`
 * Monthly keys: `<monthlyPrefix><YYYY-MM>/<file>`
 */
export function selectExpiredBackupKeys(
  keys: readonly string[],
  options: {
    dailyPrefix: string;
    keepDaily: number;
    keepMonthly: number;
    monthlyPrefix: string;
  },
): string[] {
  const groupByFolder = (prefix: string, segment: RegExp): Map<string, string[]> => {
    const groups = new Map<string, string[]>();

    for (const key of keys) {
      if (!key.startsWith(prefix)) {
        continue;
      }

      const rest = key.slice(prefix.length);
      const folder = rest.split("/")[0] ?? "";

      if (!segment.test(folder)) {
        continue;
      }

      const bucket = groups.get(folder) ?? [];

      bucket.push(key);
      groups.set(folder, bucket);
    }

    return groups;
  };

  const expired: string[] = [];

  const prune = (groups: Map<string, string[]>, keep: number): void => {
    const folders = [...groups.keys()].sort((a, b) => b.localeCompare(a)); // newest first

    for (const folder of folders.slice(Math.max(0, keep))) {
      expired.push(...(groups.get(folder) ?? []));
    }
  };

  prune(groupByFolder(options.dailyPrefix, /^\d{4}-\d{2}-\d{2}$/), options.keepDaily);
  prune(groupByFolder(options.monthlyPrefix, /^\d{4}-\d{2}$/), options.keepMonthly);

  return expired.sort();
}
