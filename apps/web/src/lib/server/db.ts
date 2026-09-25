import {
  createClient,
  type Client,
  type InArgs,
  type InStatement,
  type Row,
  type Transaction,
  type TransactionMode,
} from "@libsql/client/web";
import { startInactiveSpan, startSpan, type Span } from "@sentry/core";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "../../db/schema";
import {
  PRIMARY_DB_CONCURRENCY,
  TELEMETRY_DB_CONCURRENCY,
  workerDatabaseConcurrencyGate,
  type WorkerDatabaseConcurrencyLease,
} from "../database-concurrency";
import { SENTRY_RELEASE } from "../sentry-config";
import {
  canonicalSqlShape,
  classifyDatabaseAccess,
  classifyDatabaseOperationAccess,
  normalizeDatabaseOperationId,
  normalizeDatabaseRelease,
  type DatabaseAccessClass,
  type DatabaseOutcome,
} from "./database-observability";
import {
  enterDatabaseRequestOperation,
  getRequestScopedDatabaseClient,
  type DatabaseRequestOperationLease,
} from "./database-request-scope";
import { readEnvs, readOptionalEnv } from "./env";

const DATABASE_OPERATION_METADATA = Symbol("fluncle.database-operation");

export type DatabaseOperationMetadata = {
  accessClass?: DatabaseAccessClass;
  operationId: string;
};

type StatementWithDatabaseOperation = Exclude<InStatement, string> & {
  [DATABASE_OPERATION_METADATA]?: DatabaseOperationMetadata;
};

export function databaseOperationStatement(
  statement: InStatement,
  metadata: DatabaseOperationMetadata,
): InStatement {
  if (typeof statement === "string") {
    const observedStatement: StatementWithDatabaseOperation = { sql: statement };
    observedStatement[DATABASE_OPERATION_METADATA] = metadata;
    return observedStatement;
  }

  const observedStatement: StatementWithDatabaseOperation = { ...statement };
  observedStatement[DATABASE_OPERATION_METADATA] = metadata;
  return observedStatement;
}

function statementSql(statement: InStatement): string {
  return typeof statement === "string" ? statement : statement.sql;
}

function statementMetadata(statement: InStatement): DatabaseOperationMetadata | undefined {
  return typeof statement === "string"
    ? undefined
    : (statement as StatementWithDatabaseOperation)[DATABASE_OPERATION_METADATA];
}

function batchStatementSql(statement: InStatement | [string, InArgs?]): string {
  return Array.isArray(statement) ? statement[0] : statementSql(statement);
}

function accessClassForStatement(statement: InStatement): DatabaseAccessClass {
  const sql = statementSql(statement);
  const inferred = classifyDatabaseOperationAccess(sql);
  const requested = statementMetadata(statement)?.accessClass;

  return inferred === "read" && requested === "heavy-read" ? requested : inferred;
}

function operationIdForStatement(statement: InStatement, accessClass: DatabaseAccessClass): string {
  const sqlShape = canonicalSqlShape(statementSql(statement));
  return normalizeDatabaseOperationId(
    statementMetadata(statement)?.operationId,
    sqlShape,
    accessClass,
  );
}

function spanStatement(accessClass: DatabaseAccessClass, operationId: string): string {
  const verb = accessClass === "write" ? "WRITE" : "SELECT";
  return `${verb} [${operationId}]`;
}

function baseSpanAttributes(
  accessClass: DatabaseAccessClass,
  operationId: string,
  batchCount: number,
): Record<string, string | number> {
  return {
    "db.statement": spanStatement(accessClass, operationId),
    "db.system": "sqlite",
    "fluncle.access_class": accessClass,
    "fluncle.aggregate_in_flight_max": 0,
    "fluncle.attempt_count": 1,
    "fluncle.batch_count": batchCount,
    "fluncle.duration_ms": 0,
    "fluncle.operation_id": operationId,
    "fluncle.outcome": "success",
    "fluncle.queue_wait_ms": 0,
    "fluncle.release": normalizeDatabaseRelease(SENTRY_RELEASE),
    "fluncle.request_in_flight_max": 0,
  };
}

function recordAdmission(span: Span | undefined, lease: WorkerDatabaseConcurrencyLease): void {
  span?.setAttribute("fluncle.queue_wait_ms", lease.queueWaitMs);
}

function finishSpan(
  span: Span | undefined,
  startedAt: number,
  outcome: DatabaseOutcome,
  requestOperation: DatabaseRequestOperationLease,
): void {
  span?.setAttribute(
    "fluncle.aggregate_in_flight_max",
    workerDatabaseConcurrencyGate.snapshot().aggregateObservedMaximum,
  );
  span?.setAttribute("fluncle.duration_ms", Math.max(0, Date.now() - startedAt));
  span?.setAttribute("fluncle.outcome", outcome);
  span?.setAttribute("fluncle.request_in_flight_max", requestOperation.observedMaximum());
}

export const DB_RETRY_BACKOFF_MS = [50, 150];
export const DB_MAX_RETRIES = DB_RETRY_BACKOFF_MS.length;
const DB_RETRY_JITTER_MS = 50;

