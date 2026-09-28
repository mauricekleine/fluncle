#!/usr/bin/env bun

import { type Client, createClient } from "@libsql/client/web";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import {
  DATABASE_ADMISSION_ENFORCED_KEY,
  DATABASE_ADMISSION_STORE_EPOCH_KEY,
  DATABASE_ADMISSION_STORE_KEY,
  type DatabaseAdmissionStoreRoute,
  parseDatabaseAdmissionStoreRoute,
  parseStoreEpochMarker,
} from "../src/lib/server/database-admission";

export type StoreCommand = "cutover" | "finalize" | "rollback" | "status";

export type StoreControlState = Readonly<{ epoch: number; open: boolean }>;

export type StoreSnapshot = Readonly<{
  control: StoreControlState | null;
  enforced: boolean;
  maxEpoch: number;
  primaryLive: number;
  rawEpochMarker: string | null;
  rawRoute: string | null;
  route: DatabaseAdmissionStoreRoute | null;
  telemetryLive: number;
}>;

export type StorePlan =
  | Readonly<{ kind: "refuse"; reason: string }>
  | Readonly<{ epoch: number | null; kind: "set"; value: string }>;

export function parseStoreCommand(args: readonly string[]): StoreCommand {
  const [command = "status", ...rest] = args;
  if (rest.length > 0) {
    throw new Error("database-admission-store takes exactly one command");
  }
  if (
    command === "status" ||
    command === "cutover" ||
    command === "rollback" ||
    command === "finalize"
  ) {
    return command;
  }
  throw new Error(`unknown command ${command}; use status, cutover, rollback, or finalize`);
}

function nextEpoch(snapshot: StoreSnapshot): number {
  return Math.max(snapshot.route?.epoch ?? 0, snapshot.control?.epoch ?? 0, snapshot.maxEpoch) + 1;
}

export function planStoreChange(command: StoreCommand, snapshot: StoreSnapshot): StorePlan {
  if (snapshot.route === null) {
    return {
      kind: "refuse",
      reason: `the stored route ${snapshot.rawRoute ?? "(absent)"} is not recognized; repair it first`,
    };
  }
  if (command === "cutover") {
    if (snapshot.route.store === "telemetry") {
      return { kind: "refuse", reason: "admission is already routed to the telemetry store" };
    }
    const epoch = nextEpoch(snapshot);
    return { epoch, kind: "set", value: `telemetry:${epoch}` };
  }
  if (command === "rollback") {
    if (snapshot.route.store === "primary") {
      return { kind: "refuse", reason: "admission is already routed to the primary store" };
    }
    const epoch = nextEpoch(snapshot);
    return { epoch, kind: "set", value: `primary:${epoch}` };
  }
  if (command === "finalize") {
    const epoch = snapshot.route.epoch;
    if (snapshot.route.store !== "primary" || epoch === null) {
      return {
        kind: "refuse",
        reason: "finalize applies only to a primary:<epoch> rollback route",
      };
    }
    if (snapshot.control !== null && (snapshot.control.open || snapshot.control.epoch < epoch)) {
      return {
        kind: "refuse",
        reason: `telemetry is not closed at epoch ${epoch} yet; wait for one primary acquire to close it`,
      };
    }
    if (snapshot.telemetryLive > 0) {
      return {
        kind: "refuse",
        reason: `${snapshot.telemetryLive} telemetry lease(s) are still live; wait for them to drain`,
      };
    }
    return { epoch: null, kind: "set", value: "primary" };
  }
  return { kind: "refuse", reason: "status never writes" };
}

function count(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : 0;
}

export type StoreRouteVersion = Readonly<{ epochMarker: string | null; route: string | null }>;

