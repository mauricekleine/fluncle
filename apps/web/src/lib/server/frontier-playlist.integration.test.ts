import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, rowCount, seedUser } from "./integration-db";
import { type PublicUser } from "./public-auth";

// FLUNCLE'S FRONTIER — the per-user machinery, PROVEN against the REAL generated schema
// (the editions integration discipline). This covers the RFC's draft-then-checkpoint model
// (docs/rfcs/frontier-shelf-from-editions-rfc.md):
//
//   - D1 DECOUPLE: the edition (the internal cache, the shelf's source of truth) is written
//     ALWAYS; the Spotify mirror is the only thing the kill switch gates.
//   - D2 TRIGGERS: "Get playlist" births edition #1 even with minting dark (status
//     `edition_only`); the weekly sweep writes the next edition for every user WITH an
//     edition regardless of the switch, and SKIPS a draft-phase (zero-edition) user; the
//     identical-desired-list hash-skip survives (no new edition, no Spotify write).
//
// The engine (`listRecommendations`) and Spotify are MOCKED so the test controls the desired
// list and pins BEHAVIOUR, not the vendor; the DATABASE is real, so the edition idempotence,
// the freeze/read of similarity + seeds meta, and the sweep's edition-scoped walk run through
// real SQL on a real libSQL engine built from the generated migrations.

let db: Client;

/** A rec row rich enough to freeze — desiredUrisFor reads the whole thing. */
type RecRow = {
  artists: string[];
  bpm?: number;
  durationMs?: number;
  imageUrl?: string;
  key?: string;
  logId?: string;
  similarity?: number;
  spotifyUri?: string;
  spotifyUrl?: string;
  title: string;
  trackId: string;
};

type RecResult = {
  catalogue: RecRow[];
  findings: RecRow[];
  seedsSkipped: string[];
  seedsUsed: number;
};

const settings = new Map<string, string>();
const spotifyCalls: { init?: RequestInit; path: string }[] = [];
let recs: RecResult | Response = { catalogue: [], findings: [], seedsSkipped: [], seedsUsed: 0 };
let failFetch = false;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

vi.mock("./settings", () => ({
  getSetting: vi.fn((key: string) => Promise.resolve(settings.get(key))),
  setSetting: vi.fn((key: string, value: string) => {
    settings.set(key, value);

    return Promise.resolve();
  }),
}));

vi.mock("./log", () => ({ logEvent: vi.fn() }));

vi.mock("./recommendations", () => ({
  listRecommendations: vi.fn(() => Promise.resolve(recs)),
}));

vi.mock("./spotify", () => ({
  getSpotifyAccessToken: vi.fn(() => Promise.resolve("token")),
  spotifyFetch: vi.fn((path: string, _token: string, init?: RequestInit) => {
    spotifyCalls.push({ init, path });

    if (failFetch) {
      return Promise.reject(new Error("spotify down"));
    }

    // The create — `POST /me/playlists` (the Feb-2026 migration endpoint).
    if (path === "/me/playlists") {
      return Promise.resolve(new Response(JSON.stringify({ id: "pl-new" })));
    }

    return Promise.resolve(new Response("{}"));
  }),
}));

/** A recommended FINDING row — realistic defaults (artists is always present in prod). */
function find(id: string, extra: Partial<RecRow> = {}): RecRow {
  return {
    artists: ["Finding Artist"],
    logId: `${id}.1.1A`,
    similarity: 0.9,
    spotifyUri: uri(id),
    title: `Finding ${id}`,
    trackId: `t-find-${id}`,
    ...extra,
  };
}

/** A recommended CATALOGUE row — realistic defaults; coordinate-less. */
function cat(id: string, extra: Partial<RecRow> = {}): RecRow {
  return {
    artists: ["Catalogue Artist"],
    similarity: 0.8,
    spotifyUri: uri(id),
    title: `Catalogue ${id}`,
    trackId: `t-cat-${id}`,
    ...extra,
  };
}

/** Build the engine result, defaulting the seed accounting to something honest. */
function result(parts: Partial<RecResult>): RecResult {
  const findings = parts.findings ?? [];
  const catalogue = parts.catalogue ?? [];

  return {
    catalogue,
    findings,
    seedsSkipped: parts.seedsSkipped ?? [],
    seedsUsed: parts.seedsUsed ?? 1,
  };
}

