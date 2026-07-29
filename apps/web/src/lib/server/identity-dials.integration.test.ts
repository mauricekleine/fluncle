// THE IDENTITY DIALS, THE COUNTER PRUNE, AND THE ABUSE ALERT (RFC dnb-identity-graph, ruling 8),
// against the REAL `rate_limit_counters` table on an in-memory libSQL engine.
//
// The three claims here are the ones a mocked test cannot make:
//
//   - THE DIALS ACTUALLY REFUSE, on the real atomic upsert, at the real numbers, keyed on the
//     non-forgeable `cf-connecting-ip` bucket — and one caller's burst does not spend another's;
//   - THE PRUNE ACTUALLY DELETES. Nothing deleted from that table before this wave, so the first
//     thing worth proving about the prune is that a row goes away and a live window does not;
//   - THE ALERT FIRES. A detector nobody has watched fire is a detector nobody knows works, so a
//     SYNTHETIC run of refusals is driven through the counter and the alarm is caught at the
//     threshold — once, not once per refusal after it.

import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

const captureMessage = vi.fn();

vi.mock("@sentry/cloudflare", () => ({
  captureMessage: (...args: unknown[]) => captureMessage(...args),
}));

import {
  assertIdentityReadAllowed,
  IDENTITY_ABUSE_ALERT_AT,
  IDENTITY_BURST_LIMIT,
  IDENTITY_DAILY_LIMIT,
  noteIdentityReadBlocked,
} from "./identity-dials";
import { createIntegrationDb } from "./integration-db";
import { pruneRateLimitCounters, rateLimitBucket } from "./rate-limit";

let db: Client;

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
  captureMessage.mockClear();
});

/** A request carrying the one client-IP header Cloudflare does not let a caller forge. */
function fromIp(ip: string): Request {
  return new Request("https://www.fluncle.com/api/v1/tracks/-?isrc=GBABC1234567", {
    headers: { "cf-connecting-ip": ip },
  });
}

async function counterRows(action: string): Promise<number> {
  const result = await db.execute({
    args: [action],
    sql: `select count(*) as n from rate_limit_counters where action = ?`,
  });

  return Number(result.rows[0]?.n ?? 0);
}

describe("the burst dial", () => {
  it("allows the ceiling and refuses the one past it", async () => {
    const request = fromIp("1.1.1.1");

    for (let i = 0; i < IDENTITY_BURST_LIMIT; i += 1) {
      await expect(assertIdentityReadAllowed(request)).resolves.toBeUndefined();
    }

    await expect(assertIdentityReadAllowed(request)).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
    });
  });

  it("keys on the caller, so one IP's burst never spends another's", async () => {
    for (let i = 0; i < IDENTITY_BURST_LIMIT; i += 1) {
      await assertIdentityReadAllowed(fromIp("1.1.1.1"));
    }

    await expect(assertIdentityReadAllowed(fromIp("1.1.1.1"))).rejects.toMatchObject({
      status: 429,
    });
    // A different caller starts clean.
    await expect(assertIdentityReadAllowed(fromIp("2.2.2.2"))).resolves.toBeUndefined();
  });

  it("does not charge the daily ceiling for a request the burst dial already refused", async () => {
    const request = fromIp("3.3.3.3");

    for (let i = 0; i < IDENTITY_BURST_LIMIT + 5; i += 1) {
      await assertIdentityReadAllowed(request).catch(() => undefined);
    }

    const daily = await db.execute({
      args: ["get_track_identity_daily"],
      sql: `select count as n from rate_limit_counters where action = ? limit 1`,
    });

    // Exactly the allowed ones reached the ceiling; the five refusals did not eat a day's budget.
    expect(Number(daily.rows[0]?.n)).toBe(IDENTITY_BURST_LIMIT);
  });

  it("refuses on the DAILY ceiling even when the burst dial is wide open", async () => {
    // The daily ceiling sits far above the burst one, so a test cannot walk to it through the
    // public path. Seed that caller's day at its cap — in the REAL bucket the limiter derives, not
    // a stand-in — and prove the second gate closes on a first request of the minute.
    const request = fromIp("4.4.4.4");
    const window = 24 * 60 * 60 * 1000;

    await db.execute({
      args: [
        "get_track_identity_daily",
        rateLimitBucket(request),
        new Date(Math.floor(Date.now() / window) * window).toISOString(),
        IDENTITY_DAILY_LIMIT,
      ],
      sql: `insert into rate_limit_counters (action, bucket, window_start, count) values (?, ?, ?, ?)`,
    });

    await expect(assertIdentityReadAllowed(request)).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
    });
  });
});

describe("the abuse alert", () => {
  it("fires exactly once, at the threshold, on a synthetic run of refusals", async () => {
    // THE TRIPWIRE, TESTED. Refusals are counted in their own row precisely because the limiter's
    // own counter STOPS at its cap — a bucket that keeps knocking looks identical to one that gave
    // up. This drives the synthetic failure and catches the alarm.
    for (let i = 0; i < IDENTITY_ABUSE_ALERT_AT - 1; i += 1) {
      await noteIdentityReadBlocked("hashed-bucket");
    }

    expect(captureMessage).not.toHaveBeenCalled();

    await noteIdentityReadBlocked("hashed-bucket");

    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage.mock.calls[0]?.[1]).toMatchObject({
      level: "warning",
      tags: { bucket: "hashed-bucket", source: "identity.abuse" },
    });

    // And it does NOT keep firing: one alarm per caller per day, not one per refusal after it.
    await noteIdentityReadBlocked("hashed-bucket");
    await noteIdentityReadBlocked("hashed-bucket");

    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it("counts each caller separately", async () => {
    for (let i = 0; i < IDENTITY_ABUSE_ALERT_AT; i += 1) {
      await noteIdentityReadBlocked("bucket-a");
      await noteIdentityReadBlocked("bucket-b");
    }

    expect(captureMessage).toHaveBeenCalledTimes(2);
  });
});

describe("the counter prune", () => {
  it("deletes spent windows and leaves live ones alone", async () => {
    const now = Date.now();
    const stale = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    const live = new Date(now).toISOString();

    await db.batch(
      [
        {
          args: ["old_action", "b1", stale],
          sql: `insert into rate_limit_counters (action, bucket, window_start, count) values (?, ?, ?, 5)`,
        },
        {
          args: ["live_action", "b1", live],
          sql: `insert into rate_limit_counters (action, bucket, window_start, count) values (?, ?, ?, 5)`,
        },
      ],
      "write",
    );

    expect(await pruneRateLimitCounters(now)).toBe(1);
    expect(await counterRows("old_action")).toBe(0);
    expect(await counterRows("live_action")).toBe(1);
  });

  it("is a safe no-op on an empty table", async () => {
    expect(await pruneRateLimitCounters()).toBe(0);
  });
});
