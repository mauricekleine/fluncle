import {
  createClient,
  type Client,
  type InArgs,
  type InStatement,
  type Row,
  type TransactionMode,
} from "@libsql/client/web";
import { startSpan, type Span } from "@sentry/core";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "../../db/schema";
import { readEnvs } from "./env";

// Every DB query runs inside a Sentry `db.query` span so slow queries surface in
// the Queries insight + the auto "Slow DB Queries" detector (op `db*`, SELECT,
// ≥500ms) — the load-bearing target being the recommendation vector scan, which
// grows with the catalogue and must be MEASURED in prod, not guessed. The span
// nests under the request transaction the Worker's `Sentry.withSentry` already
// opens (server.ts); see docs/error-tracking.md for the tracing posture.
//
// NODE-SAFE IMPORT: `startSpan` comes from `@sentry/core` (env-agnostic), not
// `@sentry/cloudflare` (Worker-oriented), because this module is also imported
// by bun scripts that run in Node and by tests. When no Sentry client is active
// — which is every one of those Node importers, and any dev/test run —
// `startSpan` is a safe passthrough that just runs the callback and returns its
// value, so the instrumentation is invisible there.

// libsql already parameterizes queries to `?` placeholders, so the SQL string IS
// the normalized (grouped) query — safe as a span name. Capped so an oversized
// statement can't bloat the span name.
const MAX_SPAN_NAME_LENGTH = 200;

function spanName(sql: string): string {
  const collapsed = sql.replace(/\s+/g, " ").trim();

  return collapsed.length > MAX_SPAN_NAME_LENGTH
    ? `${collapsed.slice(0, MAX_SPAN_NAME_LENGTH - 1)}…`
    : collapsed;
}

// The SQL lives in the first `execute` argument, in either call form:
// `execute("…")`, `execute("…", args)`, or `execute({ sql, args })`.
function statementSql(statement: InStatement): string {
  return typeof statement === "string" ? statement : statement.sql;
}

// ── Transient-gateway retry ────────────────────────────────────────────────
//
// Turso is reached over HTTP and its gateway occasionally answers a bare 5xx
// that has nothing to do with the query (observed in prod as a single
// `LibsqlError: SERVER_ERROR: Server returned HTTP status 502` that took a
// crawler's `/artist/<slug>` render to the root error boundary). The libsql
// HTTP transport has NO retry of its own, and one page render fans out to
// several independent round trips, so a bare client turns every transient
// gateway blip into a rendered error page.
//
// THE SAFETY CONTRACT: reads retry, writes NEVER do. A 5xx on a write is
// ambiguous — the write may well have been applied before the gateway gave
// up — so re-running it risks double-applying it. Only the `execute` path
// retries, and only for a statement the classifier is CONFIDENT is a read;
// `batch` never retries (a batch is one unit and can contain writes) and
// `transaction` is untouched.

// 2 retries = 3 attempts total. The backoff array's length IS the retry cap,
// so tuning is one edit. Kept short: an `/artist/*` render fires several of
// these concurrently and the Worker has a wall-clock budget.
export const DB_RETRY_BACKOFF_MS = [50, 150];
export const DB_MAX_RETRIES = DB_RETRY_BACKOFF_MS.length;
const DB_RETRY_JITTER_MS = 50;

// Only a transient gateway status. 4xx is our fault and will fail identically.
// 524 is EXCLUDED ON PURPOSE: it means the gateway already timed out waiting on
// this query, so re-running it just doubles the load for a near-certain second
// timeout. Do not "fix" that omission.
const RETRYABLE_GATEWAY_STATUSES = new Set([502, 503, 504]);

// `mapHranaError` wraps the hrana `HttpServerError` (which carries the numeric
// `status`) as the `LibsqlError`'s `cause`, and a closed stream can wrap it one
// level deeper still — so walk a bounded cause chain looking for a status.
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