function makeUser(overrides: Partial<PublicUser> & { id: string }): PublicUser {
  return {
    createdAt: new Date().toISOString(),
    email: "u@fluncle.com",
    emailVerified: true,
    name: "A User",
    ...overrides,
  };
}

function uri(id: string): string {
  return `spotify:track:${id}`;
}

/** Longer than the ~6-day paced-drain due-gate — advance `now` by this so a just-processed
 * user is DUE again for the sweep (the drain otherwise rotates past a fresh stamp). */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Exhaust the shared Spotify budget window at `nowMs` — the meter's KV keys, pre-filled to
 * the ceiling so `isSpotifyCallBudgetAvailable(nowMs)` reads false (a spent window). */
function exhaustSpotifyBudget(nowMs: number): void {
  settings.set("spotify_calls_window_start", new Date(nowMs).toISOString());
  settings.set("spotify_calls_window_count", "24");
}

/** The live Spotify-call count in the meter's current window (0 when the window rolled). */
function spotifyBudgetCount(nowMs: number): number {
  const start = settings.get("spotify_calls_window_start");
  const startMs = start ? Date.parse(start) : Number.NaN;

  if (!Number.isFinite(startMs) || nowMs - startMs >= 30 * 1000) {
    return 0;
  }

  return Number(settings.get("spotify_calls_window_count") ?? "0");
}

/** Whether the user has a paced-drain cursor row (they have been processed at least once). */
async function hasRefreshCursor(userId: string): Promise<boolean> {
  const query = await db.execute({
    args: [userId],
    sql: `select 1 from user_frontier_refresh where user_id = ? limit 1`,
  });

  return query.rows.length > 0;
}

/** How many editions a user has (the edition ledger, read directly). */
async function editionCount(userId: string): Promise<number> {
  const query = await db.execute({
    args: [userId],
    sql: `select count(*) as n from frontier_editions where user_id = ?`,
  });

  return Number(query.rows[0]?.n ?? 0);
}

/** Whether the user has a Spotify playlist row (the mirror's record). */
async function hasPlaylistRow(userId: string): Promise<boolean> {
  const query = await db.execute({
    args: [userId],
    sql: `select 1 from user_frontier_playlists where user_id = ? limit 1`,
  });

  return query.rows.length > 0;
}

async function coverStamp(userId: string): Promise<unknown> {
  const query = await db.execute({
    args: [userId],
    sql: `select cover_uploaded_at from user_frontier_playlists where user_id = ?`,
  });

  return query.rows[0]?.cover_uploaded_at ?? null;
}

async function insertPlaylistRow(
  userId: string,
  playlistId: string,
  createdAt: string,
): Promise<void> {
  await db.execute({
    args: [userId, playlistId, createdAt],
    sql: `insert into user_frontier_playlists (user_id, playlist_id, created_at) values (?, ?, ?)`,
  });
}

beforeEach(async () => {
  db = await createIntegrationDb();
  settings.clear();
  spotifyCalls.length = 0;
  recs = { catalogue: [], findings: [], seedsSkipped: [], seedsUsed: 0 };
  failFetch = false;
});

