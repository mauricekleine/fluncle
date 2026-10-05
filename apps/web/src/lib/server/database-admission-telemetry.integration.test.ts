import { DatabaseAdmissionResponseSchema } from "@fluncle/contracts/orpc";
import { type Client, type InStatement, type ResultSet } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  coordinateDatabaseAdmissionAcross,
  coordinateDatabaseAdmissionFor,
  DATABASE_ADMISSION_HEALTH_STALE_MS,
  DATABASE_ADMISSION_MAX_RETRY_AFTER_MS,
  DATABASE_ADMISSION_RENEWED_LEASE_MS,
  DATABASE_ADMISSION_STORE_EPOCH_KEY,
  DATABASE_ADMISSION_STORE_KEY,
  DATABASE_WRITE_PROBE_KEY,
  DATABASE_WRITE_PROBE_SLOW_MS,
  type DatabaseAdmissionAction,
  type DatabaseAdmissionStores,
  parseDatabaseAdmissionStoreRoute,
  recordDatabaseWriteProbeFor,
  writeProbeReasonFromSamples,
} from "./database-admission";
import { createIntegrationDb } from "./integration-db";
import { createTelemetryIntegrationDb } from "./telemetry-integration-db";

type AdmissionClient = Pick<Client, "batch" | "execute">;

let primary: Client;
let telemetry: Client;
let nowMs: number;
let fixtureDirectory: string;

beforeEach(async () => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), "fluncle-admission-telemetry-"));
  primary = await createIntegrationDb({ url: `file:${join(fixtureDirectory, "primary.db")}` });
  telemetry = await createTelemetryIntegrationDb();
  nowMs = 10_000;
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  await setSetting("database_admission_enforced", "true");
});

afterEach(() => {
  primary.close();
  telemetry.close();
  rmSync(fixtureDirectory, { force: true, recursive: true });
});

async function setSetting(key: string, value: string): Promise<void> {
  await primary.execute({
    args: [key, value],
    sql: `insert into settings (key, value) values (?, ?)
          on conflict(key) do update set value = excluded.value`,
  });
}

async function setRoute(value: string): Promise<void> {
  await setSetting(DATABASE_ADMISSION_STORE_KEY, value);
  const epoch = /:(\d+)$/.exec(value)?.[1];
  if (epoch !== undefined) {
    await primary.execute({
      args: [DATABASE_ADMISSION_STORE_EPOCH_KEY, epoch],
      sql: `insert into settings (key, value) values (?, ?)
            on conflict(key) do update set value = max(cast(value as integer), cast(excluded.value as integer))`,
    });
  }
}

