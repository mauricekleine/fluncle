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

/**
 * Insert ONE `tracks` row with a chosen anchor state — the columns the flip-ON requeue reads.
 * ISRC-bearing by default (the requeue targets only `has_isrc = 1` rows; the mirror rides the same
 * insert as its source column, the way every production writer pairs it — schema.ts § `has_isrc`);
 * pass `isrc: null` to seed the excluded ISRC-less shape.
 */
async function seedRow(row: {
  attempts?: null | number;
  attemptedAt: null | string;
  isrc?: null | string;
  spotifyUri: null | string;
  trackId: string;
}): Promise<void> {
  const isrc = row.isrc === undefined ? "GBCJY1300173" : row.isrc;

  await db.execute({
    args: [
      row.trackId,
      JSON.stringify(["Test Artist"]),
      isrc,
      isrc?.trim() ? 1 : 0,
      row.spotifyUri,
      row.attemptedAt,
      row.attempts ?? null,
    ],
    sql: `insert into tracks
            (track_id, title, artists_json, duration_ms, isrc, has_isrc, spotify_uri,
             spotify_anchor_attempted_at, spotify_anchor_attempts)
          values (?, 'Test Track', ?, 270000, ?, ?, ?, ?, ?)`,
  });
}

/** Read a row's `spotify_anchor_attempts` (the retry-cap counter the requeue must NOT touch). */
async function attempts(trackId: string): Promise<null | number> {
  const result = await db.execute({
    args: [trackId],
    sql: "select spotify_anchor_attempts from tracks where track_id = ?",
  });
  const value = result.rows[0]?.spotify_anchor_attempts;

  return value === null || value === undefined ? null : Number(value);
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

  it("(e) flip ON restores the STAMP ALONE — a deferral charged no attempt, so there is none to refund", async () => {
    const { ANCHOR_APIFY_DISABLED_AT_KEY, setAnchorApifyEnabled } = await import("./anchor-apify");
    const { getSetting } = await import("./settings");

    await setAnchorApifyEnabled(false);
    const during = (await getSetting(ANCHOR_APIFY_DISABLED_AT_KEY)) ?? "";

    // Deferred during the outage, having really been attempted 3 times before it. Those three were
    // real asks by a rung that could conclude, and an off-window deferral never spent a fourth —
    // `stampAnchorAttempt`'s `chargeAttempt: false` — so a refund here would erase honest history.
    await seedRow({ attemptedAt: during, attempts: 3, spotifyUri: null, trackId: "deferred" });
    // A never-attempted row deferred during the outage — still never attempted afterwards.
    await seedRow({ attemptedAt: during, attempts: null, spotifyUri: null, trackId: "unstamped" });
    // A genuine pre-off backoff keeps every one of its counted attempts.
    await seedRow({
      attemptedAt: "2026-01-01T00:00:00.000Z",
      attempts: 2,
      spotifyUri: null,
      trackId: "genuine-count",
    });

    await setAnchorApifyEnabled(true);

    // The stamps are what moved; every counter stands exactly where the real asks left it.
    expect(await attemptedAt("deferred")).toBeNull();
    expect(await attempts("deferred")).toBe(3);
    expect(await attempts("unstamped")).toBeNull();
    expect(await attempts("genuine-count")).toBe(2);
  });

  it("(f) an ISRC-less previously-attempted deferral SURVIVES the flip-ON — its stamp stands", async () => {
    const { ANCHOR_APIFY_DISABLED_AT_KEY, setAnchorApifyEnabled } = await import("./anchor-apify");
    const { getSetting } = await import("./settings");

    await setAnchorApifyEnabled(false);
    const during = (await getSetting(ANCHOR_APIFY_DISABLED_AT_KEY)) ?? "";

    // Deferred during the outage after real prior attempts, but ISRC-LESS: anchoring concludes off
    // the ISRC anchor, so the bulk re-arm must NOT put this row back on the paid queue. Its stamp
    // stands and the ordinary re-ask window paces it; the free `isrc-recovery` pass is what moves it.
    await seedRow({
      attemptedAt: during,
      attempts: 2,
      isrc: null,
      spotifyUri: null,
      trackId: "isrcless",
    });
    // An ISRC-bearing sibling deferred in the same window proves the requeue itself still ran.
    await seedRow({ attemptedAt: during, attempts: 2, spotifyUri: null, trackId: "isrc-sibling" });

    const requeued = await setAnchorApifyEnabled(true);

    expect(requeued).toBe(1);
    expect(await attemptedAt("isrcless")).toBe(during);
    expect(await attempts("isrcless")).toBe(2);
    expect(await attemptedAt("isrc-sibling")).toBeNull();
    expect(await attempts("isrc-sibling")).toBe(2);
  });
});