describe("the kill switch (default-deny) — D1: the edition is never gated", () => {
  it('only the literal string "true" opens minting', async () => {
    const { isFrontierMintingOpen } = await import("./frontier-playlist");

    settings.set("frontier.minting", "false");
    expect(await isFrontierMintingOpen()).toBe(false);
    settings.set("frontier.minting", "1");
    expect(await isFrontierMintingOpen()).toBe(false);
    settings.set("frontier.minting", "true");
    expect(await isFrontierMintingOpen()).toBe(true);
  });

  it("a dark switch still BIRTHS edition #1 (status edition_only, NO Spotify call)", async () => {
    const { mintOrRefreshFrontierPlaylist } = await import("./frontier-playlist");

    // Minting unset ⇒ default-deny closed.
    recs = result({ findings: [find("f1")] });

    const synced = await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1" }));

    // The user's explicit act checkpoints an edition — no longer a silent no-op.
    expect(synced).toEqual({ ok: true, status: "edition_only" });
    expect(spotifyCalls).toEqual([]);
    expect(await editionCount("u1")).toBe(1);
    // No Spotify playlist row: the mirror was skipped, only the internal cache landed.
    expect(await hasPlaylistRow("u1")).toBe(false);
  });

  it("a dark switch with an UNCHANGED desired list writes NO new edition (status unchanged)", async () => {
    const { mintOrRefreshFrontierPlaylist } = await import("./frontier-playlist");

    recs = result({ findings: [find("f1")] });

    // Birth #1.
    await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1" }));
    // Same list again — the internal hash-skip fires.
    const second = await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1" }));

    expect(second).toEqual({ ok: true, status: "unchanged" });
    expect(await editionCount("u1")).toBe(1);
  });

  it("a dark switch with a CHANGED desired list writes the next edition (status edition_only)", async () => {
    const { mintOrRefreshFrontierPlaylist } = await import("./frontier-playlist");

    recs = result({ findings: [find("f1")] });
    await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1" }));

    recs = result({ findings: [find("f2")] });
    const synced = await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1" }));

    expect(synced).toEqual({ ok: true, status: "edition_only" });
    expect(await editionCount("u1")).toBe(2);
    expect(spotifyCalls).toEqual([]);
  });
});

describe("mint (minting open) — create-once + the URI order", () => {
  beforeEach(() => settings.set("frontier.minting", "true"));

  it("creates a PUBLIC playlist once, findings first then catalogue, de-duped, and is idempotent", async () => {
    const { mintOrRefreshFrontierPlaylist } = await import("./frontier-playlist");

    // `dup` appears in BOTH registers → must be de-duped, keeping the findings slot.
    recs = result({
      catalogue: [cat("cat1"), cat("dup")],
      findings: [find("find1"), find("dup")],
      seedsUsed: 2,
    });

    const first = await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1", username: "alice" }));

    expect(first).toMatchObject({ ok: true, status: "minted" });
    expect(first).toMatchObject({ playlistUrl: "https://open.spotify.com/playlist/pl-new" });
    expect(await editionCount("u1")).toBe(1);
    expect(await hasPlaylistRow("u1")).toBe(true);

    const create = spotifyCalls.find((call) => call.path === "/me/playlists");
    expect(JSON.parse((create?.init?.body as string) ?? "{}")).toMatchObject({ public: true });

    const put = spotifyCalls.find((call) => call.init?.method === "PUT");
    expect(JSON.parse((put?.init?.body as string) ?? "{}").uris).toEqual([
      uri("find1"),
      uri("dup"),
      uri("cat1"),
    ]);

    // A second mint with the SAME recs is a no-op — one create total, no new edition.
    spotifyCalls.length = 0;
    const second = await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1", username: "alice" }));

    expect(second).toMatchObject({ status: "unchanged" });
    expect(spotifyCalls).toEqual([]);
    expect(await editionCount("u1")).toBe(1);
  });

  it("personalizes the description with the @handle (sentence case, no em dashes, ≤300)", async () => {
    const { frontierDescription } = await import("./frontier-playlist");

    const desc = frontierDescription(makeUser({ id: "u1", username: "alice" }));

    expect(desc).toBe(
      "Dug for @alice from the far side of the archive. Refreshed weekly. fluncle.com",
    );
    expect(desc.length).toBeLessThanOrEqual(300);
    expect(desc).not.toContain("—");
    expect(frontierDescription(makeUser({ id: "u2" }))).toContain("Dug for the crew ");
  });
});

