export type SqlValue = ArrayBuffer | ArrayBufferView | bigint | boolean | number | string | null;

export type SchemaObject = { name: string; sql: string; type: string };

export type DumpTable = { columns: string[]; name: string; rows: SqlValue[][] };

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

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

type DumpSpot = {
  column: string;
  count: number;
  max: string | null;
  min: string | null;
  table: string;
};

export type DumpManifest = {
  generatedAt: string;
  source: string;
  spot: DumpSpot | null;
  sqlBytes: number;
  tableCount: number;
  tables: Record<string, number>;
};

export type AnchorCandidate = { firstColumn: string; name: string; rowCount: number };

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

export type ManifestCheck = Pick<DumpManifest, "spot" | "tableCount" | "tables">;

export type VerifyReport = { ok: boolean; problems: string[] };

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
    const folders = [...groups.keys()].sort((a, b) => b.localeCompare(a));

    for (const folder of folders.slice(Math.max(0, keep))) {
      expired.push(...(groups.get(folder) ?? []));
    }
  };

  prune(groupByFolder(options.dailyPrefix, /^\d{4}-\d{2}-\d{2}$/), options.keepDaily);
  prune(groupByFolder(options.monthlyPrefix, /^\d{4}-\d{2}$/), options.keepMonthly);

  return expired.sort();
}
