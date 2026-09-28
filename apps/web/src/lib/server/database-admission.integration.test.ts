import { DatabaseAdmissionResponseSchema } from "@fluncle/contracts/orpc";
import { type Client } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  coordinateDatabaseAdmissionFor,
  DATABASE_ADMISSION_HEAD_RETRY_AFTER_MS,
  DATABASE_ADMISSION_HEALTH_STALE_MS,
  DATABASE_ADMISSION_INITIAL_LEASE_MS,
  DATABASE_ADMISSION_LEASE_MS,
  DATABASE_ADMISSION_MAX_RETRY_AFTER_MS,
  DATABASE_ADMISSION_QUEUE_REFRESH_MS,
  DATABASE_ADMISSION_QUEUE_TTL_MS,
  DATABASE_ADMISSION_RENEWED_LEASE_MS,
  DATABASE_ADMISSION_TRANSACTION_RETRIES,
  type DatabaseAdmissionAction,
  isDatabaseBusy,
  storedHealthReasonFromSamples,
} from "./database-admission";
import { createIntegrationDb } from "./integration-db";

let db: Client;
let nowMs: number;
let fixtureDirectory: string;

beforeEach(async () => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), "fluncle-admission-"));
  db = await createIntegrationDb({ url: `file:${join(fixtureDirectory, "database.db")}` });
  await db.execute(`pragma journal_mode = wal`);
  await db.execute(`pragma busy_timeout = 5000`);
  nowMs = 1_000;
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  db.close();
  rmSync(fixtureDirectory, { force: true, recursive: true });
});

function coordinate(
  owner: string,
  runId: string,
  action: DatabaseAdmissionAction = "acquire",
  fencingToken?: number,
) {
  return coordinateDatabaseAdmissionFor(
    db,
    { action, fencingToken, owner, runId },
    { enforced: true, monotonicNow: () => 0, serverNowMs: nowMs },
  );
}

let sampleSequence = 0;

async function seedHealth(
  service: "db" | "web",
  status: "degraded" | "down" | "ok",
  latencyMs: number,
  readings = 2,
): Promise<void> {
  const at = new Date(nowMs).toISOString();
  await db.execute({
    args: [service, status, latencyMs, at, at],
    sql: `insert into service_status
          (service, status, latency_ms, checked_at, since)
          values (?, ?, ?, ?, ?)
          on conflict(service) do update set
            status = excluded.status, latency_ms = excluded.latency_ms,
            checked_at = excluded.checked_at, since = excluded.since`,
  });
  for (let reading = 0; reading < readings; reading += 1) {
    sampleSequence += 1;
    await db.execute({
      args: [`sample-${String(sampleSequence).padStart(8, "0")}`, service, status, latencyMs, at],
      sql: `insert into service_check_samples (id, service, status, latency_ms, at)
            values (?, ?, ?, ?, ?)`,
    });
  }
}

async function activeCounts(): Promise<Record<string, number>> {
  const result = await db.execute(
    `select lane, count(*) as count from database_admission_contenders
     where state = 'active' group by lane`,
  );
  return Object.fromEntries(
    result.rows.flatMap((row) =>
      typeof row.lane === "string" ? [[row.lane, Number(row.count)]] : [],
    ),
  );
}

async function activeResourceCounts(): Promise<{ heavyRead: number; writer: number }> {
  const result = await db.execute(
    `select
       sum(case when lane = 'write' then 1 else 0 end) as writer_count,
       sum(case when lane = 'heavy-read' or operation_id glob '*|heavy-read' then 1 else 0 end)
         as heavy_read_count
     from database_admission_contenders
     where state = 'active'`,
  );
  return {
    heavyRead: Number(result.rows[0]?.heavy_read_count ?? 0),
    writer: Number(result.rows[0]?.writer_count ?? 0),
  };
}