describe("refresh (the mirror guard, minting open)", () => {
  beforeEach(() => settings.set("frontier.minting", "true"));

  it("an unchanged item list skips the PUT entirely (zero Spotify calls)", async () => {
    const { mintOrRefreshFrontierPlaylist } = await import("./frontier-playlist");

    recs = result({ catalogue: [cat("cat1")], findings: [find("find1")] });
    // Mint first, then re-run with the identical list.
    await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1", username: "bob" }));
    spotifyCalls.length = 0;

    const synced = await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1", username: "bob" }));

    expect(synced).toMatchObject({ playlistUrl: expect.any(String), status: "unchanged" });
    expect(spotifyCalls).toEqual([]);
  });

  it("a changed item list full-replaces and writes the next edition", async () => {
    const { mintOrRefreshFrontierPlaylist } = await import("./frontier-playlist");

    recs = result({ catalogue: [cat("cat1")], findings: [find("find1")] });
    await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1", username: "bob" }));
    spotifyCalls.length = 0;

    recs = result({ catalogue: [cat("cat2")], findings: [find("find1")] });
    const synced = await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1", username: "bob" }));

    expect(synced).toMatchObject({ status: "refreshed" });
    expect(await editionCount("u1")).toBe(2);
    const put = spotifyCalls.find(
      (call) => call.path === "/playlists/pl-new/items" && call.init?.method === "PUT",
    );
    expect(JSON.parse((put?.init?.body as string) ?? "{}").uris).toEqual([
      uri("find1"),
      uri("cat2"),
    ]);
  });

  it("a Spotify failure reports { ok: false } and never throws — the edition is already durable", async () => {
    const { mintOrRefreshFrontierPlaylist } = await import("./frontier-playlist");

    recs = result({ findings: [find("find1")] });
    failFetch = true;

    const synced = await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1" }));

    expect(synced).toMatchObject({ ok: false });
    // The edition (the shelf's source of truth) landed BEFORE the mirror was attempted, so a
    // Spotify hiccup never costs the shelf its data. No playlist row, though.
    expect(await editionCount("u1")).toBe(1);
    expect(await hasPlaylistRow("u1")).toBe(false);
  });
});

describe("the edition freeze — similarity + seeds meta (D4)", () => {
  beforeEach(() => settings.set("frontier.minting", "true"));

  it("freezes per-row similarity and the edition's seed accounting, read back through the store", async () => {
    const { mintOrRefreshFrontierPlaylist } = await import("./frontier-playlist");
    const { getFrontierEdition } = await import("./frontier-editions");

    recs = result({
      catalogue: [cat("cat1", { similarity: 0.77 })],
      findings: [find("find1", { similarity: 0.94 })],
      seedsSkipped: ["seed-x"],
      seedsUsed: 2,
    });

    await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1" }));

    const edition = await getFrontierEdition("u1", 1);
    expect(edition?.summary.seedsUsed).toBe(2);
    expect(edition?.summary.seedsSkipped).toEqual(["seed-x"]);
    // Position order: the finding slot first, then catalogue.
    expect(edition?.tracks[0]?.similarity).toBeCloseTo(0.94, 4);
    expect(edition?.tracks[1]?.similarity).toBeCloseTo(0.77, 4);
  });
});

describe("the rolling daily mint cap", () => {
  beforeEach(() => settings.set("frontier.minting", "true"));

  it("blocks a NEW mint once the cap is spent inside the window (no create call)", async () => {
    const { FRONTIER_DAILY_MINT_CAP, mintOrRefreshFrontierPlaylist } =
      await import("./frontier-playlist");

    const now = Date.now();
    const recent = new Date(now - 1000).toISOString();
    for (let index = 0; index < FRONTIER_DAILY_MINT_CAP; index += 1) {
      await insertPlaylistRow(`seeded-${index}`, `pl-${index}`, recent);
    }
    recs = result({ findings: [find("find1")] });

    const synced = await mintOrRefreshFrontierPlaylist(makeUser({ id: "new-user" }), now);

    expect(synced).toEqual({ ok: false, reason: "mint_cap_reached" });
    expect(spotifyCalls.some((call) => call.path === "/me/playlists")).toBe(false);
    // The edition still landed — the cap gates only the EXTERNAL mirror, never the cache.
    expect(await editionCount("new-user")).toBe(1);
  });
});

