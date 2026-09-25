import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb } from "./integration-db";

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

const { deleteSetting, getSetting, setSetting } = await import("./settings");

async function rowsFor(key: string): Promise<number> {
  const result = await db.execute({
    args: [key],
    sql: `select count(*) as n from settings where key = ?`,
  });

  return Number(result.rows[0]?.["n"] ?? -1);
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

describe("the settings KV — get / set / delete", () => {
  it("reads undefined for a key that was never written", async () => {
    expect(await getSetting("catalogue_capture_paused")).toBeUndefined();
  });

  it("round-trips a written value", async () => {
    await setSetting("catalogue_capture_paused", "false");

    expect(await getSetting("catalogue_capture_paused")).toBe("false");
  });

  it("UPSERTS on conflict: a second write replaces the value in ONE row", async () => {
    await setSetting("sonar_sonic_enabled", "true");
    await setSetting("sonar_sonic_enabled", "false");

    expect(await getSetting("sonar_sonic_enabled")).toBe("false");
    expect(await rowsFor("sonar_sonic_enabled")).toBe(1);
  });

  it("deletes a key back to unset", async () => {
    await setSetting("frontier.minting", "true");
    await deleteSetting("frontier.minting");

    expect(await getSetting("frontier.minting")).toBeUndefined();
  });

  it("deletes idempotently — a second delete is a clean no-op", async () => {
    await setSetting("anchor_apify_disabled_at", "2026-07-26T00:00:00.000Z");
    await deleteSetting("anchor_apify_disabled_at");

    await expect(deleteSetting("anchor_apify_disabled_at")).resolves.toBeUndefined();
    expect(await getSetting("anchor_apify_disabled_at")).toBeUndefined();
  });

  it("deleting a key that was never set is a clean no-op", async () => {
    await expect(deleteSetting("never-written")).resolves.toBeUndefined();
  });

  it("keeps keys independent — one flip never disturbs another", async () => {
    await setSetting("clip_drip_paused", "true");
    await setSetting("publish_advance_paused", "false");
    await deleteSetting("clip_drip_paused");

    expect(await getSetting("clip_drip_paused")).toBeUndefined();
    expect(await getSetting("publish_advance_paused")).toBe("false");
  });

  it("stores an empty string as a PRESENT value, distinct from unset", async () => {
    await setSetting("apple_auth_breaker_tripped_at", "");

    expect(await getSetting("apple_auth_breaker_tripped_at")).toBe("");
    expect(await rowsFor("apple_auth_breaker_tripped_at")).toBe(1);
  });

  it("carries a JSON blob verbatim (the catalogue caches' shape)", async () => {
    const blob = JSON.stringify({ awaitingCapture: 12, computedAt: "2026-07-26T00:00:00.000Z" });

    await setSetting("catalogue_summary_cache", blob);

    expect(await getSetting("catalogue_summary_cache")).toBe(blob);
  });
});
