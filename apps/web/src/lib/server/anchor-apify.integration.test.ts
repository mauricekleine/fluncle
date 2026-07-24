import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb } from "./integration-db";

// SLICE 3 — the APIFY KILL-FLAG's read/write semantics, against the REAL `settings` KV. This is the
// exact contract the `set_anchor_apify` operator op is a thin wrapper over: `setAnchorApifyEnabled`
// writes the real `settings` row and `isAnchorApifyEnabled` reads it back — so one op call both writes
// and reads back the flag. The load-bearing difference from the DEFAULT-OFF dark flags is proven here:
// this flag is DEFAULT ON, so only the literal string "false" disables it and a lost/unknown row reads
// as ENABLED (the paid rung is never silently starved). The database is the real thing (in-memory
// libSQL with the generated migrations), reached through the same `getDb` mock the sibling anchor
// integration tests use.

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

/** Insert ONE `tracks` row with a chosen anchor state — the columns the flip-ON requeue reads. */
async function seedRow(row: {
  attemptedAt: null | string;
  spotifyUri: null | string;
  trackId: string;
}): Promise<void> {
  await db.execute({
    args: [row.trackId, JSON.stringify(["Test Artist"]), row.spotifyUri, row.attemptedAt],
    sql: `insert into tracks
            (track_id, title, artists_json, duration_ms, spotify_uri, spotify_anchor_attempted_at)
          values (?, 'Test Track', ?, 270000, ?, ?)`,
  });
}