describe("refreshAllFrontierPlaylists (the weekly sweep) — D2", () => {
  it("SKIPS a draft-phase user (zero editions) and never births their edition #1", async () => {
    const { mintOrRefreshFrontierPlaylist, refreshAllFrontierPlaylists } =
      await import("./frontier-playlist");

    await seedUser(db, { email: "a@fluncle.com", id: "u-has" });
    await seedUser(db, { email: "b@fluncle.com", id: "u-draft" });

    const now = Date.parse("2026-07-01T00:00:00.000Z");

    // u-has commits an edition (dark). u-draft never does — pure draft phase.
    recs = result({ findings: [find("f1")] });
    await mintOrRefreshFrontierPlaylist(makeUser({ id: "u-has" }), now);

    // A new desired list, so the walked user writes a fresh edition. The drain gates on the
    // ~6-day cursor, so it only re-processes u-has a week on.
    recs = result({ findings: [find("f2")] });
    const swept = await refreshAllFrontierPlaylists(5, now + WEEK_MS);

    // Only the user with an edition is walked; the draft user is invisible to the sweep.
    expect(swept.total).toBe(1);
    expect(await editionCount("u-has")).toBe(2);
    expect(await editionCount("u-draft")).toBe(0);
  });

  it("sweeps a PRE-LEDGER minter — a playlist row + zero editions gains edition #1", async () => {
    // The exact prod shape: the operator minted before editions existed, so there is a
    // user_frontier_playlists row but no frontier_editions row. Walking by editions ALONE
    // would drop him from the weekly refresh forever; the union over playlist rows catches
    // him and the sweep writes his edition #1.
    const { refreshAllFrontierPlaylists } = await import("./frontier-playlist");

    await seedUser(db, { email: "op@fluncle.com", id: "u-preledger" });
    await insertPlaylistRow("u-preledger", "pl-legacy", "2026-07-17T00:00:00.000Z");
    expect(await editionCount("u-preledger")).toBe(0);

    recs = result({ findings: [find("f1")] });
    const swept = await refreshAllFrontierPlaylists(500);

    // Minting is dark, so the edition is written (internal cache) and Spotify is skipped.
    expect(swept).toMatchObject({ editionOnly: 1, ok: true, switchOff: true, total: 1 });
    expect(await editionCount("u-preledger")).toBe(1);
    expect(spotifyCalls).toEqual([]);
  });

  it("writes editions under a DARK switch (switchOff true, editionOnly tallied, no Spotify)", async () => {
    const { mintOrRefreshFrontierPlaylist, refreshAllFrontierPlaylists } =
      await import("./frontier-playlist");

    await seedUser(db, { email: "a@fluncle.com", id: "u1" });
    const now = Date.parse("2026-07-01T00:00:00.000Z");
    recs = result({ findings: [find("f1")] });
    await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1" }), now);
    spotifyCalls.length = 0;

    // A changed list → the sweep writes edition #2, mirror skipped (dark). A week on, so the
    // ~6-day cursor gate lets the drain re-process u1.
    recs = result({ findings: [find("f2")] });
    const swept = await refreshAllFrontierPlaylists(5, now + WEEK_MS);

    expect(swept).toMatchObject({ editionOnly: 1, ok: true, switchOff: true, total: 1 });
    expect(spotifyCalls).toEqual([]);
    expect(await editionCount("u1")).toBe(2);
  });

  it("skips an identical desired list — no new edition (unchanged tally)", async () => {
    const { mintOrRefreshFrontierPlaylist, refreshAllFrontierPlaylists } =
      await import("./frontier-playlist");

    await seedUser(db, { email: "a@fluncle.com", id: "u1" });
    const now = Date.parse("2026-07-01T00:00:00.000Z");
    recs = result({ findings: [find("f1")] });
    await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1" }), now);

    // The SAME list a week on — the sweep's per-user hash-skip fires.
    const swept = await refreshAllFrontierPlaylists(5, now + WEEK_MS);

    expect(swept).toMatchObject({ editionOnly: 0, total: 1, unchanged: 1 });
    expect(await editionCount("u1")).toBe(1);
  });

  it("mirrors to Spotify when minting is OPEN (refreshed tally)", async () => {
    const { mintOrRefreshFrontierPlaylist, refreshAllFrontierPlaylists } =
      await import("./frontier-playlist");

    settings.set("frontier.minting", "true");
    await seedUser(db, { email: "a@fluncle.com", id: "u1" });
    const now = Date.parse("2026-07-01T00:00:00.000Z");
    recs = result({ findings: [find("f1")] });
    await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1" }), now);
    spotifyCalls.length = 0;

    recs = result({ findings: [find("f2")] });
    const swept = await refreshAllFrontierPlaylists(5, now + WEEK_MS);

    expect(swept).toMatchObject({ ok: true, refreshed: 1, switchOff: false, total: 1 });
    expect(spotifyCalls.some((call) => call.init?.method === "PUT")).toBe(true);
  });
});

