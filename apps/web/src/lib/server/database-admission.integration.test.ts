import { type Client } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  coordinateDatabaseAdmissionFor,
  DATABASE_ADMISSION_LEASE_MS,
  DATABASE_ADMISSION_QUEUE_TTL_MS,
  type DatabaseAdmissionAction,
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

async function seedHealth(
  service: "db" | "web",
  status: "degraded" | "down" | "ok",
  latencyMs: number,
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

  it("yields acquisition and renewal on guardrail breach, then recovers without losing queued work", async () => {
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

    await seedHealth("web", "ok", 10);
    nowMs += 10;
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

const DATABASE_ADMISSION_HEARTBEAT_TEST_OFFSET = 1_000;
