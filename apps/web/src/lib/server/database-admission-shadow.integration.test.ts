import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DATABASE_ADMISSION_DIRECT_READ_LIMIT_MS,
  observeDatabaseAdmissionFor,
} from "./database-admission";
import { createIntegrationDb } from "./integration-db";

let db: Client;

beforeEach(async () => {
  db = await createIntegrationDb();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

describe("database admission shadow observation", () => {
  it("classifies simultaneous writers without changing their compatibility path", async () => {
    const requests = ["run-a", "run-b", "run-c"].map((runId) =>
      observeDatabaseAdmissionFor(
        db,
        { action: "acquire", owner: "fluncle-enrich", runId },
        { monotonicNow: () => 10, serverNowMs: 10_000 },
      ),
    );

    const results = await Promise.all(requests);
    expect(results.map((result) => result.outcome)).toEqual([
      "shadow-acquire",
      "shadow-acquire",
      "shadow-acquire",
    ]);
    expect(results.every((result) => result.enforced === false)).toBe(true);

    const rows = await db.execute(`select count(*) as count from database_admission_contenders`);
    expect(rows.rows[0]?.count).toBe(0);
  });

  it("observes durable contention and queue age without joining the queue", async () => {
    await db.execute({
      args: ["held", "write", "track.enrich", "fluncle-enrich", "held-run"],
      sql: `insert into database_admission_contenders
        (contender_id, lane, operation_id, owner_id, run_id, state, enqueued_at_ms,
         queue_heartbeat_at_ms, updated_at_ms)
        values (?, ?, ?, ?, ?, 'queued', 4000, 4000, 4000)`,
    });

    const result = await observeDatabaseAdmissionFor(
      db,
      { action: "acquire", owner: "fluncle-note", runId: "waiting" },
      { monotonicNow: () => 50, serverNowMs: 10_000 },
    );

    expect(result).toMatchObject({
      enforced: false,
      outcome: "shadow-yield",
      queueAgeMs: 6_000,
      yieldReason: "queue",
    });
    const rows = await db.execute(`select contender_id from database_admission_contenders`);
    expect(rows.rows).toEqual([{ contender_id: "held" }]);
  });

  it("gives direct harmless-read latency precedence over health and public guardrails", async () => {
    const monotonicSamples = [10, 10 + DATABASE_ADMISSION_DIRECT_READ_LIMIT_MS + 1];
    const result = await observeDatabaseAdmissionFor(
      db,
      { action: "acquire", owner: "fluncle-backup", runId: "slow-probe" },
      {
        monotonicNow: () => monotonicSamples.shift() ?? 0,
        serverNowMs: 20_000,
      },
    );

    expect(result).toMatchObject({
      lane: "heavy-read",
      outcome: "shadow-yield",
      yieldReason: "direct-read-latency",
    });
  });

  it("observes explicit database-health and public-latency breaches", async () => {
    await db.batch(
      [
        {
          args: ["db", "degraded", "slow", 300, "1970-01-01T00:00:10.000Z"],
          sql: `insert into service_status
            (service, status, message, latency_ms, checked_at, since)
            values (?, ?, ?, ?, ?, '1970-01-01T00:00:10.000Z')`,
        },
        {
          args: ["web", "ok", null, 700, "1970-01-01T00:00:10.000Z"],
          sql: `insert into service_status
            (service, status, message, latency_ms, checked_at, since)
            values (?, ?, ?, ?, ?, '1970-01-01T00:00:10.000Z')`,
        },
      ],
      "write",
    );
    const dependencies = { monotonicNow: () => 0, serverNowMs: 10_000 };

    const unhealthy = await observeDatabaseAdmissionFor(
      db,
      { action: "acquire", owner: "fluncle-enrich", runId: "health" },
      dependencies,
    );
    expect(unhealthy.yieldReason).toBe("database-health");

    await db.execute(
      `update service_status set status = 'ok', latency_ms = 100 where service = 'db'`,
    );
    const publicSlow = await observeDatabaseAdmissionFor(
      db,
      { action: "acquire", owner: "fluncle-enrich", runId: "public" },
      dependencies,
    );
    expect(publicSlow.yieldReason).toBe("public-latency");
  });

  it("keeps heartbeat, release, and cancellation inert in shadow mode", async () => {
    for (const action of ["heartbeat", "release", "cancel"] as const) {
      const result = await observeDatabaseAdmissionFor(db, {
        action,
        fencingToken: 1,
        owner: "fluncle-enrich",
        runId: action,
      });
      expect(result).toMatchObject({ enforced: false, outcome: "shadow-acquire" });
    }

    const rows = await db.execute(`select count(*) as count from database_admission_contenders`);
    expect(rows.rows[0]?.count).toBe(0);
  });
});