describe("the shared Spotify budget — the mint defers instead of 429-ing (Slice B)", () => {
  beforeEach(() => settings.set("frontier.minting", "true"));

  it("mints SYNCHRONOUSLY when the budget is free, recording each write into the meter", async () => {
    const { mintOrRefreshFrontierPlaylist } = await import("./frontier-playlist");

    const now = Date.parse("2026-07-01T00:00:00.000Z");
    recs = result({ findings: [find("f1")] });

    const synced = await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1" }), now);

    expect(synced).toMatchObject({ status: "minted" });
    expect(await hasPlaylistRow("u1")).toBe(true);
    // Two Spotify writes fired (the create POST + the items PUT) — both recorded in the meter.
    expect(spotifyBudgetCount(now)).toBe(2);
    // A settled outcome stamps the paced-drain cursor, so the sweep rotates past this user.
    expect(await hasRefreshCursor("u1")).toBe(true);
  });

  it("DEFERS the create when the budget is spent — status building, NO Spotify call, no cursor", async () => {
    const { mintOrRefreshFrontierPlaylist } = await import("./frontier-playlist");

    const now = Date.parse("2026-07-01T00:00:00.000Z");
    exhaustSpotifyBudget(now);
    recs = result({ findings: [find("f1")] });

    const synced = await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1" }), now);

    // A distinct SUCCESS state, never a fault — the user never sees a 429.
    expect(synced).toEqual({ ok: true, status: "building" });
    // The edition (the shelf's source of truth) still landed synchronously.
    expect(await editionCount("u1")).toBe(1);
    // No Spotify write fired on the hot path, and no playlist row was created.
    expect(spotifyCalls.some((call) => call.path === "/me/playlists")).toBe(false);
    expect(await hasPlaylistRow("u1")).toBe(false);
    // A deferred mint leaves the cursor UNSET so the user stays DUE for the paced drain.
    expect(await hasRefreshCursor("u1")).toBe(false);
  });

  it("the paced drain COMPLETES a deferred pending mint once the budget frees", async () => {
    const { mintOrRefreshFrontierPlaylist, refreshAllFrontierPlaylists } =
      await import("./frontier-playlist");

    await seedUser(db, { email: "a@fluncle.com", id: "u1" });
    const now = Date.parse("2026-07-01T00:00:00.000Z");
    exhaustSpotifyBudget(now);
    recs = result({ findings: [find("f1")] });

    // Hot budget → deferred (building), edition written, no playlist yet.
    const deferred = await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1" }), now);
    expect(deferred).toMatchObject({ status: "building" });
    expect(await hasPlaylistRow("u1")).toBe(false);

    // A later tick with a fresh budget window (rolled past the 30s window) — the drain finds
    // the pending mint (no cursor ⇒ DUE) and completes the create.
    const swept = await refreshAllFrontierPlaylists(5, now + 60_000);

    expect(swept).toMatchObject({ budgetPaused: false, minted: 1, ok: true, total: 1 });
    expect(await hasPlaylistRow("u1")).toBe(true);
    expect(spotifyBudgetCount(now + 60_000)).toBe(2);
  });

  it("the kill switch beats the budget — a dark switch is edition_only even with a spent budget", async () => {
    const { mintOrRefreshFrontierPlaylist } = await import("./frontier-playlist");

    settings.set("frontier.minting", "false");
    const now = Date.parse("2026-07-01T00:00:00.000Z");
    exhaustSpotifyBudget(now);
    recs = result({ findings: [find("f1")] });

    const synced = await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1" }), now);

    // Dark minting returns edition_only (never building) — the budget gate sits BELOW the
    // kill-switch gate, so a closed switch is still the honest dark outcome.
    expect(synced).toEqual({ ok: true, status: "edition_only" });
    expect(spotifyCalls).toEqual([]);
  });

  it("the hash-skip beats the budget — an unchanged list is unchanged, not building", async () => {
    const { mintOrRefreshFrontierPlaylist } = await import("./frontier-playlist");

    const now = Date.parse("2026-07-01T00:00:00.000Z");
    recs = result({ findings: [find("f1")] });
    // Mint first (fresh budget) so the mirror hash is stored.
    await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1" }), now);
    spotifyCalls.length = 0;

    // Now spend the budget and re-run the SAME list — the mirror guard returns before the
    // budget gate, so an unchanged week never needlessly defers.
    exhaustSpotifyBudget(now);
    const synced = await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1" }), now);

    expect(synced).toMatchObject({ status: "unchanged" });
    expect(spotifyCalls).toEqual([]);
  });
});