/** Read a row's `spotify_anchor_attempted_at` (the re-ask backoff stamp the requeue clears). */
async function attemptedAt(trackId: string): Promise<unknown> {
  const result = await db.execute({
    args: [trackId],
    sql: "select spotify_anchor_attempted_at from tracks where track_id = ?",
  });

  return result.rows[0]?.spotify_anchor_attempted_at;
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

describe("anchor_apify_enabled — the default-ON kill-flag", () => {
  it("reads ON when the row is unset (an empty database defaults to the paid rung ENABLED)", async () => {
    const { isAnchorApifyEnabled } = await import("./anchor-apify");

    expect(await isAnchorApifyEnabled()).toBe(true);
  });

  it("write false → reads back false; write true → reads back true (the op's write+read-back)", async () => {
    const { isAnchorApifyEnabled, setAnchorApifyEnabled } = await import("./anchor-apify");

    await setAnchorApifyEnabled(false);
    expect(await isAnchorApifyEnabled()).toBe(false);

    await setAnchorApifyEnabled(true);
    expect(await isAnchorApifyEnabled()).toBe(true);
  });

  it("reads ON for any value that is not the literal 'false' (default-ALLOW, never default-deny)", async () => {
    const { ANCHOR_APIFY_ENABLED_KEY, isAnchorApifyEnabled } = await import("./anchor-apify");
    const { setSetting } = await import("./settings");

    // A malformed/unrecognised value must NOT silently disable the paid rung — only "false" does.
    await setSetting(ANCHOR_APIFY_ENABLED_KEY, "yes");
    expect(await isAnchorApifyEnabled()).toBe(true);

    await setSetting(ANCHOR_APIFY_ENABLED_KEY, "");
    expect(await isAnchorApifyEnabled()).toBe(true);

    // Only the exact string "false" is the OFF signal.
    await setSetting(ANCHOR_APIFY_ENABLED_KEY, "false");
    expect(await isAnchorApifyEnabled()).toBe(false);
  });
});

describe("anchor_apify_disabled_at — the off-window marker + flip-ON requeue", () => {
  it("(a) flip OFF records the off-window start (an ISO timestamp)", async () => {
    const { ANCHOR_APIFY_DISABLED_AT_KEY, setAnchorApifyEnabled } = await import("./anchor-apify");
    const { getSetting } = await import("./settings");

    expect(await getSetting(ANCHOR_APIFY_DISABLED_AT_KEY)).toBeUndefined();

    await setAnchorApifyEnabled(false);

    const marker = await getSetting(ANCHOR_APIFY_DISABLED_AT_KEY);
    // Written, and in the SAME ISO-8601 shape as `spotify_anchor_attempted_at` (so the requeue's
    // `>=` comparison is lexicographic-as-chronological against it).
    expect(typeof marker).toBe("string");
    expect(marker).toBe(new Date(marker ?? "").toISOString());
  });

  it("(b) OFF→OFF keeps the EARLIEST off-time — only the on→off transition stamps it", async () => {
    const { ANCHOR_APIFY_DISABLED_AT_KEY, setAnchorApifyEnabled } = await import("./anchor-apify");
    const { getSetting, setSetting } = await import("./settings");

    // Pin a known earlier marker, then flip OFF again (already off): the second OFF must NOT overwrite
    // it, so the window keeps covering the whole outage from its true start.
    const earliest = "2026-07-01T00:00:00.000Z";
    await setSetting(ANCHOR_APIFY_DISABLED_AT_KEY, earliest);

    await setAnchorApifyEnabled(false);

    expect(await getSetting(ANCHOR_APIFY_DISABLED_AT_KEY)).toBe(earliest);
  });

  it("(c) flip ON clears ONLY the off-window deferrals — pre-window backoffs + anchored rows untouched", async () => {
    const { ANCHOR_APIFY_DISABLED_AT_KEY, setAnchorApifyEnabled } = await import("./anchor-apify");
    const { getSetting } = await import("./settings");

    // The box went OFF at this moment (recorded via the real flip-OFF below).
    await setAnchorApifyEnabled(false);
    const marker = await getSetting(ANCHOR_APIFY_DISABLED_AT_KEY);
    expect(typeof marker).toBe("string");
    const disabledAt = marker ?? "";
    const duringLater = new Date(Date.parse(disabledAt) + 1000).toISOString();
    const duringMuchLater = new Date(Date.parse(disabledAt) + 6 * 60 * 60 * 1000).toISOString();

    // A GENUINE pre-off Apify backoff — stamped well before the off-window. Must be UNTOUCHED.
    await seedRow({ attemptedAt: "2026-01-01T00:00:00.000Z", spotifyUri: null, trackId: "pre" });
    // Two off-window DEFERRALS — un-anchored rows stamped during the outage. Must be CLEARED.
    await seedRow({ attemptedAt: duringLater, spotifyUri: null, trackId: "during-1" });
    // …including one stamped at the EXACT off-window start, to prove the `>=` boundary.
    await seedRow({ attemptedAt: disabledAt, spotifyUri: null, trackId: "during-boundary" });
    // An ANCHORED row stamped during the window — the requeue targets un-anchored rows only, so its
    // stamp must survive (proves the `spotify_uri is null` guard).
    await seedRow({
      attemptedAt: duringMuchLater,
      spotifyUri: "spotify:track:anchored",
      trackId: "anchored-during",
    });

    const requeued = await setAnchorApifyEnabled(true);

    // Exactly the two un-anchored off-window deferrals were re-queued.
    expect(requeued).toBe(2);
    expect(await attemptedAt("during-1")).toBeNull();
    expect(await attemptedAt("during-boundary")).toBeNull();
    // The genuine pre-off backoff is provably untouched — its real 14-day backoff still runs.
    expect(await attemptedAt("pre")).toBe("2026-01-01T00:00:00.000Z");
    // The anchored row's stamp survives (un-anchored rows only).
    expect(await attemptedAt("anchored-during")).toBe(duringMuchLater);
    // The marker is cleared once the requeue has run.
    expect(await getSetting(ANCHOR_APIFY_DISABLED_AT_KEY)).toBeUndefined();
  });

  it("(d) flip ON with no off-window recorded touches no rows (a clean no-op)", async () => {
    const { setAnchorApifyEnabled } = await import("./anchor-apify");

    // No marker set (the flag was already on / never went off). An un-anchored row that carries a
    // genuine backoff stamp must NOT be disturbed by a flip-ON that has no off-window to undo.
    await seedRow({
      attemptedAt: "2026-05-01T00:00:00.000Z",
      spotifyUri: null,
      trackId: "genuine",
    });

    const requeued = await setAnchorApifyEnabled(true);

    expect(requeued).toBe(0);
    expect(await attemptedAt("genuine")).toBe("2026-05-01T00:00:00.000Z");
  });
});
