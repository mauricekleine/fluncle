import { type Client, type InStatement, type ResultSet } from "@libsql/client/web";
import { databaseOperationStatement } from "./db";

/**
 * The largest deterministic candidate window a request-time Turso vector fallback may score.
 * The current track corpus fits inside it; once it does not, Sonar is the complete-corpus path
 * and the fallback remains bounded rather than turning one unavailable sidecar into an unbounded
 * Worker/database request.
 */
export const VECTOR_FALLBACK_CANDIDATE_LIMIT = 50_000;

/** A fallback may occupy a request for at most this long. libSQL cannot cancel the remote work. */
export const VECTOR_FALLBACK_DEADLINE_MS = 12_000;

const CANDIDATE_BOUND_MARKER = "/* vector-fallback-candidate-bound */";

export const VECTOR_FALLBACK_OPERATION_IDS = [
  "sonar.fallback.artists",
  "sonar.fallback.log",
  "sonar.fallback.mix",
  "sonar.fallback.recommendations-catalogue",
  "sonar.fallback.recommendations-findings",
  "sonar.fallback.search",
  "sonar.fallback.track",
] as const;

export type VectorFallbackOperationId = (typeof VECTOR_FALLBACK_OPERATION_IDS)[number];

type VectorFallbackOptions = {
  candidateLimit?: number;
  deadlineMs?: number;
};

/**
 * The SQL fragment every fallback uses to cap the rows entering `vector_distance_cos`.
 * The numeric literal is generated only from a checked integer, so it is safe to interpolate and
 * leaves positional bind order unchanged in the surrounding query.
 */
export function vectorFallbackCandidateLimitSql(limit = VECTOR_FALLBACK_CANDIDATE_LIMIT): string {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("vector fallback candidate limit must be a positive safe integer");
  }

  return `limit ${limit} ${CANDIDATE_BOUND_MARKER}`;
}

/** Resolve work or stop the caller waiting at the fallback deadline. */
export async function raceWithDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  const timeout = new Promise<never>((_resolve, reject) => {
    const signal = AbortSignal.timeout(ms);

    signal.addEventListener("abort", () => reject(new Error(`${label} timed out after ${ms}ms`)), {
      once: true,
    });
  });

  return Promise.race([work, timeout]);
}

/**
 * Execute one Sonar database fallback under the shared cost contract.
 *
 * The marker check makes the candidate cap fail closed at the call boundary: a new or edited
 * fallback cannot accidentally retain a whole-corpus vector scan while still inheriting the
 * deadline and telemetry. `databaseOperationStatement` attaches the existing stable
 * `operation_id`/`access_class` vocabulary without changing the SQL sent to libSQL.
 */
export async function executeVectorFallback(
  db: Pick<Client, "execute">,
  operationId: VectorFallbackOperationId,
  statement: InStatement,
  options: VectorFallbackOptions = {},
): Promise<ResultSet> {
  const candidateLimit = options.candidateLimit ?? VECTOR_FALLBACK_CANDIDATE_LIMIT;
  const deadlineMs = options.deadlineMs ?? VECTOR_FALLBACK_DEADLINE_MS;
  const sql = typeof statement === "string" ? statement : statement.sql;
  const expectedBound = vectorFallbackCandidateLimitSql(candidateLimit);

  if (!sql.includes(expectedBound)) {
    throw new Error(`${operationId} is missing the ${candidateLimit}-row candidate bound`);
  }

  return raceWithDeadline(
    db.execute(
      databaseOperationStatement(statement, {
        accessClass: "heavy-read",
        operationId,
      }),
    ),
    deadlineMs,
    operationId,
  );
}