describe("the paced drain — batches, stamps, resumes, pending-mints first (Slice A)", () => {
  beforeEach(() => settings.set("frontier.minting", "true"));

  it("drains in BATCHES, stamping each user so the next tick resumes with the rest", async () => {
    const { mintOrRefreshFrontierPlaylist, refreshAllFrontierPlaylists } =
      await import("./frontier-playlist");

    const t0 = Date.parse("2026-07-01T00:00:00.000Z");
    // Three users, each minted at t0 (cursor stamped at t0) → all DUE a week on.
    for (const id of ["u1", "u2", "u3"]) {
      await seedUser(db, { email: `${id}@fluncle.com`, id });
      recs = result({ findings: [find(`${id}-a`)] });
      await mintOrRefreshFrontierPlaylist(makeUser({ id }), t0);
    }

    const later = t0 + WEEK_MS;
    // A changed list forces a real refresh for each.
    recs = result({ findings: [find("shared-b")] });

    // Batch of 2 → two refreshed, one still due.
    const first = await refreshAllFrontierPlaylists(2, later);
    expect(first).toMatchObject({ refreshed: 2, total: 2 });

    // The next tick picks up exactly the remaining one (the first two are stamped `later`).
    const second = await refreshAllFrontierPlaylists(2, later);
    expect(second).toMatchObject({ refreshed: 1, total: 1 });

    // A third tick finds nothing due — every user is now stamped `later`.
    const third = await refreshAllFrontierPlaylists(2, later);
    expect(third).toMatchObject({ refreshed: 0, total: 0 });
  });

  it("STOPS cleanly when the budget is exhausted, then RESUMES next tick", async () => {
    const { mintOrRefreshFrontierPlaylist, refreshAllFrontierPlaylists } =
      await import("./frontier-playlist");

    const t0 = Date.parse("2026-07-01T00:00:00.000Z");
    for (const id of ["u1", "u2"]) {
      await seedUser(db, { email: `${id}@fluncle.com`, id });
      recs = result({ findings: [find(`${id}-a`)] });
      await mintOrRefreshFrontierPlaylist(makeUser({ id }), t0);
    }

    const later = t0 + WEEK_MS;
    recs = result({ findings: [find("shared-b")] });
    spotifyCalls.length = 0;

    // Budget already spent at `later` → the pass stops before any user, processing none.
    exhaustSpotifyBudget(later);
    const paused = await refreshAllFrontierPlaylists(5, later);
    expect(paused).toMatchObject({ budgetPaused: true, refreshed: 0, total: 2 });
    expect(spotifyCalls).toEqual([]);

    // A later tick with a fresh window drains both — the durable cursors resumed the work.
    const resumed = await refreshAllFrontierPlaylists(5, later + 60_000);
    expect(resumed).toMatchObject({ budgetPaused: false, refreshed: 2, total: 2 });
  });

  it("orders PENDING MINTS ahead of due refreshers", async () => {
    const { mintOrRefreshFrontierPlaylist, refreshAllFrontierPlaylists } =
      await import("./frontier-playlist");

    const t0 = Date.parse("2026-07-01T00:00:00.000Z");

    // A: minted at t0 (has a playlist row + a cursor) → a DUE refresher a week on.
    await seedUser(db, { email: "a@fluncle.com", id: "u-refresh" });
    recs = result({ findings: [find("a-1")] });
    await mintOrRefreshFrontierPlaylist(makeUser({ id: "u-refresh" }), t0);

    // B: a pending mint — deferred under a spent budget, so it has an edition but NO playlist
    // row and NO cursor.
    await seedUser(db, { email: "b@fluncle.com", id: "u-pending" });
    exhaustSpotifyBudget(t0);
    recs = result({ findings: [find("b-1")] });
    const deferred = await mintOrRefreshFrontierPlaylist(makeUser({ id: "u-pending" }), t0);
    expect(deferred).toMatchObject({ status: "building" });

    // A batch of ONE, a week on with a fresh budget: the pending mint (B) must be picked first.
    recs = result({ findings: [find("shared-b")] });
    const swept = await refreshAllFrontierPlaylists(1, t0 + WEEK_MS);

    expect(swept).toMatchObject({ minted: 1, total: 1 });
    // B got its first playlist. A was NOT reached this tick — had it been refreshed with the
    // changed list it would have written a second edition, so its edition count proves it stayed
    // put (its own mint wrote #1 only).
    expect(await hasPlaylistRow("u-pending")).toBe(true);
    expect(await editionCount("u-refresh")).toBe(1);
  });
});