describe("enforced database admission", () => {
  it("recognizes only the exact top-level SQLITE_BUSY coordinator failure", () => {
    expect(isDatabaseBusy({ code: "SQLITE_BUSY" })).toBe(true);
    expect(isDatabaseBusy({ code: "SQLITE_BUSY_TIMEOUT" })).toBe(false);
    expect(isDatabaseBusy({ cause: { code: "SQLITE_BUSY" } })).toBe(false);
  });

  it("exhausts the bounded SQLITE_BUSY acquisition retry budget", async () => {
    const busy = { code: "SQLITE_BUSY" };
    const client = {
      batch: vi.fn().mockRejectedValue(busy),
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ now_ms: nowMs }] })
        .mockResolvedValue({ rows: [] }),
    };
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      coordinateDatabaseAdmissionFor(
        client,
        { action: "acquire", owner: "fluncle-enrich", runId: "busy-budget" },
        { enforced: true, monotonicNow: () => 0, serverNowMs: nowMs, wait },
      ),
    ).rejects.toBe(busy);
    expect(client.batch).toHaveBeenCalledTimes(DATABASE_ADMISSION_TRANSACTION_RETRIES + 1);
    expect(wait).toHaveBeenCalledTimes(DATABASE_ADMISSION_TRANSACTION_RETRIES);
  });

  it("stays default-off unless the settings value is exactly true", async () => {
    const request = { action: "acquire" as const, owner: "fluncle-enrich", runId: "flag" };
    const dependencies = { monotonicNow: () => 0, serverNowMs: nowMs };
    expect(await coordinateDatabaseAdmissionFor(db, request, dependencies)).toMatchObject({
      enforced: false,
      outcome: "shadow-acquire",
    });

    await db.execute(
      `insert into settings (key, value) values ('database_admission_enforced', 'TRUE')`,
    );
    expect(await coordinateDatabaseAdmissionFor(db, request, dependencies)).toMatchObject({
      enforced: false,
      outcome: "shadow-acquire",
    });

    await db.execute(
      `update settings set value = 'true' where key = 'database_admission_enforced'`,
    );
    expect(await coordinateDatabaseAdmissionFor(db, request, dependencies)).toMatchObject({
      enforced: true,
      outcome: "acquired",
    });
  });

  it("admits at most one global writer and one explicitly heavy reader under simultaneous firing", async () => {
    const results = await Promise.all([
      coordinate("fluncle-enrich", "writer-a"),
      coordinate("fluncle-note", "writer-b"),
      coordinate("fluncle-crawl", "writer-c"),
      coordinate("fluncle-cluster", "mixed"),
      coordinate("fluncle-backup", "reader-a"),
      coordinate("fluncle-backup", "reader-b"),
    ]);

    expect(
      results.filter((result) => result.lane === "write" && result.outcome === "acquired"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.lane === "heavy-read" && result.outcome === "acquired")
        .length,
    ).toBeLessThanOrEqual(1);
    expect(await activeResourceCounts()).toEqual({ heavyRead: 1, writer: 1 });
  });

  it("preserves FIFO across a writer that also consumes the heavy-reader resource", async () => {
    const activeWriter = await coordinate("fluncle-enrich", "active-writer");
    nowMs += 1;
    expect(await coordinate("fluncle-cluster", "mixed-oldest")).toMatchObject({
      heavyRead: true,
      lane: "write",
      outcome: "queued",
    });
    nowMs += 1;
    expect(await coordinate("fluncle-backup", "reader-next")).toMatchObject({
      heavyRead: true,
      lane: "heavy-read",
      outcome: "queued",
    });
    nowMs += 1;
    expect(await coordinate("fluncle-note", "writer-last")).toMatchObject({
      outcome: "queued",
    });

    await coordinate(
      "fluncle-enrich",
      "active-writer",
      "release",
      activeWriter.fencingToken ?? undefined,
    );
    expect((await coordinate("fluncle-backup", "reader-next")).outcome).toBe("queued");
    expect((await coordinate("fluncle-note", "writer-last")).outcome).toBe("queued");

    const mixed = await coordinate("fluncle-cluster", "mixed-oldest");
    expect(mixed.outcome).toBe("acquired");
    expect(await activeResourceCounts()).toEqual({ heavyRead: 1, writer: 1 });
    expect((await coordinate("fluncle-backup", "reader-next")).outcome).toBe("queued");

    await coordinate("fluncle-cluster", "mixed-oldest", "release", mixed.fencingToken ?? undefined);
    expect((await coordinate("fluncle-backup", "reader-next")).outcome).toBe("acquired");
    expect((await coordinate("fluncle-note", "writer-last")).outcome).toBe("acquired");
    expect(await activeResourceCounts()).toEqual({ heavyRead: 1, writer: 1 });
  });

  it("honors a persisted mixed-resource mask after the logical operation leaves the registry", async () => {
    await db.execute({
      args: ["retired", "write", "retired.mixed|heavy-read", "retired-owner", "retired-run"],
      sql: `insert into database_admission_contenders
        (contender_id, lane, operation_id, owner_id, run_id, state, enqueued_at_ms,
         queue_heartbeat_at_ms, updated_at_ms, acquired_at_ms, fencing_token,
         lease_expires_at_ms)
        values (?, ?, ?, ?, ?, 'active', 1000, 1000, 1000, 1000, 1, 91000)`,
    });

    expect(await coordinate("fluncle-backup", "reader")).toMatchObject({
      lane: "heavy-read",
      outcome: "queued",
      yieldReason: "queue",
    });
  });

  it("preserves FIFO order so repeated newcomers cannot starve the oldest contender", async () => {
    await seedHealth("web", "ok", 700);
    const first = await coordinate("fluncle-enrich", "oldest");
    nowMs += 100;
    const second = await coordinate("fluncle-note", "second");
    nowMs += 100;
    await coordinate("fluncle-crawl", "new-a");
    nowMs += 100;
    await coordinate("fluncle-crawl", "new-b");
    expect([first.outcome, second.outcome]).toEqual(["queued", "queued"]);

    await seedHealth("web", "ok", 100);
    const impatient = await coordinate("fluncle-note", "second");
    expect(impatient.outcome).toBe("queued");
    const winner = await coordinate("fluncle-enrich", "oldest");
    expect(winner).toMatchObject({ outcome: "acquired", queueAgeMs: 300, waitMs: 300 });
  });

  it("recovers process death, partitioned heartbeats, and abandoned queues after server-clock expiry", async () => {
    const abandoned = await coordinate("fluncle-enrich", "dead-process");
    expect(abandoned.outcome).toBe("acquired");

    nowMs += DATABASE_ADMISSION_LEASE_MS + 1;
    const recoveredActive = await coordinate("fluncle-note", "after-death");
    expect(recoveredActive).toMatchObject({ outcome: "acquired", recovered: true });

    await seedHealth("web", "ok", 700);
    nowMs += 1;
    await coordinate("fluncle-crawl", "abandoned-queue");
    nowMs += DATABASE_ADMISSION_QUEUE_TTL_MS + 1;
    const recoveredQueue = await coordinate("fluncle-crawl", "live-queue");
    expect(recoveredQueue).toMatchObject({ outcome: "queued", recovered: true });
  });

  it("uses the database clock rather than contender clock skew", async () => {
    nowMs = 50_000;
    const result = await coordinate("fluncle-enrich", "client-clock-is-irrelevant");
    expect(result.leaseExpiresAtMs).toBe(50_000 + DATABASE_ADMISSION_LEASE_MS);

    nowMs = 50_000 + DATABASE_ADMISSION_HEARTBEAT_TEST_OFFSET;
    const renewed = await coordinate(
      "fluncle-enrich",
      "client-clock-is-irrelevant",
      "heartbeat",
      result.fencingToken ?? undefined,
    );
    expect(renewed.leaseExpiresAtMs).toBe(nowMs + DATABASE_ADMISSION_LEASE_MS);
  });

  it("fences lease theft after expiry and rejects the stale owner's heartbeat and release", async () => {
    const first = await coordinate("fluncle-enrich", "owner-a");
    const firstToken = first.fencingToken;
    expect(firstToken).not.toBeNull();

    nowMs += DATABASE_ADMISSION_LEASE_MS + 1;
    const thief = await coordinate("fluncle-note", "owner-b");
    expect(thief.fencingToken).toBe((firstToken ?? 0) + 1);

    const staleHeartbeat = await coordinate(
      "fluncle-enrich",
      "owner-a",
      "heartbeat",
      firstToken ?? undefined,
    );
    const staleRelease = await coordinate(
      "fluncle-enrich",
      "owner-a",
      "release",
      firstToken ?? undefined,
    );
    expect([staleHeartbeat.outcome, staleRelease.outcome]).toEqual(["lost", "lost"]);
    expect(await activeCounts()).toEqual({ write: 1 });
  });

  it("expires a paused live owner, fences its stale token, and admits its waiting writer", async () => {
    const pausedOwner = await coordinate("fluncle-enrich", "paused-live-owner");
    const pausedToken = pausedOwner.fencingToken;
    expect(pausedOwner.outcome).toBe("acquired");
    expect(pausedToken).not.toBeNull();

    nowMs += 1;
    expect(await coordinate("fluncle-note", "waiting-writer")).toMatchObject({
      outcome: "queued",
      yieldReason: "queue",
    });

    nowMs += DATABASE_ADMISSION_LEASE_MS;
    const admittedWriter = await coordinate("fluncle-note", "waiting-writer");
    expect(admittedWriter).toMatchObject({ outcome: "acquired", recovered: true });
    expect(admittedWriter.fencingToken).toBe((pausedToken ?? 0) + 1);

    const staleHeartbeat = await coordinate(
      "fluncle-enrich",
      "paused-live-owner",
      "heartbeat",
      pausedToken ?? undefined,
    );
    const staleRelease = await coordinate(
      "fluncle-enrich",
      "paused-live-owner",
      "release",
      pausedToken ?? undefined,
    );
    expect([staleHeartbeat.outcome, staleRelease.outcome]).toEqual(["lost", "lost"]);
    expect(await activeCounts()).toEqual({ write: 1 });
  });

  it("reports an expired heartbeat and release as lost before another contender cleans up", async () => {
    const heartbeatOwner = await coordinate("fluncle-enrich", "expired-heartbeat");
    nowMs += DATABASE_ADMISSION_LEASE_MS + 1;
    expect(
      await coordinate(
        "fluncle-enrich",
        "expired-heartbeat",
        "heartbeat",
        heartbeatOwner.fencingToken ?? undefined,
      ),
    ).toMatchObject({ outcome: "lost" });

    const releaseOwner = await coordinate("fluncle-note", "expired-release");
    nowMs += DATABASE_ADMISSION_LEASE_MS + 1;
    expect(
      await coordinate(
        "fluncle-note",
        "expired-release",
        "release",
        releaseOwner.fencingToken ?? undefined,
      ),
    ).toMatchObject({ outcome: "lost" });
    expect(await activeCounts()).toEqual({});
  });

  it("yields acquisition and renewal on guardrail breach and keeps the fenced lease until its owner releases it", async () => {
    await seedHealth("db", "degraded", 10);
    const queued = await coordinate("fluncle-enrich", "guarded");
    expect(queued).toMatchObject({ outcome: "queued", yieldReason: "database-health" });

    await seedHealth("db", "ok", 10);
    nowMs += 10;
    const acquired = await coordinate("fluncle-enrich", "guarded");
    expect(acquired.outcome).toBe("acquired");

    await seedHealth("web", "ok", 900);
    nowMs += 10;
    const stopped = await coordinate(
      "fluncle-enrich",
      "guarded",
      "heartbeat",
      acquired.fencingToken ?? undefined,
    );
    expect(stopped).toMatchObject({ outcome: "lost", yieldReason: "public-latency" });
    expect(await activeCounts()).toEqual({ write: 1 });

    await seedHealth("web", "ok", 10);
    nowMs += 10;
    expect((await coordinate("fluncle-note", "after-recovery")).outcome).toBe("queued");
    expect(
      await coordinate("fluncle-enrich", "guarded", "release", acquired.fencingToken ?? undefined),
    ).toMatchObject({ outcome: "released" });
    const next = await coordinate("fluncle-note", "after-recovery");
    expect(next.outcome).toBe("acquired");
  });

  it("queues on direct read latency and lets the health writer clear its own stale snapshot", async () => {
    const monotonicSamples = [0, 251];
    const slow = await coordinateDatabaseAdmissionFor(
      db,
      { action: "acquire", owner: "fluncle-enrich", runId: "direct-slow" },
      {
        enforced: true,
        monotonicNow: () => monotonicSamples.shift() ?? 0,
        serverNowMs: nowMs,
      },
    );
    expect(slow).toMatchObject({ outcome: "queued", yieldReason: "direct-read-latency" });
    await coordinate("fluncle-enrich", "direct-slow", "cancel");

    await seedHealth("db", "down", 1_000);
    await seedHealth("web", "down", 1_000);
    const healthWriter = await coordinate("fluncle-healthcheck", "recovery-probe");
    expect(healthWriter).toMatchObject({ outcome: "acquired", yieldReason: null });
  });

  it("admits the recovery writer past health-blocked contenders and resumes their durable FIFO", async () => {
    await seedHealth("db", "degraded", 251);
    expect(await coordinate("fluncle-enrich", "blocked-oldest")).toMatchObject({
      outcome: "queued",
      yieldReason: "database-health",
    });
    nowMs += 1;
    expect(await coordinate("fluncle-note", "blocked-next")).toMatchObject({
      outcome: "queued",
      yieldReason: "database-health",
    });
    nowMs += 1;

    const recovery = await coordinate("fluncle-healthcheck", "recovery");
    expect(recovery).toMatchObject({ outcome: "acquired", yieldReason: null });
    expect(await activeCounts()).toEqual({ write: 1 });

    await coordinate(
      "fluncle-healthcheck",
      "recovery",
      "release",
      recovery.fencingToken ?? undefined,
    );
    await seedHealth("db", "ok", 10);
    nowMs += 1;

    expect(await coordinate("fluncle-healthcheck", "healthy-later")).toMatchObject({
      outcome: "queued",
      yieldReason: "queue",
    });
    const oldest = await coordinate("fluncle-enrich", "blocked-oldest");
    expect(oldest.outcome).toBe("acquired");
    await coordinate(
      "fluncle-enrich",
      "blocked-oldest",
      "release",
      oldest.fencingToken ?? undefined,
    );

    expect((await coordinate("fluncle-healthcheck", "healthy-later")).outcome).toBe("queued");
    const next = await coordinate("fluncle-note", "blocked-next");
    expect(next.outcome).toBe("acquired");
    await coordinate("fluncle-note", "blocked-next", "release", next.fencingToken ?? undefined);
    expect((await coordinate("fluncle-healthcheck", "healthy-later")).outcome).toBe("acquired");
  });

  it("treats stale stored health as unknown rather than bad", async () => {
    await seedHealth("db", "down", 4_000);
    await seedHealth("web", "down", 4_000);
    nowMs += DATABASE_ADMISSION_HEALTH_STALE_MS + 1;
    expect(await coordinate("fluncle-enrich", "stale-health-unknown")).toMatchObject({
      outcome: "acquired",
      yieldReason: null,
    });
  });

  it("never lets a recovery writer bypass an active writer", async () => {
    const active = await coordinate("fluncle-enrich", "active-before-degradation");
    await seedHealth("db", "degraded", 251);
    nowMs += 1;
    expect(await coordinate("fluncle-note", "health-blocked")).toMatchObject({
      outcome: "queued",
      yieldReason: "database-health",
    });
    nowMs += 1;

    expect(await coordinate("fluncle-healthcheck", "recovery-behind-active")).toMatchObject({
      outcome: "queued",
      yieldReason: "queue",
    });
    expect(await activeCounts()).toEqual({ write: 1 });

    await coordinate(
      "fluncle-enrich",
      "active-before-degradation",
      "release",
      active.fencingToken ?? undefined,
    );
    expect(await coordinate("fluncle-healthcheck", "recovery-behind-active")).toMatchObject({
      outcome: "acquired",
      yieldReason: null,
    });
  });

  it("cancels a bounded wait without disturbing older work and drains every remaining contender", async () => {
    const active = await coordinate("fluncle-enrich", "active");
    nowMs += 1;
    await coordinate("fluncle-note", "keep");
    nowMs += 1;
    await coordinate("fluncle-crawl", "cancel");

    const cancelled = await coordinate("fluncle-crawl", "cancel", "cancel");
    expect(cancelled.outcome).toBe("cancelled");
    await coordinate("fluncle-enrich", "active", "release", active.fencingToken ?? undefined);
    const kept = await coordinate("fluncle-note", "keep");
    expect(kept.outcome).toBe("acquired");
    await coordinate("fluncle-note", "keep", "release", kept.fencingToken ?? undefined);

    const remaining = await db.execute(
      `select count(*) as count from database_admission_contenders`,
    );
    expect(remaining.rows[0]?.count).toBe(0);
  });
});