// Leading whitespace and leading SQL comments, so a commented statement is
// still classified by its actual first keyword.
const LEADING_NOISE = /^(?:\s|--[^\n]*|\/\*[\s\S]*?\*\/)+/;
const WRITE_VERB = /\b(?:insert|update|delete|replace)\b/;

// Classifies off the SQL string, because that is all the chokepoint has.
//
// A read is: `select …`, OR `with …` that contains no write verb — SQLite
// allows `WITH … INSERT/UPDATE/DELETE`, which is exactly why the second half
// of that condition exists. Everything else (`pragma`, `begin`, `insert`,
// `update`, `delete`, `replace`, anything unrecognized) is NOT retryable.
//
// THE FAILURE DIRECTION IS ASYMMETRIC: a false negative — declining to retry
// something that was in fact a read — is harmless, it is exactly today's
// behaviour. A false positive — retrying a write — is a correctness bug that
// can double-apply it. So when this is unsure, it does not retry.
function isRetryableRead(sql: string): boolean {
  const normalized = sql.replace(LEADING_NOISE, "").toLowerCase();

  if (/^select\b/.test(normalized)) {
    return true;
  }

  return /^with\b/.test(normalized) && !WRITE_VERB.test(normalized);
}

// Created inside the request path only — a module-level timer or promise chain
// wedges Worker isolates.
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function recordRetries(span: Span, attempt: number): void {
  if (attempt > 0) {
    span.setAttribute("db.retry.attempts", attempt);
  }
}

// Runs inside the caller's `db.query` span so one logical query stays ONE span
// (no phantom spans; the Slow DB Queries detector keeps working).
async function runWithRetry<T>(run: () => Promise<T>, span: Span): Promise<T> {
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

// One chokepoint: wrap the created client in a Proxy that opens a `db.query`
// span around `execute` and `batch` (every query path in the app) and forwards
// everything else — `transaction`, `close`, `sync`, drizzle's own calls —
// straight through. The wrapped methods return EXACTLY what the underlying
// client returns, so the instrumentation is transparent to every caller.
//
// The libsql client is a class instance backed by private (`#`) fields, so each
// method must run with `this` bound to the real client: the span wrappers call
// `client.<method>(...)` in method-call form (which keeps `this`), and the
// pass-through branch binds any forwarded function back to the real client.
function instrument(client: Client): Client {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "execute") {
        return (statement: InStatement, args?: InArgs) => {
          const sql = statementSql(statement);
          const name = spanName(sql);

          return startSpan(
            {
              attributes: { "db.statement": name, "db.system": "sqlite" },
              name,
              op: "db.query",
            },
            (span) => {
              const run = () =>
                args !== undefined && typeof statement === "string"
                  ? target.execute(statement, args)
                  : target.execute(statement);

              // A write (or anything the classifier can't vouch for) runs
              // exactly once, exactly as before.
              return isRetryableRead(sql) ? runWithRetry(run, span) : run();
            },
          );
        };
      }

      if (property === "batch") {
        return (stmts: Array<InStatement | [string, InArgs?]>, mode?: TransactionMode) => {
          const name = `db.batch (${stmts.length})`;

          return startSpan(
            {
              attributes: {
                "db.batch.size": stmts.length,
                "db.statement": name,
                "db.system": "sqlite",
              },
              name,
              op: "db.query",
            },
            () => target.batch(stmts, mode),
          );
        };
      }

      const value: unknown = Reflect.get(target, property, receiver);

      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

export async function getDb() {
  const env = await readEnvs(["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"]);

  return instrument(
    createClient({
      authToken: env.TURSO_AUTH_TOKEN,
      url: env.TURSO_DATABASE_URL,
    }),
  );
}

export async function getDrizzleDb() {
  const client = await getDb();

  return drizzle(client, { schema });
}

export function typedRow<T extends object>(rows: Row[]): T | undefined {
  return rows[0] as T | undefined;
}

export function typedRows<T extends object>(rows: Row[]): T[] {
  return rows as T[];
}