// ── THE DAILY ROW BRAKE ──────────────────────────────────────────────────────────────────────────
//
// The kill-flag above is a switch; this is the NUMBER between its two states, so "Apify runs" stops
// meaning "Apify runs without a limit". Every guarantee here is a statement about the real `settings`
// KV, because that is what the operator flips and what the resolver charges.

describe("the Apify daily row brake", () => {
  const DAY = new Date("2026-09-20T11:00:00Z");

  it("defaults CONSERVATIVE, not unlimited, when nothing is stored", async () => {
    const { ANCHOR_APIFY_DEFAULT_DAILY_ROWS, getAnchorApifyBudget } =
      await import("./anchor-apify");

    // The failure mode of a spend rail has to be the cheap one: an unset key, an empty database and
    // a fresh preview must all read as the default cap, never as "no cap".
    expect(await getAnchorApifyBudget(DAY)).toEqual({
      dailyRows: ANCHOR_APIFY_DEFAULT_DAILY_ROWS,
      day: "2026-09-20",
      remainingRows: ANCHOR_APIFY_DEFAULT_DAILY_ROWS,
      rowsSent: 0,
      spent: false,
    });
  });

  it("reads a stored cap back, and 0 is a legal cap (send nothing)", async () => {
    const { chargeAnchorApifyRow, getAnchorApifyBudget, setAnchorApifyDailyRows } =
      await import("./anchor-apify");

    expect(await setAnchorApifyDailyRows(50, DAY)).toMatchObject({
      dailyRows: 50,
      remainingRows: 50,
      spent: false,
    });

    // `0` is a different statement from the kill-flag being off: the cap can be raised back without
    // touching the switch (the `set_capture_budget` rule).
    expect(await setAnchorApifyDailyRows(0, DAY)).toMatchObject({
      dailyRows: 0,
      remainingRows: 0,
      spent: true,
    });
    expect((await getAnchorApifyBudget(DAY)).spent).toBe(true);
    // …and a cap of 0 REFUSES the very first charge, rather than opening a window above the cap.
    expect(await chargeAnchorApifyRow(DAY)).toMatchObject({
      budget: { remainingRows: 0, rowsSent: 0, spent: true },
      charged: false,
    });
  });

  it("a garbage cap reads as the default rather than as unlimited", async () => {
    const { ANCHOR_APIFY_DAILY_ROWS_KEY, ANCHOR_APIFY_DEFAULT_DAILY_ROWS, getAnchorApifyBudget } =
      await import("./anchor-apify");
    const { setSetting } = await import("./settings");

    await setSetting(ANCHOR_APIFY_DAILY_ROWS_KEY, "lots");

    expect((await getAnchorApifyBudget(DAY)).dailyRows).toBe(ANCHOR_APIFY_DEFAULT_DAILY_ROWS);
  });

  it("charges one row at a time and REFUSES at the cap — the tally never runs past it", async () => {
    const { chargeAnchorApifyRow, getAnchorApifyBudget, setAnchorApifyDailyRows } =
      await import("./anchor-apify");

    await setAnchorApifyDailyRows(2, DAY);

    expect(await chargeAnchorApifyRow(DAY)).toMatchObject({
      budget: { remainingRows: 1, rowsSent: 1, spent: false },
      charged: true,
    });
    expect(await chargeAnchorApifyRow(DAY)).toMatchObject({
      budget: { remainingRows: 0, rowsSent: 2, spent: true },
      charged: true,
    });
    // The third asks for a slot the cap does not have: NOT charged, and the tally stands at the cap.
    expect(await chargeAnchorApifyRow(DAY)).toMatchObject({
      budget: { remainingRows: 0, rowsSent: 2, spent: true },
      charged: false,
    });
    expect((await getAnchorApifyBudget(DAY)).rowsSent).toBe(2);
  });

  it("the tally rolls at UTC midnight without anything sweeping it", async () => {
    const { chargeAnchorApifyRow, getAnchorApifyBudget } = await import("./anchor-apify");

    await chargeAnchorApifyRow(DAY);
    expect((await getAnchorApifyBudget(DAY)).rowsSent).toBe(1);

    // A tally belonging to an EARLIER day reads as zero — the roll is implicit, so no job has to run
    // at midnight and a box that was asleep through it wakes to a correct budget.
    const nextDay = new Date("2026-09-21T00:30:00Z");
    expect(await getAnchorApifyBudget(nextDay)).toMatchObject({
      day: "2026-09-21",
      rowsSent: 0,
      spent: false,
    });
  });

  it("CONCURRENT charges can never breach the cap — the money rail is one atomic statement", async () => {
    const { chargeAnchorApifyRow, getAnchorApifyBudget, setAnchorApifyDailyRows } =
      await import("./anchor-apify");

    // The single-flight assumption is not a guarantee: an operator's attended `--limit` burn
    // overlaps the hourly timer and both reach `resolve_anchor`. A read-then-write tally would lose
    // updates here, and a lost update on a SPEND meter means over-spend. The counter is incremented
    // and enforced by ONE statement, so exactly `cap` of these may pass.
    const cap = 4;
    await setAnchorApifyDailyRows(cap, DAY);

    const results = await Promise.all(Array.from({ length: 25 }, () => chargeAnchorApifyRow(DAY)));

    expect(results.filter((result) => result.charged)).toHaveLength(cap);
    expect((await getAnchorApifyBudget(DAY)).rowsSent).toBe(cap);
    // Every charged call saw a distinct tally value — no two shared a slot.
    const charged = results.filter((result) => result.charged).map((r) => r.budget.rowsSent);
    expect(new Set(charged).size).toBe(cap);
  });

  it("the readout and the charge address the SAME window, so they can never disagree", async () => {
    const { chargeAnchorApifyRow, getAnchorApifyBudget } = await import("./anchor-apify");

    await chargeAnchorApifyRow(DAY);

    // Same instant, same key composition: the display is the counter, not a second opinion of it.
    expect((await getAnchorApifyBudget(DAY)).rowsSent).toBe(1);
    // …and an instant in the SAME UTC day still sees it (the window is the day, not the hour).
    const laterSameDay = new Date("2026-09-20T23:59:00Z");
    expect((await getAnchorApifyBudget(laterSameDay)).rowsSent).toBe(1);
  });

  it("raising the cap mid-day releases the held rows instead of restarting the day", async () => {
    const { chargeAnchorApifyRow, setAnchorApifyDailyRows } = await import("./anchor-apify");

    await setAnchorApifyDailyRows(1, DAY);
    await chargeAnchorApifyRow(DAY);

    expect(await setAnchorApifyDailyRows(3, DAY)).toMatchObject({
      dailyRows: 3,
      // The day's spend is KEPT: the operator raised a ceiling, he did not buy back a morning.
      remainingRows: 2,
      rowsSent: 1,
      spent: false,
    });
  });
});