function statementSql(statement: InStatement | [string, unknown?]): string {
  const sql = Array.isArray(statement)
    ? statement[0]
    : typeof statement === "string"
      ? statement
      : statement.sql;
  return sql.trim().toLowerCase();
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function stalledWrites(client: Client): AdmissionClient & { writes: string[] } {
  const writes: string[] = [];
  return {
    batch: (statements, mode) => {
      if (mode === "read") {
        return client.batch(statements, mode);
      }
      writes.push(statements.map((statement) => statementSql(statement)).join(";"));
      return never<ResultSet[]>();
    },
    execute: ((statement: InStatement) => {
      const sql = statementSql(statement);
      if (sql.startsWith("select")) {
        return client.execute(statement);
      }
      writes.push(sql);
      return never<ResultSet>();
    }) as Client["execute"],
    writes,
  };
}

function stalledEverything(): AdmissionClient {
  return {
    batch: () => never<ResultSet[]>(),
    execute: (() => never<ResultSet>()) as Client["execute"],
  };
}

function staleRoute(client: Client, route: string): AdmissionClient {
  return {
    batch: (statements, mode) => client.batch(statements, mode),
    execute: ((statement: InStatement) => {
      if (statementSql(statement).startsWith("select key, value from settings where key in")) {
        return Promise.resolve({
          columnTypes: [],
          columns: ["key", "value"],
          lastInsertRowid: undefined,
          rows: [
            { key: "database_admission_enforced", value: "true" },
            { key: DATABASE_ADMISSION_STORE_KEY, value: route },
          ],
          rowsAffected: 0,
          toJSON: () => ({}),
        } as unknown as ResultSet);
      }
      return client.execute(statement);
    }) as Client["execute"],
  };
}

function stores(overrides: Partial<DatabaseAdmissionStores> = {}): DatabaseAdmissionStores {
  return { primary, telemetry, ...overrides };
}

function coordinate(
  owner: string,
  runId: string,
  action: DatabaseAdmissionAction = "acquire",
  fencingToken?: number,
  target: DatabaseAdmissionStores = stores(),
) {
  return coordinateDatabaseAdmissionAcross(
    target,
    { action, fencingToken, owner, protocolVersion: 2, runId },
    { monotonicNow: () => 0, primaryReadTimeoutMs: 50, serverNowMs: nowMs },
  );
}

async function liveLeases(client: Client, lane: "heavy-read" | "write"): Promise<number> {
  const result = await client.execute({
    args: [lane, nowMs],
    sql: `select count(*) as n from database_admission_contenders
          where lane = ? and state = 'active' and lease_expires_at_ms > ?`,
  });
  return Number(result.rows[0]?.n ?? 0);
}

async function contenderCount(client: Client): Promise<number> {
  const result = await client.execute(`select count(*) as n from database_admission_contenders`);
  return Number(result.rows[0]?.n ?? 0);
}

async function control(): Promise<{ epoch: number; open: number } | undefined> {
  const result = await telemetry.execute(
    `select epoch, store_open from database_admission_control where id = 1`,
  );
  const row = result.rows[0];
  return row === undefined ? undefined : { epoch: Number(row.epoch), open: Number(row.store_open) };
}

async function seedWriteProbes(outcomes: readonly string[], atMs: number): Promise<void> {
  for (const [index, outcome] of outcomes.entries()) {
    await telemetry.execute({
      args: [`probe-${atMs}-${index}`, atMs + index, outcome],
      sql: `insert into database_write_probes (id, observed_at_ms, latency_ms, outcome)
            values (?, ?, null, ?)`,
    });
  }
}

describe("the telemetry-store admission route", () => {
  it("parses only the legacy value and epoch-stamped routes", () => {
    expect(parseDatabaseAdmissionStoreRoute(undefined)).toEqual({ epoch: null, store: "primary" });
    expect(parseDatabaseAdmissionStoreRoute("primary")).toEqual({ epoch: null, store: "primary" });
    expect(parseDatabaseAdmissionStoreRoute("telemetry:3")).toEqual({
      epoch: 3,
      store: "telemetry",
    });
    expect(parseDatabaseAdmissionStoreRoute("primary:4")).toEqual({ epoch: 4, store: "primary" });
    for (const invalid of ["telemetry", "telemetry:0", "telemetry:-1", "primaryx", "TELEMETRY:1"]) {
      expect(parseDatabaseAdmissionStoreRoute(invalid)).toBeNull();
    }
  });

  it("fails closed on an unrecognized store setting", async () => {
    await setRoute("telemetry");
    await expect(coordinate("fluncle-enrich", "typo")).rejects.toThrow(/not a recognized route/);
    expect(await contenderCount(primary)).toBe(0);
  });

  it("fails closed when routed to a telemetry store the Worker cannot reach", async () => {
    await setRoute("telemetry:1");
    await expect(
      coordinate("fluncle-enrich", "no-store", "acquire", undefined, { primary }),
    ).rejects.toThrow(/telemetry store, which is not configured/);
    expect(await contenderCount(primary)).toBe(0);
  });

  it("fails closed when a rollback cannot confirm the telemetry handoff", async () => {
    await setRoute("primary:2");
    await expect(
      coordinate("fluncle-enrich", "no-handoff", "acquire", undefined, { primary }),
    ).rejects.toThrow(/needs the telemetry store to confirm the handoff/);
    expect(await contenderCount(primary)).toBe(0);
  });

  it("grants, renews, and releases entirely in telemetry without writing the primary", async () => {
    await setRoute("telemetry:1");
    const guarded = stalledWrites(primary);
    const target = stores({ primary: guarded });

    const acquired = await coordinate("fluncle-enrich", "run-a", "acquire", undefined, target);
    expect(DatabaseAdmissionResponseSchema.parse(acquired)).toMatchObject({
      activeConflictCount: null,
      aheadCount: null,
      enforced: true,
      outcome: "acquired",
    });
    expect(await control()).toEqual({ epoch: 1, open: 1 });
    expect(await coordinate("fluncle-note", "waiter", "acquire", undefined, target)).toMatchObject({
      activeConflictCount: 1,
      aheadCount: 0,
      outcome: "queued",
    });
    expect(await coordinate("fluncle-note", "waiter", "cancel", undefined, target)).toMatchObject({
      activeConflictCount: null,
      aheadCount: null,
      outcome: "cancelled",
    });

    nowMs += 30_000;
    const renewed = await coordinate(
      "fluncle-enrich",
      "run-a",
      "heartbeat",
      acquired.fencingToken ?? undefined,
      target,
    );
    expect(renewed).toMatchObject({
      leaseExpiresAtMs: nowMs + DATABASE_ADMISSION_RENEWED_LEASE_MS,
      outcome: "acquired",
    });

    const released = await coordinate(
      "fluncle-enrich",
      "run-a",
      "release",
      acquired.fencingToken ?? undefined,
      target,
    );
    expect(released).toMatchObject({
      activeConflictCount: null,
      aheadCount: null,
      outcome: "released",
    });
    expect(guarded.writes).toEqual([]);
    expect(await contenderCount(primary)).toBe(0);
    expect(await contenderCount(telemetry)).toBe(0);
  });

  it("keeps renewing and releasing a telemetry lease while the primary is completely stalled", async () => {
    await setRoute("telemetry:1");
    const acquired = await coordinate("fluncle-enrich", "held");
    expect(acquired.outcome).toBe("acquired");

    const stalled = stores({ primary: stalledEverything() });
    nowMs += 30_000;
    expect(
      (
        await coordinate(
          "fluncle-enrich",
          "held",
          "heartbeat",
          acquired.fencingToken ?? undefined,
          stalled,
        )
      ).outcome,
    ).toBe("acquired");
    expect(
      (
        await coordinate(
          "fluncle-enrich",
          "held",
          "release",
          acquired.fencingToken ?? undefined,
          stalled,
        )
      ).outcome,
    ).toBe("released");
  });

  it("answers a new acquire during a primary read stall with a bounded yield and no write", async () => {
    await setRoute("telemetry:1");
    const result = await coordinate(
      "fluncle-enrich",
      "blocked",
      "acquire",
      undefined,
      stores({ primary: stalledEverything() }),
    );
    expect(result).toMatchObject({
      activeConflictCount: null,
      aheadCount: null,
      enforced: true,
      outcome: "queued",
      yieldReason: "direct-read-latency",
    });
    expect(await contenderCount(telemetry)).toBe(0);
  });

  it("yields an acquire when the primary settings read throws without granting a lease", async () => {
    await setRoute("telemetry:1");
    const failedPrimary = {
      batch: primary.batch.bind(primary),
      execute: vi.fn().mockRejectedValue(new Error("primary settings read failed")),
    };
    const result = await coordinate(
      "fluncle-enrich",
      "settings-error",
      "acquire",
      undefined,
      stores({ primary: failedPrimary }),
    );

    expect(result).toMatchObject({
      activeConflictCount: null,
      aheadCount: null,
      enforced: true,
      outcome: "queued",
      yieldReason: "direct-read-latency",
    });
    expect(failedPrimary.execute).toHaveBeenCalledTimes(1);
    expect(await contenderCount(primary)).toBe(0);
    expect(await contenderCount(telemetry)).toBe(0);
  });

  it("keeps a settled enforcement-off settings read in shadow mode", async () => {
    await setRoute("telemetry:1");
    await setSetting("database_admission_enforced", "false");

    expect(await coordinate("fluncle-enrich", "settings-off")).toMatchObject({
      enforced: false,
      outcome: "shadow-acquire",
    });
    expect(await contenderCount(telemetry)).toBe(0);
  });

  it("keeps mutual exclusion, FIFO, and idempotent acquire in the telemetry store", async () => {
    await setRoute("telemetry:1");
    const first = await coordinate("fluncle-enrich", "first");
    nowMs += 1;
    const second = await coordinate("fluncle-note", "second");
    nowMs += 1;
    const third = await coordinate("fluncle-crawl", "third");
    expect([first.outcome, second.outcome, third.outcome]).toEqual([
      "acquired",
      "queued",
      "queued",
    ]);
    expect(await coordinate("fluncle-enrich", "first")).toMatchObject({
      fencingToken: first.fencingToken,
      outcome: "acquired",
    });

    await coordinate("fluncle-enrich", "first", "release", first.fencingToken ?? undefined);
    expect((await coordinate("fluncle-crawl", "third")).outcome).toBe("queued");
    const next = await coordinate("fluncle-note", "second");
    expect(next.outcome).toBe("acquired");
    expect(next.fencingToken).toBe((first.fencingToken ?? 0) + 1);
    expect(await liveLeases(telemetry, "write")).toBe(1);
  });

  it("cancels only queued or expired telemetry rows, never a live grant", async () => {
    await setRoute("telemetry:1");
    const live = await coordinate("fluncle-enrich", "live");
    expect((await coordinate("fluncle-enrich", "live", "cancel")).outcome).toBe("cancelled");
    expect(await liveLeases(telemetry, "write")).toBe(1);

    nowMs += 1;
    expect((await coordinate("fluncle-note", "waiting")).outcome).toBe("queued");
    expect((await coordinate("fluncle-note", "waiting", "cancel")).outcome).toBe("cancelled");
    expect(await contenderCount(telemetry)).toBe(1);
    expect(live.outcome).toBe("acquired");
  });
});

describe("the primary to telemetry cutover and its rollback", () => {
  it("never grants in telemetry while a primary lease is live, and fences stale primary grants", async () => {
    const held = await coordinate("fluncle-enrich", "primary-held");
    expect(held).toMatchObject({ fencingToken: 1, outcome: "acquired" });
    expect(await liveLeases(primary, "write")).toBe(1);

    await setRoute("telemetry:1");
    const waiting = await coordinate("fluncle-note", "telemetry-waiter");
    expect(waiting).toMatchObject({
      activeConflictCount: null,
      aheadCount: null,
      outcome: "queued",
      retryAfterMs: DATABASE_ADMISSION_MAX_RETRY_AFTER_MS,
      yieldReason: "queue",
    });
    expect(await control()).toBeUndefined();

    nowMs += 30_000;
    expect(
      (
        await coordinate(
          "fluncle-enrich",
          "primary-held",
          "heartbeat",
          held.fencingToken ?? undefined,
        )
      ).outcome,
    ).toBe("acquired");

    expect(
      (
        await coordinate(
          "fluncle-enrich",
          "primary-held",
          "release",
          held.fencingToken ?? undefined,
        )
      ).outcome,
    ).toBe("released");

    const staleRouted = await coordinateDatabaseAdmissionFor(
      primary,
      { action: "acquire", owner: "fluncle-crawl", protocolVersion: 2, runId: "stale-primary" },
      { enforced: true, monotonicNow: () => 0, serverNowMs: nowMs },
    );
    expect(staleRouted.outcome).toBe("queued");
    expect(await liveLeases(primary, "write")).toBe(0);

    const granted = await coordinate("fluncle-note", "telemetry-waiter");
    expect(granted.outcome).toBe("acquired");
    expect(granted.fencingToken).toBeGreaterThan(held.fencingToken ?? 0);
    expect(await control()).toEqual({ epoch: 1, open: 1 });
    expect(await liveLeases(primary, "write")).toBe(0);
    expect(await liveLeases(telemetry, "write")).toBe(1);
  });

  it("never grants on a plain primary route while telemetry is open or holds a live lease", async () => {
    await setRoute("telemetry:1");
    const held = await coordinate("fluncle-enrich", "telemetry-held");
    expect(held.outcome).toBe("acquired");

    await setRoute("primary");
    expect(await coordinate("fluncle-note", "plain-primary")).toMatchObject({
      outcome: "queued",
      yieldReason: "queue",
    });
    expect(await liveLeases(primary, "write")).toBe(0);

    await coordinate("fluncle-enrich", "telemetry-held", "release", held.fencingToken ?? undefined);
    await telemetry.execute(`update database_admission_control set store_open = 0`);
    expect((await coordinate("fluncle-note", "plain-primary")).outcome).toBe("acquired");
  });

  it("fails closed on a plain primary route when telemetry was used and cannot be read", async () => {
    await setRoute("telemetry:1");
    const held = await coordinate("fluncle-enrich", "telemetry-held");
    expect(held.outcome).toBe("acquired");
    await setRoute("primary");

    const unreachable: AdmissionClient = {
      batch: () => Promise.reject(new Error("telemetry unreachable")),
      execute: (() => Promise.reject(new Error("telemetry unreachable"))) as Client["execute"],
    };
    expect(
      await coordinate(
        "fluncle-note",
        "blind",
        "acquire",
        undefined,
        stores({ telemetry: unreachable }),
      ),
    ).toMatchObject({ outcome: "queued", yieldReason: "queue" });
    expect(
      await coordinate("fluncle-note", "no-client", "acquire", undefined, { primary }),
    ).toMatchObject({ outcome: "queued", yieldReason: "queue" });
    expect(await liveLeases(primary, "write")).toBe(0);
  });

  it("keeps a never-cut-over Worker independent of an unreadable telemetry database", async () => {
    const unreachable: AdmissionClient = {
      batch: () => Promise.reject(new Error("telemetry unreachable")),
      execute: (() => Promise.reject(new Error("telemetry unreachable"))) as Client["execute"],
    };
    expect(
      (
        await coordinate(
          "fluncle-note",
          "legacy",
          "acquire",
          undefined,
          stores({ telemetry: unreachable }),
        )
      ).outcome,
    ).toBe("acquired");
  });

  it("never opens telemetry for an epoch the main database has not recorded", async () => {
    await setSetting(DATABASE_ADMISSION_STORE_KEY, "telemetry:1");
    expect(await coordinate("fluncle-enrich", "unrecorded")).toMatchObject({
      outcome: "queued",
      yieldReason: "queue",
    });
    expect(await control()).toBeUndefined();
  });

  it("never renews a telemetry lease that expired while its heartbeat awaited a guardrail", async () => {
    await setRoute("telemetry:1");
    const held = await coordinate("fluncle-enrich", "slow-heartbeat");
    expect(held.outcome).toBe("acquired");
    const expiresAt = held.leaseExpiresAtMs ?? 0;
    nowMs = expiresAt - 1;

    let rolledBack: Awaited<ReturnType<typeof coordinate>> | undefined;
    const racingPrimary: AdmissionClient = {
      batch: primary.batch.bind(primary),
      execute: (async (statement: InStatement) => {
        if (rolledBack === undefined && statementSql(statement).includes("service_check_samples")) {
          nowMs = expiresAt + 1;
          await setRoute("primary:2");
          rolledBack = await coordinate("fluncle-note", "primary-winner");
        }
        return primary.execute(statement);
      }) as Client["execute"],
    };

    const heartbeat = await coordinateDatabaseAdmissionAcross(
      stores({ primary: racingPrimary }),
      {
        action: "heartbeat",
        fencingToken: held.fencingToken ?? undefined,
        owner: "fluncle-enrich",
        protocolVersion: 2,
        runId: "slow-heartbeat",
      },
      { databaseNowMs: () => nowMs, monotonicNow: () => 0, primaryReadTimeoutMs: 50 },
    );

    expect(rolledBack?.outcome).toBe("acquired");
    expect(heartbeat.outcome).toBe("lost");
    expect(await liveLeases(primary, "write")).toBe(1);
    expect(await liveLeases(telemetry, "write")).toBe(0);
  });

  it("rolls back to the primary only after telemetry is closed and drained", async () => {
    await setRoute("telemetry:1");
    const held = await coordinate("fluncle-enrich", "telemetry-held");
    expect(held.outcome).toBe("acquired");

    await setRoute("primary:2");
    const waiting = await coordinate("fluncle-note", "primary-waiter");
    expect(waiting).toMatchObject({ outcome: "queued", yieldReason: "queue" });
    expect(await control()).toEqual({ epoch: 2, open: 0 });
    expect(await liveLeases(primary, "write")).toBe(0);

    nowMs += 30_000;
    expect(
      (
        await coordinate(
          "fluncle-enrich",
          "telemetry-held",
          "heartbeat",
          held.fencingToken ?? undefined,
        )
      ).outcome,
    ).toBe("acquired");
    expect(
      (
        await coordinate(
          "fluncle-enrich",
          "telemetry-held",
          "release",
          held.fencingToken ?? undefined,
        )
      ).outcome,
    ).toBe("released");

    const staleTelemetry = await coordinate(
      "fluncle-crawl",
      "stale-telemetry",
      "acquire",
      undefined,
      stores({ primary: staleRoute(primary, "telemetry:1") }),
    );
    expect(staleTelemetry).toMatchObject({ outcome: "queued", yieldReason: "queue" });
    expect(await liveLeases(telemetry, "write")).toBe(0);
    expect(await control()).toEqual({ epoch: 2, open: 0 });

    const granted = await coordinate("fluncle-note", "primary-waiter");
    expect(granted.outcome).toBe("acquired");
    expect(granted.fencingToken).toBeGreaterThan(held.fencingToken ?? 0);
    expect(await liveLeases(primary, "write")).toBe(1);
    expect(await liveLeases(telemetry, "write")).toBe(0);
  });

  it("fences a primary grant whose handoff check raced a cutover to telemetry", async () => {
    await setRoute("primary:2");
    let raced: Awaited<ReturnType<typeof coordinate>> | undefined;
    const racingPrimary: AdmissionClient = {
      batch: async (statements, mode) => {
        if (mode === "write" && raced === undefined) {
          await setRoute("telemetry:3");
          raced = await coordinate("fluncle-note", "telemetry-winner");
        }
        return primary.batch(statements, mode);
      },
      execute: primary.execute.bind(primary),
    };

    const loser = await coordinate(
      "fluncle-enrich",
      "primary-loser",
      "acquire",
      undefined,
      stores({ primary: racingPrimary }),
    );
    expect(raced?.outcome).toBe("acquired");
    expect(loser.outcome).toBe("queued");
    expect(await liveLeases(primary, "write")).toBe(0);
    expect(await liveLeases(telemetry, "write")).toBe(1);
  });

  it("fences a telemetry grant whose drain check raced a rollback to the primary", async () => {
    await setRoute("telemetry:1");
    let raced: Awaited<ReturnType<typeof coordinate>> | undefined;
    const racingTelemetry: AdmissionClient = {
      batch: async (statements, mode) => {
        if (mode === "write" && raced === undefined) {
          await setRoute("primary:2");
          raced = await coordinate("fluncle-note", "primary-winner");
        }
        return telemetry.batch(statements, mode);
      },
      execute: telemetry.execute.bind(telemetry),
    };

    const loser = await coordinate(
      "fluncle-enrich",
      "telemetry-loser",
      "acquire",
      undefined,
      stores({ telemetry: racingTelemetry }),
    );
    expect(raced?.outcome).toBe("acquired");
    expect(loser.outcome).toBe("queued");
    expect(await control()).toEqual({ epoch: 2, open: 0 });
    expect(await liveLeases(telemetry, "write")).toBe(0);
    expect(await liveLeases(primary, "write")).toBe(1);
  });

  it("refuses to reopen telemetry at an epoch that was already closed", async () => {
    await setRoute("telemetry:1");
    const first = await coordinate("fluncle-enrich", "first-epoch");
    await coordinate("fluncle-enrich", "first-epoch", "release", first.fencingToken ?? undefined);
    await setRoute("primary:2");
    expect((await coordinate("fluncle-note", "closer")).outcome).toBe("acquired");

    await setRoute("telemetry:2");
    expect(await coordinate("fluncle-crawl", "same-epoch")).toMatchObject({
      outcome: "queued",
      yieldReason: "queue",
    });
    expect(await control()).toEqual({ epoch: 2, open: 0 });
  });

  it("never lets two stores hold the same lane across randomized stale-route interleavings", async () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const owners = ["fluncle-enrich", "fluncle-note", "fluncle-crawl", "fluncle-rank"];
    const held = new Map<string, { runId: string; token: number }>();
    const routes = ["telemetry:1", "primary:2", "telemetry:3", "primary:4", "telemetry:5"];
    let routeIndex = -1;
    let previousRoute = "primary";
    let run = 0;

    for (let step = 0; step < 400; step += 1) {
      nowMs += Math.floor(random() * 4_000);
      const roll = random();
      if (roll < 0.04 && routeIndex < routes.length - 1) {
        routeIndex += 1;
        previousRoute = routeIndex === 0 ? "primary" : (routes[routeIndex - 1] ?? "primary");
        await setRoute(routes[routeIndex] ?? "primary");
        continue;
      }
      const owner = owners[Math.floor(random() * owners.length)] ?? "fluncle-enrich";
      const holding = held.get(owner);
      if (holding !== undefined && roll < 0.5) {
        const action = random() < 0.5 ? "heartbeat" : "release";
        const result = await coordinate(owner, holding.runId, action, holding.token);
        if (action === "release" || result.outcome !== "acquired") {
          held.delete(owner);
        }
      } else if (holding === undefined) {
        run += 1;
        const runId = `run-${run}`;
        const stale = random() < 0.3 ? staleRoute(primary, previousRoute) : primary;
        const result = await coordinate(
          owner,
          runId,
          "acquire",
          undefined,
          stores({ primary: stale }),
        );
        if (result.outcome === "acquired" && result.fencingToken !== null) {
          held.set(owner, { runId, token: result.fencingToken });
        }
      }
      const live = (await liveLeases(primary, "write")) + (await liveLeases(telemetry, "write"));
      expect(live).toBeLessThanOrEqual(1);
    }
  });
});

