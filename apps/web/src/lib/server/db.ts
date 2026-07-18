import {
  createClient,
  type Client,
  type InArgs,
  type InStatement,
  type Row,
  type TransactionMode,
} from "@libsql/client/web";
import { startSpan } from "@sentry/core";
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
          const sql = spanName(statementSql(statement));

          return startSpan(
            {
              attributes: { "db.statement": sql, "db.system": "sqlite" },
              name: sql,
              op: "db.query",
            },
            () =>
              args !== undefined && typeof statement === "string"
                ? target.execute(statement, args)
                : target.execute(statement),
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
