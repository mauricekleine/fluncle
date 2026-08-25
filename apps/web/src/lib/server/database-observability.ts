/**
 * Public-safe vocabulary shared by database spans, the recurring-operation
 * registry, and fleet run telemetry.
 *
 * Keep these fields low-cardinality and payload-free. They identify the kind
 * of work, never the row, SQL arguments, a remote endpoint, or an operator.
 */
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

/**
 * Collapse literals and comments before deriving an identifier. The resulting
 * shape is used only as hash input; it is never emitted to telemetry.
 */
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

/** FNV-1a expressed as an unsigned, fixed-width base36 token. */
function stableToken(value: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(36).padStart(7, "0");
}

/**
 * Validate a caller-supplied stable ID. Missing or unsafe values collapse to a
 * deterministic, bounded fallback derived from a redacted statement shape.
 */
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

/** A release is a public build identifier, normally a commit SHA. */
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

/**
 * Conservative access classification. Unknown statements are writes because
 * understating write pressure is worse than overstating it.
 */
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