export async function compareAndSetStoreRoute(
  primary: Pick<Client, "batch">,
  expected: StoreRouteVersion,
  value: string,
  epoch: number | null,
): Promise<boolean> {
  const marker = expected.epochMarker ?? "";
  const statements = [
    {
      args: [
        value,
        DATABASE_ADMISSION_STORE_KEY,
        expected.route,
        DATABASE_ADMISSION_STORE_EPOCH_KEY,
        marker,
      ],
      sql: `update settings set value = ?
            where key = ? and value = ?
              and coalesce((select value from settings where key = ?), '') = ?`,
    },
    {
      args: [
        DATABASE_ADMISSION_STORE_KEY,
        value,
        expected.route,
        DATABASE_ADMISSION_STORE_KEY,
        DATABASE_ADMISSION_STORE_EPOCH_KEY,
        marker,
      ],
      sql: `insert into settings (key, value)
            select ?, ? where ? is null
              and not exists (select 1 from settings where key = ?)
              and coalesce((select value from settings where key = ?), '') = ?`,
    },
    ...(epoch === null
      ? []
      : [
          {
            args: [
              DATABASE_ADMISSION_STORE_EPOCH_KEY,
              String(epoch),
              DATABASE_ADMISSION_STORE_KEY,
              value,
            ],
            sql: `insert into settings (key, value)
                  select ?, ? where (select value from settings where key = ?) = ?
                  on conflict(key) do update set value = excluded.value`,
          },
        ]),
  ];
  const [updated, inserted] = await primary.batch(statements, "write");
  return (updated?.rowsAffected ?? 0) + (inserted?.rowsAffected ?? 0) === 1;
}

async function readSnapshot(primary: Client, telemetry: Client): Promise<StoreSnapshot> {
  const [primaryState, telemetryState] = await Promise.all([
    primary.execute({
      args: [
        DATABASE_ADMISSION_STORE_KEY,
        DATABASE_ADMISSION_ENFORCED_KEY,
        DATABASE_ADMISSION_STORE_EPOCH_KEY,
      ],
      sql: `select
              (select value from settings where key = ?) as route,
              (select value from settings where key = ?) as enforced,
              (select value from settings where key = ?) as epoch_marker,
              (select count(*) from database_admission_contenders
                where state = 'active'
                  and lease_expires_at_ms > cast(unixepoch('subsec') * 1000 as integer)) as live`,
    }),
    telemetry.execute(
      `select
         (select epoch from database_admission_control where id = 1) as epoch,
         (select store_open from database_admission_control where id = 1) as store_open,
         (select count(*) from database_admission_contenders
           where state = 'active'
             and lease_expires_at_ms > cast(unixepoch('subsec') * 1000 as integer)) as live`,
    ),
  ]);
  const primaryRow = primaryState.rows[0];
  const telemetryRow = telemetryState.rows[0];
  const rawRoute = typeof primaryRow?.route === "string" ? primaryRow.route : null;
  const rawEpochMarker =
    typeof primaryRow?.epoch_marker === "string" ? primaryRow.epoch_marker : null;
  const epoch = telemetryRow?.epoch;
  return {
    control:
      epoch === null || epoch === undefined
        ? null
        : { epoch: count(epoch), open: count(telemetryRow?.store_open) === 1 },
    enforced: primaryRow?.enforced === "true",
    maxEpoch: parseStoreEpochMarker(rawEpochMarker),
    primaryLive: count(primaryRow?.live),
    rawEpochMarker,
    rawRoute,
    route: parseDatabaseAdmissionStoreRoute(rawRoute ?? undefined),
    telemetryLive: count(telemetryRow?.live),
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function main(): Promise<void> {
  const command = parseStoreCommand(process.argv.slice(2));
  const primary = createClient({
    authToken: requiredEnv("TURSO_AUTH_TOKEN"),
    concurrency: REMOTE_DB_CONCURRENCY,
    url: requiredEnv("TURSO_DATABASE_URL"),
  });
  const telemetry = createClient({
    authToken: requiredEnv("TURSO_TELEMETRY_AUTH_TOKEN"),
    concurrency: REMOTE_DB_CONCURRENCY,
    url: requiredEnv("TURSO_TELEMETRY_DATABASE_URL"),
  });
  const before = await readSnapshot(primary, telemetry);
  if (command === "status") {
    console.log(JSON.stringify(before, null, 2));
    return;
  }
  const plan = planStoreChange(command, before);
  if (plan.kind === "refuse") {
    console.error(`database-admission-store ${command}: ${plan.reason}`);
    process.exitCode = 1;
    return;
  }
  if (
    !(await compareAndSetStoreRoute(
      primary,
      { epochMarker: before.rawEpochMarker, route: before.rawRoute },
      plan.value,
      plan.epoch,
    ))
  ) {
    console.error(
      `database-admission-store ${command}: the route changed since it was read; re-run status and decide again`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    JSON.stringify(
      { after: await readSnapshot(primary, telemetry), before, set: plan.value },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "database-admission-store failed");
    process.exit(1);
  });
}