function countingClient() {
  const batch = vi.fn((...args: Parameters<Client["batch"]>) => db.batch(...args));
  return { batch, client: { batch, execute: db.execute.bind(db) } };
}

function tolerant(
  owner: string,
  runId: string,
  action: DatabaseAdmissionAction = "acquire",
  options: {
    client?: Pick<Client, "batch" | "execute">;
    fencingToken?: number;
    notAfterMs?: number;
  } = {},
) {
  return coordinateDatabaseAdmissionFor(
    options.client ?? db,
    {
      action,
      fencingToken: options.fencingToken,
      notAfterMs: options.notAfterMs,
      owner,
      protocolVersion: 2,
      runId,
    },
    { enforced: true, monotonicNow: () => 0, serverNowMs: nowMs },
  );
}

describe("stored health smoothing", () => {
  it("closes the lane only on two consecutive bad readings of the same service", () => {
    const ok = { latency_ms: 10, service: "db", status: "ok" };
    const down = { latency_ms: 4_000, service: "db", status: "down" };
    const slowWeb = { latency_ms: 900, service: "web", status: "ok" };
    const fastWeb = { latency_ms: 90, service: "web", status: "ok" };

    expect(storedHealthReasonFromSamples([down])).toBeNull();
    expect(storedHealthReasonFromSamples([down, ok])).toBeNull();
    expect(storedHealthReasonFromSamples([ok, down])).toBeNull();
    expect(storedHealthReasonFromSamples([down, down])).toBe("database-health");
    expect(storedHealthReasonFromSamples([slowWeb, fastWeb])).toBeNull();
    expect(storedHealthReasonFromSamples([slowWeb, slowWeb])).toBe("public-latency");
    expect(storedHealthReasonFromSamples([])).toBeNull();
  });

  it("lets one bad health reading through and reopens on the first good one", async () => {
    await seedHealth("db", "down", 4_000, 1);
    expect((await coordinate("fluncle-enrich", "one-bad-reading")).outcome).toBe("acquired");

    await seedHealth("db", "down", 4_000, 1);
    nowMs += 1;
    expect(await coordinate("fluncle-note", "two-bad-readings")).toMatchObject({
      outcome: "queued",
      retryAfterMs: DATABASE_ADMISSION_MAX_RETRY_AFTER_MS,
      yieldReason: "database-health",
    });

    await seedHealth("db", "ok", 10, 1);
    nowMs += 1;
    expect(await coordinate("fluncle-note", "two-bad-readings")).toMatchObject({
      outcome: "queued",
      yieldReason: "queue",
    });
  });

  it("never fences a running payload on a single slow direct read during its heartbeat", async () => {
    const acquired = await coordinate("fluncle-enrich", "slow-read-heartbeat");
    const monotonicSamples = [0, 5_000];
    nowMs += 10;
    const renewed = await coordinateDatabaseAdmissionFor(
      db,
      {
        action: "heartbeat",
        fencingToken: acquired.fencingToken ?? undefined,
        owner: "fluncle-enrich",
        runId: "slow-read-heartbeat",
      },
      { enforced: true, monotonicNow: () => monotonicSamples.shift() ?? 0, serverNowMs: nowMs },
    );
    expect(renewed).toMatchObject({ outcome: "acquired", yieldReason: null });
  });
});

