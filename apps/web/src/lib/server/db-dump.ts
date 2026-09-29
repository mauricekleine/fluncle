export type SqlValue = ArrayBuffer | ArrayBufferView | bigint | boolean | number | string | null;

export type SchemaObject = { name: string; sql: string; type: string };

export type DumpTable = { columns: string[]; name: string; rows: SqlValue[][] };

export type SequenceHead = { name: string; seq: SqlValue };

export const DUMP_SCHEMA_SQL = `SELECT type, name, sql FROM sqlite_master
   WHERE sql IS NOT NULL
     AND name NOT LIKE 'sqlite_%'
     AND name NOT LIKE 'libsql_%'
     AND name NOT LIKE '_litestream%'
     AND name NOT LIKE 'tracks_fts%'
   ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END, name`;

export const SEARCH_INDEX_PREFIX = "tracks_fts";

export const PRIMARY_KEY_COLUMNS_SQL =
  "SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk";

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

export function isWithoutRowid(object: SchemaObject): boolean {
  return /\bwithout\s+rowid\b/i.test(object.sql);
}

export function keysetPageSql(table: string, keys: readonly string[], after: boolean): string {
  const keyList = keys.map((key) => (key === "rowid" ? "rowid" : quoteIdent(key))).join(", ");
  const where = after ? ` WHERE (${keyList}) > (${keys.map(() => "?").join(", ")})` : "";

  return `SELECT ${keyList}, * FROM ${quoteIdent(table)}${where} ORDER BY ${keyList} LIMIT ?`;
}

export function sequenceHeadStatements(head: SequenceHead): string[] {
  const name = sqlLiteral(head.name);

  return [
    `DELETE FROM sqlite_sequence WHERE name = ${name};`,
    `INSERT INTO sqlite_sequence (name, seq) VALUES (${name}, ${sqlLiteral(head.seq)});`,
  ];
}

export function buildDumpSql(
  schema: readonly SchemaObject[],
  tables: readonly DumpTable[],
  header = "-- Fluncle database dump. Do not edit by hand.",
  sequences: readonly SequenceHead[] = [],
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

  for (const head of sequences) {
    parts.push(...sequenceHeadStatements(head));
  }

  for (const object of schema) {
    if (object.type !== "table") {
      parts.push(`${object.sql};`);
    }
  }

  parts.push("COMMIT;");

  return `${parts.join("\n")}\n`;
}

const LEADING_TRIVIA = String.raw`(?:\s|--[^\n]*(?:\n|$)|/\*[\s\S]*?\*/)*`;
const TRIGGER_START = new RegExp(
  `^${LEADING_TRIVIA}CREATE\\s+(?:TEMP\\s+|TEMPORARY\\s+)?TRIGGER\\b`,
  "i",
);
const SEARCH_INDEX_STATEMENT = new RegExp(
  `^${LEADING_TRIVIA}(?:CREATE\\s+(?:VIRTUAL\\s+)?TABLE|CREATE\\s+(?:TEMP\\s+|TEMPORARY\\s+)?TRIGGER|INSERT\\s+INTO)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?["'\`\\[]?${SEARCH_INDEX_PREFIX}`,
  "i",
);

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === "'" || char === '"' || char === "`" || char === "[") {
      const close = char === "[" ? "]" : char;
      index += 1;

      while (index < sql.length) {
        if (sql[index] === close) {
          if (close !== "]" && sql[index + 1] === close) {
            index += 2;
            continue;
          }

          break;
        }

        index += 1;
      }
    } else if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end;
    } else if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 1;
    } else if (char === ";") {
      const candidate = sql.slice(start, index);

      if (!TRIGGER_START.test(candidate) || /\bEND\s*$/i.test(candidate)) {
        const end = sql[index + 1] === "\n" ? index + 2 : index + 1;

        statements.push(sql.slice(start, end));
        start = end;
        index = end;
        continue;
      }
    }

    index += 1;
  }

  if (start < sql.length) {
    statements.push(sql.slice(start));
  }

  return statements;
}

export function stripSearchIndex(sql: string): { dropped: number; sql: string } {
  const kept: string[] = [];
  let dropped = 0;

  for (const statement of splitSqlStatements(sql)) {
    if (SEARCH_INDEX_STATEMENT.test(statement)) {
      dropped += 1;
    } else {
      kept.push(statement);
    }
  }

  return { dropped, sql: kept.join("") };
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

export function withoutSearchIndexTables(check: ManifestCheck): ManifestCheck {
  const kept = Object.entries(check.tables).filter(
    ([name]) => !name.startsWith(SEARCH_INDEX_PREFIX),
  );

  return {
    spot: check.spot,
    tableCount: check.tableCount - (Object.keys(check.tables).length - kept.length),
    tables: Object.fromEntries(kept),
  };
}

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
