import { fnv1a32 } from "@fluncle/contracts/util/hash";

export const DATABASE_ACCESS_CLASSES = ["read", "write", "heavy-read"] as const;
export type DatabaseAccessClass = (typeof DATABASE_ACCESS_CLASSES)[number];

export const DATABASE_OUTCOMES = ["success", "failure"] as const;
export type DatabaseOutcome = (typeof DATABASE_OUTCOMES)[number];

export const DATABASE_OPERATION_ID_MAX_LENGTH = 64;
export const DATABASE_RELEASE_MAX_LENGTH = 64;

const DATABASE_OPERATION_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const DATABASE_RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isDatabaseAccessClass(value: unknown): value is DatabaseAccessClass {
  return (
    typeof value === "string" && (DATABASE_ACCESS_CLASSES as readonly string[]).includes(value)
  );
}

export function isDatabaseOperationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= DATABASE_OPERATION_ID_MAX_LENGTH &&
    DATABASE_OPERATION_ID_PATTERN.test(value)
  );
}

export function canonicalSqlShape(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n\r]*/g, " ")
    .replace(/'(?:''|[^'])*'/g, "?")
    .replace(/\b(?:0x[0-9a-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/gi, "?")
    .replace(/(?:\?|[:@$][a-z_][a-z0-9_]*)(?:\d+)?/gi, "?")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function stableToken(value: string): string {
  return fnv1a32(value).toString(36).padStart(7, "0");
}

export function normalizeDatabaseOperationId(
  candidate: unknown,
  fallbackShape: string,
  accessClass: DatabaseAccessClass,
): string {
  if (isDatabaseOperationId(candidate)) {
    return candidate;
  }

  return `db.${accessClass}.${stableToken(fallbackShape)}`;
}

export function normalizeDatabaseRelease(candidate: unknown): string {
  if (
    typeof candidate === "string" &&
    candidate.length <= DATABASE_RELEASE_MAX_LENGTH &&
    DATABASE_RELEASE_PATTERN.test(candidate)
  ) {
    return candidate;
  }

  return "unknown";
}

const LEADING_SQL_NOISE = /^(?:\s|--[^\n]*|\/\*[\s\S]*?\*\/)+/;
const SQL_WRITE_VERB = /\b(?:insert|update|delete|replace)\b/;

export function classifyDatabaseAccess(sql: string): Exclude<DatabaseAccessClass, "heavy-read"> {
  const normalized = sql.replace(LEADING_SQL_NOISE, "").toLowerCase();

  if (/^select\b/.test(normalized)) {
    return "read";
  }

  if (/^with\b/.test(normalized) && !SQL_WRITE_VERB.test(normalized)) {
    return "read";
  }

  return "write";
}

const HEAVY_READ_SQL_FUNCTION = /\bvector_distance_cos\s*\(/i;

export function classifyDatabaseOperationAccess(sql: string): DatabaseAccessClass {
  const accessClass = classifyDatabaseAccess(sql);

  return accessClass === "read" && HEAVY_READ_SQL_FUNCTION.test(sql) ? "heavy-read" : accessClass;
}