describe("the primary write probe", () => {
  it("records an ok, slow, stalled, or failed write in telemetry and upserts one primary row", async () => {
    const ticks = [0, 20];
    expect(
      await recordDatabaseWriteProbeFor(stores(), {
        monotonicNow: () => ticks.shift() ?? 20,
        serverNowMs: nowMs,
      }),
    ).toEqual({ latencyMs: 20, outcome: "ok", recorded: true });

    const slowTicks = [0, DATABASE_WRITE_PROBE_SLOW_MS + 1];
    expect(
      await recordDatabaseWriteProbeFor(stores(), {
        monotonicNow: () => slowTicks.shift() ?? 0,
        serverNowMs: nowMs + 1,
      }),
    ).toMatchObject({ outcome: "slow", recorded: true });

    expect(
      await recordDatabaseWriteProbeFor(stores({ primary: stalledWrites(primary) }), {
        serverNowMs: nowMs + 2,
        timeoutMs: 20,
      }),
    ).toEqual({ latencyMs: null, outcome: "stalled", recorded: true });

    const failing: AdmissionClient = {
      batch: primary.batch.bind(primary),
      execute: (() => Promise.reject(new Error("SERVER_ERROR 524"))) as Client["execute"],
    };
    expect(
      await recordDatabaseWriteProbeFor(stores({ primary: failing }), { serverNowMs: nowMs + 3 }),
    ).toEqual({ latencyMs: null, outcome: "failed", recorded: true });

    const rows = await telemetry.execute(
      `select outcome from database_write_probes order by observed_at_ms asc`,
    );
    expect(rows.rows.map((row) => row.outcome)).toEqual(["ok", "slow", "stalled", "failed"]);
    const probeRows = await primary.execute({
      args: [DATABASE_WRITE_PROBE_KEY],
      sql: `select count(*) as n from settings where key = ?`,
    });
    expect(Number(probeRows.rows[0]?.n)).toBe(1);
  });

  it("reports an unrecorded probe when no telemetry store is configured", async () => {
    expect(await recordDatabaseWriteProbeFor({ primary }, { serverNowMs: nowMs })).toMatchObject({
      outcome: "ok",
      recorded: false,
    });
  });

  it("prunes probe samples past the retention window in bounded batches", async () => {
    await seedWriteProbes(["ok", "ok"], 1);
    nowMs = 8 * 24 * 60 * 60 * 1000;
    await recordDatabaseWriteProbeFor(stores(), { serverNowMs: nowMs });
    const rows = await telemetry.execute(`select observed_at_ms from database_write_probes`);
    expect(rows.rows.map((row) => Number(row.observed_at_ms))).toEqual([nowMs]);
  });

  it("smooths the probe: one bad sample never yields, two consecutive fresh bad samples do", () => {
    expect(writeProbeReasonFromSamples([])).toBeNull();
    expect(writeProbeReasonFromSamples(["stalled"])).toBeNull();
    expect(writeProbeReasonFromSamples(["stalled", "ok"])).toBeNull();
    expect(writeProbeReasonFromSamples(["ok", "slow"])).toBeNull();
    expect(writeProbeReasonFromSamples(["slow", "stalled", "ok"])).toBe("write-latency");
    expect(writeProbeReasonFromSamples(["failed", "failed"])).toBe("write-latency");
  });

  it("yields new writers on a smoothed write stall and treats stale samples as unknown", async () => {
    await setRoute("telemetry:1");
    await seedWriteProbes(["stalled"], nowMs - 1_000);
    expect((await coordinate("fluncle-enrich", "one-bad")).outcome).toBe("acquired");
    await coordinate("fluncle-enrich", "one-bad", "cancel");
    await telemetry.execute(`delete from database_admission_contenders`);

    await seedWriteProbes(["slow"], nowMs - 500);
    expect(await coordinate("fluncle-note", "two-bad")).toMatchObject({
      outcome: "queued",
      retryAfterMs: DATABASE_ADMISSION_MAX_RETRY_AFTER_MS,
      yieldReason: "write-latency",
    });

    nowMs += DATABASE_ADMISSION_HEALTH_STALE_MS + 1_000;
    expect((await coordinate("fluncle-note", "two-bad")).outcome).toBe("acquired");
  });

  it("fences a running payload on a smoothed write stall observed at heartbeat", async () => {
    await setRoute("telemetry:1");
    const held = await coordinate("fluncle-enrich", "held");
    await seedWriteProbes(["stalled", "stalled"], nowMs);
    nowMs += 30_000;
    expect(
      await coordinate("fluncle-enrich", "held", "heartbeat", held.fencingToken ?? undefined),
    ).toMatchObject({ outcome: "lost", yieldReason: "write-latency" });
  });

  it("reads the probe from telemetry while the lease store is still the primary", async () => {
    await seedWriteProbes(["stalled", "stalled"], nowMs);
    expect(await coordinate("fluncle-enrich", "legacy")).toMatchObject({
      outcome: "queued",
      yieldReason: "write-latency",
    });
    expect(
      await coordinate("fluncle-enrich", "legacy", "acquire", undefined, { primary }),
    ).toMatchObject({
      outcome: "acquired",
    });
  });
});