const RETRYABLE_GATEWAY_STATUSES = new Set([502, 503, 504, 520, 522, 525, 530]);

const MAX_CAUSE_DEPTH = 3;

function hasNumericStatus(value: unknown): value is { status: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    typeof value.status === "number"
  );
}

function causeOf(value: unknown): unknown {
  return typeof value === "object" && value !== null && "cause" in value ? value.cause : undefined;
}

function isRetryableGatewayError(error: unknown): boolean {
  let current: unknown = error;

  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (hasNumericStatus(current)) {
      return RETRYABLE_GATEWAY_STATUSES.has(current.status);
    }

    current = causeOf(current);

    if (current === undefined) {
      return false;
    }
  }

  return false;
}

function isRetryableRead(sql: string): boolean {
  return classifyDatabaseAccess(sql) === "read";
}

function isRetryableReadBatch(
  stmts: Array<InStatement | [string, InArgs?]>,
  mode: TransactionMode | undefined,
): boolean {
  return (
    mode === "read" &&
    stmts.length > 0 &&
    stmts.every((statement) => isRetryableRead(batchStatementSql(statement)))
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function recordRetries(span: Span | undefined, attempt: number): void {
  if (span) {
    span.setAttribute("fluncle.attempt_count", attempt + 1);

    if (attempt > 0) {
      span.setAttribute("db.retry.attempts", attempt);
    }
  }
}

async function runWithRetry<T>(run: () => Promise<T>, span?: Span): Promise<T> {
  let attempt = 0;

  for (;;) {
    try {
      const result = await run();

      recordRetries(span, attempt);

      return result;
    } catch (error) {
      const backoffMs = DB_RETRY_BACKOFF_MS[attempt];

      if (backoffMs === undefined || !isRetryableGatewayError(error)) {
        recordRetries(span, attempt);

        throw error;
      }

      attempt += 1;

      await delay(backoffMs + Math.random() * DB_RETRY_JITTER_MS);
    }
  }
}

export async function retryRunEventInsert<T>(insert: () => Promise<T>): Promise<T> {
  return runWithRetry(insert);
}

export function readClientProperty(client: Client, property: PropertyKey): unknown {
  switch (property) {
    case "batch":
      return client.batch.bind(client);
    case "close":
      return client.close.bind(client);
    case "closed":
      return client.closed;
    case "constructor":
      return client.constructor;
    case "execute":
      return client.execute.bind(client);
    case "executeMultiple":
      return client.executeMultiple.bind(client);
    case "migrate":
      return client.migrate.bind(client);
    case "protocol":
      return client.protocol;
    case "reconnect":
      return client.reconnect.bind(client);
    case "sync":
      return client.sync.bind(client);
    case "transaction":
      return client.transaction.bind(client);
    default:
      return undefined;
  }
}

function readTransactionProperty(transaction: Transaction, property: PropertyKey): unknown {
  switch (property) {
    case "closed":
      return transaction.closed;
    case "constructor":
      return transaction.constructor;
    default:
      return undefined;
  }
}

function instrumentTransaction(
  transaction: Transaction,
  lease: WorkerDatabaseConcurrencyLease,
  requestOperation: DatabaseRequestOperationLease,
  span: Span,
  startedAt: number,
): Transaction {
  let failed = false;
  let finished = false;

  const finish = (outcome: DatabaseOutcome) => {
    if (finished) {
      return;
    }
    finished = true;
    finishSpan(span, startedAt, outcome, requestOperation);
    requestOperation.release();
    lease.release();
    span.end();
  };

  const fail = (target: Transaction, error: unknown): never => {
    failed = true;

    if (target.closed) {
      finish("failure");
    }
    throw error;
  };

  return new Proxy(transaction, {
    get(target, property) {
      if (property === "execute") {
        return async (statement: InStatement) => {
          try {
            return await target.execute(statement);
          } catch (error) {
            return fail(target, error);
          }
        };
      }
      if (property === "batch") {
        return async (statements: InStatement[]) => {
          try {
            return await target.batch(statements);
          } catch (error) {
            return fail(target, error);
          }
        };
      }
      if (property === "executeMultiple") {
        return async (sql: string) => {
          try {
            return await target.executeMultiple(sql);
          } catch (error) {
            return fail(target, error);
          }
        };
      }
      if (property === "close") {
        return () => {
          try {
            target.close();
            finish(failed ? "failure" : "success");
          } catch (error) {
            finish("failure");
            throw error;
          }
        };
      }
      if (property === "commit" || property === "rollback") {
        return async () => {
          try {
            await target[property]();
            finish(failed ? "failure" : "success");
          } catch (error) {
            return fail(target, error);
          }
        };
      }
      return readTransactionProperty(target, property);
    },
  });
}

function instrument(client: Client): Client {
  return new Proxy(client, {
    get(target, property) {
      if (property === "execute") {
        return (statement: InStatement, args?: InArgs) => {
          const sql = statementSql(statement);
          const accessClass = accessClassForStatement(statement);
          const operationId = operationIdForStatement(statement, accessClass);
          const name = `db.query ${operationId}`;

          return startSpan(
            {
              attributes: baseSpanAttributes(accessClass, operationId, 1),
              name,
              op: "db.query",
            },
            async (span) => {
              const startedAt = Date.now();
              const lease = await workerDatabaseConcurrencyGate.acquire(accessClass);
              const requestOperation = enterDatabaseRequestOperation();
              recordAdmission(span, lease);
              const run = () =>
                args !== undefined && typeof statement === "string"
                  ? target.execute(statement, args)
                  : target.execute(statement);

              try {
                const result = await (isRetryableRead(sql) ? runWithRetry(run, span) : run());
                finishSpan(span, startedAt, "success", requestOperation);
                return result;
              } catch (error) {
                finishSpan(span, startedAt, "failure", requestOperation);
                throw error;
              } finally {
                requestOperation.release();
                lease.release();
              }
            },
          );
        };
      }

      if (property === "batch") {
        return (stmts: Array<InStatement | [string, InArgs?]>, mode?: TransactionMode) => {
          const statementAccess = stmts.map((statement) =>
            Array.isArray(statement)
              ? classifyDatabaseOperationAccess(statement[0])
              : accessClassForStatement(statement),
          );
          const accessClass: DatabaseAccessClass = statementAccess.includes("write")
            ? "write"
            : statementAccess.includes("heavy-read")
              ? "heavy-read"
              : "read";
          const explicitIds = stmts
            .map((statement) =>
              Array.isArray(statement) ? undefined : statementMetadata(statement)?.operationId,
            )
            .filter((candidate): candidate is string => typeof candidate === "string");
          const explicitId =
            explicitIds.length === stmts.length && new Set(explicitIds).size === 1
              ? explicitIds[0]
              : undefined;
          const shape = stmts
            .map((statement) => canonicalSqlShape(batchStatementSql(statement)))
            .join(";");
          const operationId = normalizeDatabaseOperationId(explicitId, shape, accessClass);
          const name = `db.query ${operationId}`;

          return startSpan(
            {
              attributes: {
                "db.batch.size": stmts.length,
                ...baseSpanAttributes(accessClass, operationId, stmts.length),
              },
              name,
              op: "db.query",
            },
            async (span) => {
              const startedAt = Date.now();
              const lease = await workerDatabaseConcurrencyGate.acquire(accessClass);
              const requestOperation = enterDatabaseRequestOperation();
              recordAdmission(span, lease);

              const run = () => target.batch(stmts, mode);

              try {
                const result = await (isRetryableReadBatch(stmts, mode)
                  ? runWithRetry(run, span)
                  : run());
                finishSpan(span, startedAt, "success", requestOperation);
                return result;
              } catch (error) {
                finishSpan(span, startedAt, "failure", requestOperation);
                throw error;
              } finally {
                requestOperation.release();
                lease.release();
              }
            },
          );
        };
      }

      if (property === "transaction") {
        return async (mode?: TransactionMode) => {
          const accessClass: DatabaseAccessClass = mode === "read" ? "read" : "write";
          const operationId = `db.${accessClass}.transaction`;
          const startedAt = Date.now();
          const span = startInactiveSpan({
            attributes: baseSpanAttributes(accessClass, operationId, 1),
            name: `db.query ${operationId}`,
            op: "db.query",
          });
          const lease = await workerDatabaseConcurrencyGate.acquire(accessClass);
          const requestOperation = enterDatabaseRequestOperation();
          recordAdmission(span, lease);

          try {
            const transaction =
              mode === undefined ? await target.transaction() : await target.transaction(mode);
            return instrumentTransaction(transaction, lease, requestOperation, span, startedAt);
          } catch (error) {
            finishSpan(span, startedAt, "failure", requestOperation);
            requestOperation.release();
            lease.release();
            span.end();
            throw error;
          }
        };
      }

      return readClientProperty(target, property);
    },
  });
}

export async function getDb() {
  return getRequestScopedDatabaseClient("primary", async () => {
    const env = await readEnvs(["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"]);

    return instrument(
      createClient({
        authToken: env.TURSO_AUTH_TOKEN,
        concurrency: PRIMARY_DB_CONCURRENCY,
        url: env.TURSO_DATABASE_URL,
      }),
    );
  });
}

export async function getDrizzleDb() {
  const client = await getDb();

  return drizzle(client, { schema });
}

export async function getTelemetryDb(): Promise<Client | undefined> {
  return getRequestScopedDatabaseClient("telemetry", async () => {
    const [url, authToken] = await Promise.all([
      readOptionalEnv("TURSO_TELEMETRY_DATABASE_URL"),
      readOptionalEnv("TURSO_TELEMETRY_AUTH_TOKEN"),
    ]);

    if (!url || !authToken) {
      return undefined;
    }

    return instrument(createClient({ authToken, concurrency: TELEMETRY_DB_CONCURRENCY, url }));
  });
}

export function typedRow<T extends object>(rows: Row[]): T | undefined {
  return rows[0] as T | undefined;
}

export function typedRows<T extends object>(rows: Row[]): T[] {
  return rows as T[];
}
