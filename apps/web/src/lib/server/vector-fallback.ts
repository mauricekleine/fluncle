import { type Client, type InStatement, type ResultSet } from "@libsql/client/web";
import { VECTOR_FALLBACK_DEADLINE_MS } from "../vector-budget";
import { databaseOperationStatement } from "./db";

export { VECTOR_FALLBACK_DEADLINE_MS };

export const VECTOR_FALLBACK_CANDIDATE_LIMIT = 50_000;

const CANDIDATE_BOUND_MARKER = "/* vector-fallback-candidate-bound */";

export const VECTOR_FALLBACK_OPERATION_IDS = [
  "sonar.fallback.artists",
  "sonar.fallback.log",
  "sonar.fallback.mix",
  "sonar.fallback.recommendations-catalogue",
  "sonar.fallback.recommendations-findings",
  "sonar.fallback.search",
  "sonar.fallback.style",
  "sonar.fallback.track",
] as const;

export type VectorFallbackOperationId = (typeof VECTOR_FALLBACK_OPERATION_IDS)[number];

type VectorFallbackOptions = {
  candidateLimit?: number;
  deadlineMs?: number;
};

export function vectorFallbackCandidateLimitSql(limit = VECTOR_FALLBACK_CANDIDATE_LIMIT): string {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("vector fallback candidate limit must be a positive safe integer");
  }

  return `limit ${limit} ${CANDIDATE_BOUND_MARKER}`;
}

export class VectorDeadlineExpired extends Error {
  readonly label: string;
  readonly deadlineMs: number;

  constructor(label: string, deadlineMs: number) {
    super(`${label} timed out after ${deadlineMs}ms`);
    this.name = "VectorDeadlineExpired";
    this.label = label;
    this.deadlineMs = deadlineMs;
  }
}

export function isVectorDeadlineExpired(error: unknown): error is VectorDeadlineExpired {
  return error instanceof VectorDeadlineExpired;
}

export async function raceWithDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  const timeout = new Promise<never>((_resolve, reject) => {
    const signal = AbortSignal.timeout(ms);

    signal.addEventListener("abort", () => reject(new VectorDeadlineExpired(label, ms)), {
      once: true,
    });
  });

  return Promise.race([work, timeout]);
}

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
