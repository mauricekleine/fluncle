import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb } from "./integration-db";

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

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

async function attempts(trackId: string): Promise<null | number> {
  const result = await db.execute({
    args: [trackId],
    sql: "select spotify_anchor_attempts from tracks where track_id = ?",
  });
  const value = result.rows[0]?.spotify_anchor_attempts;

  return value === null || value === undefined ? null : Number(value);
}

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

    await setSetting(ANCHOR_APIFY_ENABLED_KEY, "yes");
    expect(await isAnchorApifyEnabled()).toBe(true);

    await setSetting(ANCHOR_APIFY_ENABLED_KEY, "");
    expect(await isAnchorApifyEnabled()).toBe(true);

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

    expect(typeof marker).toBe("string");
    expect(marker).toBe(new Date(marker ?? "").toISOString());
  });

  it("(b) OFF→OFF keeps the EARLIEST off-time — only the on→off transition stamps it", async () => {
    const { ANCHOR_APIFY_DISABLED_AT_KEY, setAnchorApifyEnabled } = await import("./anchor-apify");
    const { getSetting, setSetting } = await import("./settings");

    const earliest = "2026-07-01T00:00:00.000Z";
    await setSetting(ANCHOR_APIFY_DISABLED_AT_KEY, earliest);

    await setAnchorApifyEnabled(false);

    expect(await getSetting(ANCHOR_APIFY_DISABLED_AT_KEY)).toBe(earliest);
  });

  it("(c) flip ON clears ONLY the off-window deferrals — pre-window backoffs + anchored rows untouched", async () => {
    const { ANCHOR_APIFY_DISABLED_AT_KEY, setAnchorApifyEnabled } = await import("./anchor-apify");
    const { getSetting } = await import("./settings");

    await setAnchorApifyEnabled(false);
    const marker = await getSetting(ANCHOR_APIFY_DISABLED_AT_KEY);
    expect(typeof marker).toBe("string");
    const disabledAt = marker ?? "";
    const duringLater = new Date(Date.parse(disabledAt) + 1000).toISOString();
    const duringMuchLater = new Date(Date.parse(disabledAt) + 6 * 60 * 60 * 1000).toISOString();

    await seedRow({ attemptedAt: "2026-01-01T00:00:00.000Z", spotifyUri: null, trackId: "pre" });

    await seedRow({ attemptedAt: duringLater, spotifyUri: null, trackId: "during-1" });

    await seedRow({ attemptedAt: disabledAt, spotifyUri: null, trackId: "during-boundary" });

    await seedRow({
      attemptedAt: duringMuchLater,
      spotifyUri: "spotify:track:anchored",
      trackId: "anchored-during",
    });

    const requeued = await setAnchorApifyEnabled(true);

    expect(requeued).toBe(2);
    expect(await attemptedAt("during-1")).toBeNull();
    expect(await attemptedAt("during-boundary")).toBeNull();

    expect(await attemptedAt("pre")).toBe("2026-01-01T00:00:00.000Z");

    expect(await attemptedAt("anchored-during")).toBe(duringMuchLater);

    expect(await getSetting(ANCHOR_APIFY_DISABLED_AT_KEY)).toBeUndefined();
  });

  it("(d) flip ON with no off-window recorded touches no rows (a clean no-op)", async () => {
    const { setAnchorApifyEnabled } = await import("./anchor-apify");

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

    await seedRow({ attemptedAt: during, attempts: 3, spotifyUri: null, trackId: "deferred" });

    await seedRow({ attemptedAt: during, attempts: null, spotifyUri: null, trackId: "unstamped" });

    await seedRow({
      attemptedAt: "2026-01-01T00:00:00.000Z",
      attempts: 2,
      spotifyUri: null,
      trackId: "genuine-count",
    });

    await setAnchorApifyEnabled(true);

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

    await seedRow({
      attemptedAt: during,
      attempts: 2,
      isrc: null,
      spotifyUri: null,
      trackId: "isrcless",
    });

    await seedRow({ attemptedAt: during, attempts: 2, spotifyUri: null, trackId: "isrc-sibling" });

    const requeued = await setAnchorApifyEnabled(true);

    expect(requeued).toBe(1);
    expect(await attemptedAt("isrcless")).toBe(during);
    expect(await attempts("isrcless")).toBe(2);
    expect(await attemptedAt("isrc-sibling")).toBeNull();
    expect(await attempts("isrc-sibling")).toBe(2);
  });
});

describe("the Apify daily row brake", () => {
  const DAY = new Date("2026-09-20T11:00:00Z");

  it("defaults CONSERVATIVE, not unlimited, when nothing is stored", async () => {
    const { ANCHOR_APIFY_DEFAULT_DAILY_ROWS, getAnchorApifyBudget } =
      await import("./anchor-apify");

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

    expect(await setAnchorApifyDailyRows(0, DAY)).toMatchObject({
      dailyRows: 0,
      remainingRows: 0,
      spent: true,
    });
    expect((await getAnchorApifyBudget(DAY)).spent).toBe(true);

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

    const cap = 4;
    await setAnchorApifyDailyRows(cap, DAY);

    const results = await Promise.all(Array.from({ length: 25 }, () => chargeAnchorApifyRow(DAY)));

    expect(results.filter((result) => result.charged)).toHaveLength(cap);
    expect((await getAnchorApifyBudget(DAY)).rowsSent).toBe(cap);

    const charged = results.filter((result) => result.charged).map((r) => r.budget.rowsSent);
    expect(new Set(charged).size).toBe(cap);
  });

  it("the readout and the charge address the SAME window, so they can never disagree", async () => {
    const { chargeAnchorApifyRow, getAnchorApifyBudget } = await import("./anchor-apify");

    await chargeAnchorApifyRow(DAY);

    expect((await getAnchorApifyBudget(DAY)).rowsSent).toBe(1);

    const laterSameDay = new Date("2026-09-20T23:59:00Z");
    expect((await getAnchorApifyBudget(laterSameDay)).rowsSent).toBe(1);
  });

  it("raising the cap mid-day releases the held rows instead of restarting the day", async () => {
    const { chargeAnchorApifyRow, setAnchorApifyDailyRows } = await import("./anchor-apify");

    await setAnchorApifyDailyRows(1, DAY);
    await chargeAnchorApifyRow(DAY);

    expect(await setAnchorApifyDailyRows(3, DAY)).toMatchObject({
      dailyRows: 3,

      remainingRows: 2,
      rowsSent: 1,
      spent: false,
    });
  });
});