describe("stall-tolerant admission protocol", () => {
  it("answers every stall-tolerant outcome inside the published response contract", async () => {
    const results = [await tolerant("fluncle-enrich", "contract-holder")];
    nowMs += 1;
    results.push(await tolerant("fluncle-note", "contract-queued"));
    results.push(
      await tolerant("fluncle-crawl", "contract-late", "acquire", { notAfterMs: nowMs - 1 }),
    );
    results.push(
      await tolerant("fluncle-enrich", "contract-holder", "heartbeat", {
        fencingToken: results[0]?.fencingToken ?? undefined,
      }),
    );
    results.push(
      await tolerant("fluncle-note", "contract-queued", "heartbeat", { fencingToken: 99 }),
    );
    results.push(
      await coordinateDatabaseAdmissionFor(
        db,
        {
          action: "acquire",
          owner: "fluncle-enrich",
          protocolVersion: 2,
          runId: "contract-shadow",
        },
        { enforced: false, monotonicNow: () => 0, serverNowMs: nowMs },
      ),
    );

    expect(results.map((result) => result.outcome)).toEqual([
      "acquired",
      "queued",
      "cancelled",
      "acquired",
      "lost",
      "shadow-yield",
    ]);
    for (const result of results) {
      expect(DatabaseAdmissionResponseSchema.parse(result)).toEqual(result);
    }
  });

  it("grants a short initial lease that the first heartbeat extends to the stall-tolerant lease", async () => {
    const granted = await tolerant("fluncle-enrich", "tolerant-grant");
    expect(granted).toMatchObject({
      heartbeatAfterMs: DATABASE_ADMISSION_INITIAL_LEASE_MS / 3,
      leaseExpiresAtMs: nowMs + DATABASE_ADMISSION_INITIAL_LEASE_MS,
      leaseRemainingMs: DATABASE_ADMISSION_INITIAL_LEASE_MS,
      outcome: "acquired",
    });

    nowMs += 10_000;
    const renewed = await tolerant("fluncle-enrich", "tolerant-grant", "heartbeat", {
      fencingToken: granted.fencingToken ?? undefined,
    });
    expect(renewed).toMatchObject({
      heartbeatAfterMs: 30_000,
      leaseRemainingMs: DATABASE_ADMISSION_RENEWED_LEASE_MS,
      outcome: "acquired",
    });

    nowMs += DATABASE_ADMISSION_RENEWED_LEASE_MS - 1;
    expect(await tolerant("fluncle-note", "behind-tolerant-holder")).toMatchObject({
      outcome: "queued",
    });
    nowMs += 2;
    const next = await tolerant("fluncle-note", "behind-tolerant-holder");
    expect(next).toMatchObject({ outcome: "acquired", recovered: true });
    expect(next.fencingToken).toBe((granted.fencingToken ?? 0) + 1);
  });

  it("answers a repeated acquire for the same run with its existing grant and no write", async () => {
    const { batch, client } = countingClient();
    const first = await tolerant("fluncle-enrich", "idempotent", "acquire", { client });
    expect(batch).toHaveBeenCalledTimes(1);

    nowMs += 1_000;
    const again = await tolerant("fluncle-enrich", "idempotent", "acquire", { client });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(again).toMatchObject({
      fencingToken: first.fencingToken,
      leaseRemainingMs: DATABASE_ADMISSION_INITIAL_LEASE_MS - 1_000,
      outcome: "acquired",
    });
    expect(await activeCounts()).toEqual({ write: 1 });
  });

  it("reaps a grant nobody ever heartbeats after the short initial lease", async () => {
    const ghost = await tolerant("fluncle-enrich", "never-heartbeats");
    expect(ghost.outcome).toBe("acquired");

    nowMs += DATABASE_ADMISSION_INITIAL_LEASE_MS + 1;
    const next = await tolerant("fluncle-note", "after-ghost");
    expect(next).toMatchObject({ outcome: "acquired", recovered: true });
    expect(DATABASE_ADMISSION_INITIAL_LEASE_MS).toBeLessThan(DATABASE_ADMISSION_LEASE_MS);
  });

  it("never lets a tokenless cancel free an unexpired grant whose payload started before its first heartbeat", async () => {
    const granted = await tolerant("fluncle-enrich", "payload-started");
    expect(granted.outcome).toBe("acquired");
    nowMs += 1;

    expect(await tolerant("fluncle-enrich", "payload-started", "cancel")).toMatchObject({
      outcome: "cancelled",
      recovered: false,
    });
    expect(await activeCounts()).toEqual({ write: 1 });
    expect((await tolerant("fluncle-note", "conflicting")).outcome).toBe("queued");
  });

  it("lets an unanswered grant age out under its short initial lease after its runner cancelled", async () => {
    await tolerant("fluncle-enrich", "gave-up");
    await tolerant("fluncle-enrich", "gave-up", "cancel");
    nowMs += DATABASE_ADMISSION_INITIAL_LEASE_MS + 1;
    expect(await tolerant("fluncle-note", "after-age-out")).toMatchObject({
      outcome: "acquired",
      recovered: true,
    });
  });

  it("removes a queued row or an expired grant on cancel", async () => {
    await tolerant("fluncle-enrich", "holder");
    nowMs += 1;
    expect((await tolerant("fluncle-note", "queued-then-cancelled")).outcome).toBe("queued");
    expect(await tolerant("fluncle-note", "queued-then-cancelled", "cancel")).toMatchObject({
      outcome: "cancelled",
    });
    nowMs += DATABASE_ADMISSION_INITIAL_LEASE_MS + 1;
    expect(await tolerant("fluncle-enrich", "holder", "cancel")).toMatchObject({
      outcome: "cancelled",
    });
    const rows = await db.execute(`select count(*) as count from database_admission_contenders`);
    expect(rows.rows[0]?.count).toBe(0);
  });

  it("refuses an acquire that reaches the database after its runner's deadline", async () => {
    const deadlineMs = nowMs + 5_000;
    nowMs = deadlineMs + 1;
    expect(
      await tolerant("fluncle-enrich", "arrived-late", "acquire", { notAfterMs: deadlineMs }),
    ).toMatchObject({ fencingToken: null, outcome: "cancelled", yieldReason: "queue" });
    const rows = await db.execute(`select count(*) as count from database_admission_contenders`);
    expect(rows.rows[0]?.count).toBe(0);
    expect((await tolerant("fluncle-note", "on-time")).outcome).toBe("acquired");
  });

  it("drops a queued row when the same run's acquire arrives after its deadline", async () => {
    const holder = await tolerant("fluncle-enrich", "holder-before-late-retry");
    nowMs += 1;
    const deadlineMs = nowMs + 5_000;
    expect(
      (await tolerant("fluncle-note", "late-retry", "acquire", { notAfterMs: deadlineMs })).outcome,
    ).toBe("queued");
    nowMs = deadlineMs + 1;
    expect(
      await tolerant("fluncle-note", "late-retry", "acquire", { notAfterMs: deadlineMs }),
    ).toMatchObject({ outcome: "cancelled", recovered: true });
    const rows = await db.execute(
      `select run_id, state, fencing_token from database_admission_contenders`,
    );
    expect(rows.rows).toEqual([
      { fencing_token: holder.fencingToken, run_id: "holder-before-late-retry", state: "active" },
    ]);
  });

  it("never lets a timed-out acquire that lands after the deadline free the grant its retry is running under", async () => {
    const deadlineMs = nowMs + 120_000;
    const retried = await tolerant("fluncle-enrich", "retried-run", "acquire", {
      notAfterMs: deadlineMs,
    });
    expect(retried.outcome).toBe("acquired");
    nowMs += 10_000;
    expect(
      (
        await tolerant("fluncle-enrich", "retried-run", "heartbeat", {
          fencingToken: retried.fencingToken ?? undefined,
        })
      ).outcome,
    ).toBe("acquired");

    nowMs = deadlineMs + 1;
    expect(
      await tolerant("fluncle-enrich", "retried-run", "acquire", { notAfterMs: deadlineMs }),
    ).toMatchObject({ fencingToken: retried.fencingToken, outcome: "acquired" });
    expect(await activeCounts()).toEqual({ write: 1 });
    expect((await tolerant("fluncle-note", "must-wait")).outcome).toBe("queued");
  });

  it("refuses to let a late acquire free a grant whose payload started before its first heartbeat", async () => {
    const deadlineMs = nowMs + 10_000;
    const retried = await tolerant("fluncle-enrich", "fresh-grant", "acquire", {
      notAfterMs: deadlineMs,
    });
    expect(retried.outcome).toBe("acquired");

    nowMs = deadlineMs + 1;
    expect(
      await tolerant("fluncle-enrich", "fresh-grant", "acquire", { notAfterMs: deadlineMs }),
    ).toMatchObject({ fencingToken: retried.fencingToken, outcome: "acquired" });
    expect(await activeCounts()).toEqual({ write: 1 });
    expect((await tolerant("fluncle-note", "must-wait")).outcome).toBe("queued");
  });

  it("never lets a cancel remove a lease its payload has already renewed", async () => {
    const running = await tolerant("fluncle-enrich", "renewed-run");
    nowMs += 10_000;
    await tolerant("fluncle-enrich", "renewed-run", "heartbeat", {
      fencingToken: running.fencingToken ?? undefined,
    });

    expect(await tolerant("fluncle-enrich", "renewed-run", "cancel")).toMatchObject({
      outcome: "cancelled",
      recovered: false,
    });
    expect(await activeCounts()).toEqual({ write: 1 });
    expect((await tolerant("fluncle-note", "must-wait")).outcome).toBe("queued");
  });

  it("lets a queued contender behind the head wait without re-sending the write batch", async () => {
    const { batch, client } = countingClient();
    await tolerant("fluncle-enrich", "holder", "acquire", { client });
    nowMs += 1;
    await tolerant("fluncle-note", "head", "acquire", { client });
    nowMs += 1;
    const behind = await tolerant("fluncle-crawl", "behind", "acquire", { client });
    expect(behind).toMatchObject({
      outcome: "queued",
      retryAfterMs: DATABASE_ADMISSION_HEAD_RETRY_AFTER_MS * 2,
      yieldReason: "queue",
    });
    expect(batch).toHaveBeenCalledTimes(3);

    for (let poll = 0; poll < 5; poll += 1) {
      nowMs += 2_000;
      expect(await tolerant("fluncle-crawl", "behind", "acquire", { client })).toMatchObject({
        outcome: "queued",
        retryAfterMs: DATABASE_ADMISSION_HEAD_RETRY_AFTER_MS * 2,
      });
      expect(await tolerant("fluncle-note", "head", "acquire", { client })).toMatchObject({
        outcome: "queued",
        retryAfterMs: DATABASE_ADMISSION_HEAD_RETRY_AFTER_MS,
      });
    }
    expect(batch).toHaveBeenCalledTimes(3);

    nowMs += DATABASE_ADMISSION_QUEUE_REFRESH_MS;
    await tolerant("fluncle-crawl", "behind", "acquire", { client });
    expect(batch).toHaveBeenCalledTimes(4);
    const refreshed = await db.execute({
      args: ["behind"],
      sql: `select queue_heartbeat_at_ms from database_admission_contenders where run_id = ?`,
    });
    expect(refreshed.rows[0]?.queue_heartbeat_at_ms).toBe(nowMs);
  });

  it("leaves no stall leftover holding the lane once a five-minute coordinator stall clears", async () => {
    const stallStart = nowMs;
    const running = await tolerant("fluncle-enrich", "running-before-stall");
    nowMs += 10_000;
    expect(
      (
        await tolerant("fluncle-enrich", "running-before-stall", "heartbeat", {
          fencingToken: running.fencingToken ?? undefined,
        })
      ).outcome,
    ).toBe("acquired");

    const giveUpAtMs = stallStart + 60_000;
    nowMs = stallStart + 20_000;
    expect(
      (
        await tolerant("fluncle-note", "committed-while-stalled", "acquire", {
          notAfterMs: giveUpAtMs,
        })
      ).outcome,
    ).toBe("queued");

    nowMs = stallStart + 5 * 60_000;
    expect(
      await tolerant("fluncle-enrich", "running-before-stall", "heartbeat", {
        fencingToken: running.fencingToken ?? undefined,
      }),
    ).toMatchObject({ fencingToken: running.fencingToken, outcome: "acquired" });
    expect(
      await tolerant("fluncle-note", "committed-while-stalled", "acquire", {
        notAfterMs: giveUpAtMs,
      }),
    ).toMatchObject({ outcome: "cancelled", recovered: true });
    expect(
      await tolerant("fluncle-enrich", "running-before-stall", "release", {
        fencingToken: running.fencingToken ?? undefined,
      }),
    ).toMatchObject({ outcome: "released" });

    expect((await tolerant("fluncle-crawl", "after-recovery")).outcome).toBe("acquired");
  });
});

const DATABASE_ADMISSION_HEARTBEAT_TEST_OFFSET = 1_000;