describe("edition_only user opens minting — the mirror catches up without a new edition", () => {
  it("creates the Spotify playlist from an UNCHANGED latest edition (status minted, no new edition)", async () => {
    const { mintOrRefreshFrontierPlaylist } = await import("./frontier-playlist");

    // Dark: births edition #1, no playlist.
    recs = result({ findings: [find("f1")] });
    await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1" }));
    expect(await hasPlaylistRow("u1")).toBe(false);

    // Operator opens minting; the SAME desired list. The edition is unchanged, but the
    // mirror must still create the Spotify playlist.
    settings.set("frontier.minting", "true");
    const synced = await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1" }));

    expect(synced).toMatchObject({ status: "minted" });
    expect(await hasPlaylistRow("u1")).toBe(true);
    // No new edition was written — the mirror caught up to the existing one.
    expect(await editionCount("u1")).toBe(1);
  });
});

describe("putFrontierCover (the INERT-until-scope upload leg)", () => {
  it("degrades cleanly on a 403 missing scope — stamps nothing", async () => {
    const { putFrontierCover } = await import("./frontier-playlist");

    await insertPlaylistRow("u1", "pl-1", new Date().toISOString());
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("no scope", { status: 403 }))),
    );

    const uploaded = await putFrontierCover("u1", "pl-1", "BASE64");

    expect(uploaded).toEqual({ reason: "missing_scope", uploaded: false });
    expect(await coverStamp("u1")).toBeNull();

    vi.unstubAllGlobals();
  });

  it("stamps cover_uploaded_at on a 200", async () => {
    const { putFrontierCover } = await import("./frontier-playlist");

    await insertPlaylistRow("u1", "pl-1", new Date().toISOString());
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("", { status: 200 }))),
    );

    const uploaded = await putFrontierCover("u1", "pl-1", "BASE64");

    expect(uploaded).toEqual({ uploaded: true });
    expect(await coverStamp("u1")).not.toBeNull();

    vi.unstubAllGlobals();
  });
});

describe("the retired create endpoint (the Feb-2026 Spotify migration)", () => {
  it("never calls /users/{id}/playlists — it 403s live since 2026-03-09", async () => {
    const { mintOrRefreshFrontierPlaylist } = await import("./frontier-playlist");

    settings.set("frontier.minting", "true");
    recs = result({ catalogue: [cat("cat1")] });
    await mintOrRefreshFrontierPlaylist(makeUser({ id: "u-endpoint" }));

    expect(spotifyCalls.some((call) => call.path.startsWith("/users/"))).toBe(false);
    expect(spotifyCalls.some((call) => call.path === "/me")).toBe(false);
  });
});

describe("harness sanity", () => {
  it("a fresh integration DB starts with zero editions", async () => {
    expect(await rowCount(db, "frontier_editions")).toBe(0);
  });
});
