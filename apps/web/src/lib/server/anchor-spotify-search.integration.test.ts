import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb } from "./integration-db";

let db: Client;

const lookupSpotifyIdsByMbid = vi.fn();
const fetchTrackMetadata = vi.fn();
const findSpotifyTrackByIsrc = vi.fn();
const searchTrackCandidates = vi.fn();

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

vi.mock("./listenbrainz", () => ({
  lookupSpotifyIdsByMbid: async (...args: unknown[]) => {
    const result = await lookupSpotifyIdsByMbid(...args);

    if (result === null) {
      return { outcome: "no-map" };
    }

    if (typeof result === "object" && result !== null && "outcome" in result) {
      return result;
    }

    return { match: result, outcome: "match" };
  },
}));

vi.mock("./spotify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./spotify")>();

  return {
    ...actual,
    fetchTrackMetadata: (...args: unknown[]) => fetchTrackMetadata(...args),
    findSpotifyTrackByIsrc: (...args: unknown[]) => findSpotifyTrackByIsrc(...args),
    searchTrackCandidates: (...args: unknown[]) => searchTrackCandidates(...args),
  };
});

const searchDeezerCandidates = vi.fn();

vi.mock("./deezer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./deezer")>();

  return {
    ...actual,
    searchDeezerCandidates: (...args: unknown[]) => searchDeezerCandidates(...args),
  };
});

const NON_FRIDAY = new Date("2026-07-22T12:00:00Z");

const FRIDAY_WINDOW = new Date("2026-07-24T05:00:00Z");

const text = (value: unknown): string => (typeof value === "string" ? value : "");

async function seedCatalogue(row: {
  artists?: string[];
  durationMs?: number;
  isrc?: null | string;
  mbid?: null | string;
  title?: string;
  trackId: string;
}): Promise<void> {
  await db.execute({
    args: [
      row.trackId,
      row.title ?? "Weightless",
      JSON.stringify(row.artists ?? ["Etherwood"]),
      row.durationMs ?? 261_901,
      row.isrc ?? null,
      row.mbid ?? "mbid-default",
    ],
    sql: `insert into tracks (track_id, title, artists_json, duration_ms, isrc, mb_recording_id)
          values (?, ?, ?, ?, ?, ?)`,
  });
}

async function anchorState(trackId: string): Promise<{ attempted: unknown; uri: unknown }> {
  const row = await db.execute({
    args: [trackId],
    sql: "select spotify_uri, spotify_anchor_attempted_at from tracks where track_id = ?",
  });

  return { attempted: row.rows[0]?.spotify_anchor_attempted_at, uri: row.rows[0]?.spotify_uri };
}

function metadata(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    albumImageUrl: "https://i.scdn.co/image/cover",
    artists: ["Etherwood"],
    durationMs: 261_800,
    isrc: "ROWISRC0001",
    spotifyArtistIds: ["sp-etherwood"],
    spotifyUri: "spotify:track:spISRC",
    spotifyUrl: "https://open.spotify.com/track/spISRC",
    title: "Weightless",
    trackId: "spISRC",
    ...over,
  };
}

function searchResult(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    album: "Album",
    artists: ["Muffler"],
    artworkUrl: "https://i.scdn.co/image/fuzzy",
    durationMs: 201_000,
    id: "spFuzzy",
    spotifyArtistIds: ["sp-muffler"],
    spotifyUrl: "https://open.spotify.com/track/spFuzzy",
    title: "Dribble",
    ...over,
  };
}

beforeEach(async () => {
  db = await createIntegrationDb();
  lookupSpotifyIdsByMbid.mockReset();
  fetchTrackMetadata.mockReset();
  findSpotifyTrackByIsrc.mockReset();
  searchTrackCandidates.mockReset();

  lookupSpotifyIdsByMbid.mockResolvedValue(null);

  searchDeezerCandidates.mockReset();
  searchDeezerCandidates.mockResolvedValue([]);
});

describe("quota-aware paid admission", () => {
  it("admits only an ISRC row on a quota trip, within the paid cap", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");
    const { recordSpotifyThrottle } = await import("./spotify-anchor-breaker");
    await setAnchorSpotifySearchEnabled(true);
    for (let i = 0; i < 5; i += 1) {
      await recordSpotifyThrottle(NON_FRIDAY.getTime(), true);
    }
    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_quota_isrc" });
    await seedCatalogue({ isrc: null, trackId: "mb_quota_no_isrc" });

    const isrc = await resolveAnchorFree("mb_quota_isrc", NON_FRIDAY);
    const noIsrc = await resolveAnchorFree("mb_quota_no_isrc", NON_FRIDAY);

    expect(isrc.apifyEligible).toBe(true);
    expect(isrc.apifyBudgetRemaining).toBe(299);
    expect(noIsrc.apifyEligible).toBe(false);
    expect(noIsrc.apifyIneligibleReason).toBe("awaiting_free_ask");
    expect(findSpotifyTrackByIsrc).not.toHaveBeenCalled();

    const { setAnchorApifyDailyRows } = await import("./anchor-apify");
    await setAnchorApifyDailyRows(1, NON_FRIDAY);
    await seedCatalogue({ isrc: "ROWISRC0002", trackId: "mb_quota_capped" });
    const capped = await resolveAnchorFree("mb_quota_capped", NON_FRIDAY);
    expect(capped.apifyEligible).toBe(false);
    expect(capped.apifyIneligibleReason).toBe("apify_budget_spent");

    const { anchorSpotifySearchGate } = await import("./anchor-spotify-search");
    expect(
      (await anchorSpotifySearchGate(new Date(NON_FRIDAY.getTime() + 2 * 60 * 60 * 1000))).reason,
    ).toBe("open");
    expect(
      (await anchorSpotifySearchGate(new Date(NON_FRIDAY.getTime() + 24 * 60 * 60 * 1000))).reason,
    ).toBe("open");
  });

  it("reopens the free lane after a 00:30 quota trip before the 03:30 re-probe", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { anchorSpotifySearchGate, setAnchorSpotifySearchEnabled } =
      await import("./anchor-spotify-search");
    const { recordSpotifyThrottle } = await import("./spotify-anchor-breaker");
    const quotaAt = new Date("2026-07-22T00:30:00.000Z");
    await setAnchorSpotifySearchEnabled(true);
    for (let i = 0; i < 5; i += 1) {
      await recordSpotifyThrottle(quotaAt.getTime(), true);
    }
    expect(await anchorSpotifySearchGate(quotaAt)).toMatchObject({
      nextEligibleAt: "2026-07-22T01:30:00.000Z",
      reason: "breaker_quota",
    });
    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_quota_reprobe" });
    findSpotifyTrackByIsrc.mockResolvedValue({ match: { trackId: "spISRC" } });
    fetchTrackMetadata.mockResolvedValue(metadata());
    expect(
      (await resolveAnchorFree("mb_quota_reprobe", new Date("2026-07-22T03:10:00.000Z"))).anchored,
    ).toBe(true);
    expect(findSpotifyTrackByIsrc).toHaveBeenCalled();
    expect((await anchorSpotifySearchGate(new Date("2026-07-22T03:30:00.000Z"))).reason).toBe(
      "open",
    );
  });

  it("keeps an unasked ISRC row off Apify after a throttle trip", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");
    const { recordSpotifyThrottle } = await import("./spotify-anchor-breaker");
    await setAnchorSpotifySearchEnabled(true);
    for (let i = 0; i < 5; i += 1) {
      await recordSpotifyThrottle(NON_FRIDAY.getTime());
    }
    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_throttle_isrc" });
    const result = await resolveAnchorFree("mb_throttle_isrc", NON_FRIDAY);
    expect(result.apifyEligible).toBe(false);
    expect(result.apifyIneligibleReason).toBe("awaiting_free_ask");
  });

  it("keeps both rungs closed in the Friday window", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");
    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_friday_paid" });
    const result = await resolveAnchorFree("mb_friday_paid", FRIDAY_WINDOW);
    expect(result.apifyEligible).toBe(false);
    expect(findSpotifyTrackByIsrc).not.toHaveBeenCalled();
  });
});

describe("resolveAnchorFree — the dark flag is the load-bearing gate", () => {
  it("flag OFF (default) ⇒ ZERO Spotify search calls, a clean un-stamped miss", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_off" });

    const result = await resolveAnchorFree("mb_off", NON_FRIDAY);

    expect(result).toEqual({
      anchored: false,
      apifyBudgetRemaining: 299,
      apifyEligible: true,
      apifyEnabled: true,
      apifyIneligibleReason: null,
      freeDurationMsOmitted: 0,
      isrcRecoveredByDeezer: false,
      listenbrainzOutcome: "no-map",
      source: null,
      spotifyIsrcAsked: false,
      spotifySearchDone: false,
      spotifySearchEnabled: false,
      spotifyThrottled: false,
      stamped: false,
      verifiedBy: null,
    });

    expect(findSpotifyTrackByIsrc).not.toHaveBeenCalled();
    expect(searchTrackCandidates).not.toHaveBeenCalled();

    expect((await anchorState("mb_off")).attempted).toBeNull();
  });

  it("flag ON but inside the Friday refresh window ⇒ still ZERO Spotify search calls", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");

    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_friday" });

    const result = await resolveAnchorFree("mb_friday", FRIDAY_WINDOW);

    expect(result.anchored).toBe(false);
    expect(result.spotifySearchDone).toBe(false);
    expect(findSpotifyTrackByIsrc).not.toHaveBeenCalled();
    expect(searchTrackCandidates).not.toHaveBeenCalled();
    expect((await anchorState("mb_friday")).attempted).toBeNull();
  });
});

describe("resolveAnchorFree — the Spotify ISRC rung (flag on, outside the window)", () => {
  it("anchors + stamps via the exact ISRC rung, and never spends the fuzzy search", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");

    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({
      artists: ["Etherwood"],
      durationMs: 261_901,
      isrc: "ROWISRC0001",
      title: "Weightless",
      trackId: "mb_isrc",
    });
    findSpotifyTrackByIsrc.mockResolvedValue({
      match: {
        artists: [{ id: "sp-etherwood", name: "Etherwood" }],
        spotifyUri: "spotify:track:spISRC",
        spotifyUrl: "https://open.spotify.com/track/spISRC",
        trackId: "spISRC",
      },
      rateLimited: false,
    });
    fetchTrackMetadata.mockResolvedValue(metadata());

    const result = await resolveAnchorFree("mb_isrc", NON_FRIDAY);

    expect(result).toEqual({
      anchored: true,
      apifyBudgetRemaining: 300,
      apifyEligible: false,
      apifyEnabled: true,
      apifyIneligibleReason: null,
      freeDurationMsOmitted: 0,
      isrcRecoveredByDeezer: false,
      listenbrainzOutcome: "no-map",
      source: "spotify-isrc",

      spotifyIsrcAsked: true,
      spotifySearchDone: true,
      spotifySearchEnabled: true,
      spotifyThrottled: false,
      stamped: false,
      verifiedBy: "isrc",
    });
    expect(text((await anchorState("mb_isrc")).uri)).toBe("spotify:track:spISRC");
    expect(findSpotifyTrackByIsrc).toHaveBeenCalledTimes(1);

    expect(searchTrackCandidates).not.toHaveBeenCalled();
  });

  it("a 429 on the ISRC rung STOPS the row (no fuzzy search) and falls to Apify un-stamped", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");

    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_429" });
    findSpotifyTrackByIsrc.mockResolvedValue({ rateLimited: true });

    const result = await resolveAnchorFree("mb_429", NON_FRIDAY);

    expect(result.anchored).toBe(false);
    expect(result.spotifySearchDone).toBe(true);
    expect(searchTrackCandidates).not.toHaveBeenCalled();
    expect((await anchorState("mb_429")).attempted).toBeNull();
  });
});

describe("resolveAnchorFree — the Spotify fuzzy rung (flag on, outside the window)", () => {
  it("anchors a no-ISRC row via the fuzzy search, and never touches the ISRC rung", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");

    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      title: "Dribble",
      trackId: "mb_fuzzy",
    });
    searchTrackCandidates.mockResolvedValue([searchResult()]);

    const result = await resolveAnchorFree("mb_fuzzy", NON_FRIDAY);

    expect(result).toEqual({
      anchored: true,
      apifyBudgetRemaining: 300,
      apifyEligible: false,
      apifyEnabled: true,
      apifyIneligibleReason: null,
      freeDurationMsOmitted: 0,
      isrcRecoveredByDeezer: false,
      listenbrainzOutcome: "no-map",
      source: "spotify-search",
      spotifyIsrcAsked: false,
      spotifySearchDone: true,
      spotifySearchEnabled: true,
      spotifyThrottled: false,
      stamped: false,
      verifiedBy: "search",
    });
    expect(text((await anchorState("mb_fuzzy")).uri)).toBe("spotify:track:spFuzzy");

    expect(findSpotifyTrackByIsrc).not.toHaveBeenCalled();
    expect(searchTrackCandidates).toHaveBeenCalledTimes(1);
  });

  it("an ISRC MISS falls through to the fuzzy search (both searches issued)", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");

    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: "ROWISRC0007",
      title: "Dribble",
      trackId: "mb_isrc_miss",
    });

    findSpotifyTrackByIsrc.mockResolvedValue({ rateLimited: false });
    searchTrackCandidates.mockResolvedValue([searchResult()]);

    const result = await resolveAnchorFree("mb_isrc_miss", NON_FRIDAY);

    expect(result.source).toBe("spotify-search");
    expect(result.anchored).toBe(true);
    expect(findSpotifyTrackByIsrc).toHaveBeenCalledTimes(1);
    expect(searchTrackCandidates).toHaveBeenCalledTimes(1);
  });

  it("a fuzzy candidate that FAILS the gate is NOT stamped (stays open for Apify)", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");

    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      title: "Dribble",
      trackId: "mb_gate_fail",
    });

    searchTrackCandidates.mockResolvedValue([searchResult({ durationMs: 205_000, id: "spFar" })]);

    const result = await resolveAnchorFree("mb_gate_fail", NON_FRIDAY);

    expect(result).toEqual({
      anchored: false,
      apifyBudgetRemaining: 299,
      apifyEligible: true,
      apifyEnabled: true,
      apifyIneligibleReason: null,
      freeDurationMsOmitted: 0,
      isrcRecoveredByDeezer: false,
      listenbrainzOutcome: "no-map",
      source: null,
      spotifyIsrcAsked: false,
      spotifySearchDone: true,
      spotifySearchEnabled: true,
      spotifyThrottled: false,
      stamped: false,
      verifiedBy: null,
    });
    const state = await anchorState("mb_gate_fail");
    expect(state.uri).toBeNull();

    expect(state.attempted).toBeNull();
  });

  it("counts a durationless fuzzy candidate without changing its gate rejection", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");

    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      title: "Dribble",
      trackId: "mb_fuzzy_durationless",
    });
    searchTrackCandidates.mockResolvedValue([searchResult({ durationMs: undefined })]);

    const result = await resolveAnchorFree("mb_fuzzy_durationless", NON_FRIDAY);

    expect(result.freeDurationMsOmitted).toBe(1);
    expect(result.anchored).toBe(false);
    expect(result.verifiedBy).toBeNull();
    expect((await anchorState("mb_fuzzy_durationless")).attempted).toBeNull();
  });
});

describe("resolveAnchorFree — ListenBrainz still wins first, even with the flag on", () => {
  it("a ListenBrainz hit anchors the row and NO Spotify search is ever issued", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");

    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({ isrc: "ROWISRC0001", mbid: "mbid-lb", trackId: "mb_lb" });
    lookupSpotifyIdsByMbid.mockResolvedValue({
      artistName: "Etherwood",
      recordingMbid: "mbid-lb",
      spotifyTrackIds: ["lbId"],
      trackName: "Weightless",
    });
    fetchTrackMetadata.mockResolvedValue(
      metadata({ spotifyUri: "spotify:track:lbId", trackId: "lbId" }),
    );

    const result = await resolveAnchorFree("mb_lb", NON_FRIDAY);

    expect(result).toEqual({
      anchored: true,
      apifyBudgetRemaining: 300,
      apifyEligible: false,
      apifyEnabled: true,
      apifyIneligibleReason: null,
      freeDurationMsOmitted: 0,
      isrcRecoveredByDeezer: false,
      listenbrainzOutcome: "anchored",
      source: "listenbrainz",
      spotifyIsrcAsked: false,
      spotifySearchDone: false,
      spotifySearchEnabled: true,
      spotifyThrottled: false,
      stamped: false,
      verifiedBy: "isrc",
    });
    expect(text((await anchorState("mb_lb")).uri)).toBe("spotify:track:lbId");

    expect(findSpotifyTrackByIsrc).not.toHaveBeenCalled();
    expect(searchTrackCandidates).not.toHaveBeenCalled();
  });
});

describe("resolveAnchorFree — the ListenBrainz by-id read joins the breaker + the meter", () => {
  it("a TRIPPED breaker yields the rung: no Spotify read, no stamp, its own outcome", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY } = await import("./spotify-anchor-breaker");
    const { setSetting } = await import("./settings");

    await setSetting(SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY, NON_FRIDAY.toISOString());
    await seedCatalogue({ isrc: "ROWISRC0001", mbid: "mbid-lb", trackId: "mb_yield" });
    lookupSpotifyIdsByMbid.mockResolvedValue({
      artistName: "Etherwood",
      recordingMbid: "mbid-lb",
      spotifyTrackIds: ["lbId"],
      trackName: "Weightless",
    });

    const result = await resolveAnchorFree("mb_yield", NON_FRIDAY);

    expect(fetchTrackMetadata).not.toHaveBeenCalled();
    expect(result.listenbrainzOutcome).toBe("yielded-on-breaker");
    expect(result.anchored).toBe(false);

    const state = await anchorState("mb_yield");
    expect(state.uri).toBeNull();
    expect(state.attempted).toBeNull();
  });

  it("the ListenBrainz mapping steps still run and keep their own outcomes while yielded", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY } = await import("./spotify-anchor-breaker");
    const { setSetting } = await import("./settings");

    await setSetting(SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY, NON_FRIDAY.toISOString());
    await seedCatalogue({ trackId: "mb_nomap" });

    expect((await resolveAnchorFree("mb_nomap", NON_FRIDAY)).listenbrainzOutcome).toBe("no-map");
  });

  it("a CLEAR breaker lets the read through, and the read is recorded in the shared meter", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { readSpotifyCallCount } = await import("./spotify-budget");

    await seedCatalogue({ isrc: "ROWISRC0001", mbid: "mbid-lb", trackId: "mb_metered" });
    lookupSpotifyIdsByMbid.mockResolvedValue({
      artistName: "Etherwood",
      recordingMbid: "mbid-lb",
      spotifyTrackIds: ["lbId"],
      trackName: "Weightless",
    });
    fetchTrackMetadata.mockResolvedValue(
      metadata({ spotifyUri: "spotify:track:lbId", trackId: "lbId" }),
    );

    const result = await resolveAnchorFree("mb_metered", NON_FRIDAY);

    expect(result.anchored).toBe(true);

    expect(await readSpotifyCallCount(NON_FRIDAY.getTime())).toBe(1);
  });

  it("a SPENT shared window still lets the free by-id read through (never trade a free anchor for a paid one)", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const {
      SPOTIFY_CALL_WINDOW_MAX,
      SPOTIFY_CALLS_WINDOW_COUNT_KEY,
      SPOTIFY_CALLS_WINDOW_START_KEY,
    } = await import("./spotify-budget");
    const { setSetting } = await import("./settings");

    await setSetting(SPOTIFY_CALLS_WINDOW_START_KEY, NON_FRIDAY.toISOString());
    await setSetting(SPOTIFY_CALLS_WINDOW_COUNT_KEY, String(SPOTIFY_CALL_WINDOW_MAX));
    await seedCatalogue({ isrc: "ROWISRC0001", mbid: "mbid-lb", trackId: "mb_busy" });
    lookupSpotifyIdsByMbid.mockResolvedValue({
      artistName: "Etherwood",
      recordingMbid: "mbid-lb",
      spotifyTrackIds: ["lbId"],
      trackName: "Weightless",
    });
    fetchTrackMetadata.mockResolvedValue(
      metadata({ spotifyUri: "spotify:track:lbId", trackId: "lbId" }),
    );

    expect((await resolveAnchorFree("mb_busy", NON_FRIDAY)).anchored).toBe(true);
    expect(fetchTrackMetadata).toHaveBeenCalledTimes(1);
  });

  it("a SPENT shared window DOES pause the Spotify search rungs (the subordinate-consumer rule)", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");
    const {
      SPOTIFY_CALL_WINDOW_MAX,
      SPOTIFY_CALLS_WINDOW_COUNT_KEY,
      SPOTIFY_CALLS_WINDOW_START_KEY,
    } = await import("./spotify-budget");
    const { setSetting } = await import("./settings");

    await setAnchorSpotifySearchEnabled(true);
    await setSetting(SPOTIFY_CALLS_WINDOW_START_KEY, NON_FRIDAY.toISOString());
    await setSetting(SPOTIFY_CALLS_WINDOW_COUNT_KEY, String(SPOTIFY_CALL_WINDOW_MAX));
    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_window_spent" });

    const result = await resolveAnchorFree("mb_window_spent", NON_FRIDAY);

    expect(result.spotifySearchDone).toBe(false);
    expect(findSpotifyTrackByIsrc).not.toHaveBeenCalled();
    expect(searchTrackCandidates).not.toHaveBeenCalled();

    expect((await anchorState("mb_window_spent")).attempted).toBeNull();
  });
});

describe("resolveAnchorFree — the caller's deferral and the yield law", () => {
  it("`spotifySearch: false` skips both rungs even with the flag ON, and stamps nothing", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");
    const { setAnchorApifyEnabled } = await import("./anchor-apify");

    await setAnchorSpotifySearchEnabled(true);

    await setAnchorApifyEnabled(false);
    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_deferred" });

    const result = await resolveAnchorFree("mb_deferred", NON_FRIDAY, { spotifySearch: false });

    expect(findSpotifyTrackByIsrc).not.toHaveBeenCalled();
    expect(searchTrackCandidates).not.toHaveBeenCalled();
    expect(result.spotifySearchDone).toBe(false);
    expect((await anchorState("mb_deferred")).attempted).toBeNull();
  });

  it("the deferral can only SUBTRACT — `spotifySearch: true` never arms a flag-OFF gate", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_no_override" });

    const result = await resolveAnchorFree("mb_no_override", NON_FRIDAY, { spotifySearch: true });

    expect(result.spotifySearchDone).toBe(false);
    expect(findSpotifyTrackByIsrc).not.toHaveBeenCalled();
  });

  it("a 429 on the exact rung reports the throttle, spends no fuzzy search, and stamps NOTHING", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");
    const { setAnchorApifyEnabled } = await import("./anchor-apify");

    await setAnchorSpotifySearchEnabled(true);

    await setAnchorApifyEnabled(false);
    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_429" });
    findSpotifyTrackByIsrc.mockResolvedValue({ rateLimited: true });

    const result = await resolveAnchorFree("mb_429", NON_FRIDAY);

    expect(result.spotifyThrottled).toBe(true);
    expect(result.spotifyIsrcAsked).toBe(true);
    expect(searchTrackCandidates).not.toHaveBeenCalled();

    expect((await anchorState("mb_429")).attempted).toBeNull();
  });

  it("a DEAD GRANT stops the row without claiming a throttle (the breaker models 429s only)", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");

    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_dead_grant" });
    findSpotifyTrackByIsrc.mockResolvedValue({ rateLimited: false, unauthorized: true });

    const result = await resolveAnchorFree("mb_dead_grant", NON_FRIDAY);

    expect(result.spotifyThrottled).toBe(false);
    expect(result.spotifyIsrcAsked).toBe(true);
    expect(searchTrackCandidates).not.toHaveBeenCalled();
  });

  it("an asked-and-MISSED row still stamps normally when Apify is off — that IS a settled miss", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");
    const { setAnchorApifyEnabled } = await import("./anchor-apify");

    await setAnchorSpotifySearchEnabled(true);
    await setAnchorApifyEnabled(false);
    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_asked_missed" });
    findSpotifyTrackByIsrc.mockResolvedValue({ rateLimited: false });
    searchTrackCandidates.mockResolvedValue([]);

    const result = await resolveAnchorFree("mb_asked_missed", NON_FRIDAY);

    expect(result.spotifyThrottled).toBe(false);
    expect((await anchorState("mb_asked_missed")).attempted).not.toBeNull();
  });

  it("a 429 on the ListenBrainz rung's OWN by-id read arms the yield law too", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({ isrc: "ROWISRC0001", mbid: "mbid-lb", trackId: "mb_lb_429" });
    lookupSpotifyIdsByMbid.mockResolvedValue({
      artistName: "Etherwood",
      recordingMbid: "mbid-lb",
      spotifyTrackIds: ["lbId"],
      trackName: "Weightless",
    });
    fetchTrackMetadata.mockRejectedValue(new Error("Spotify API request failed: 429"));

    const result = await resolveAnchorFree("mb_lb_429", NON_FRIDAY);

    expect(result.spotifyThrottled).toBe(true);
    expect(result.listenbrainzOutcome).toBe("metadata-failed");
  });

  it("a NON-throttle by-id failure is a plain metadata failure, never a yield signal", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({ isrc: "ROWISRC0001", mbid: "mbid-lb", trackId: "mb_lb_500" });
    lookupSpotifyIdsByMbid.mockResolvedValue({
      artistName: "Etherwood",
      recordingMbid: "mbid-lb",
      spotifyTrackIds: ["lbId"],
      trackName: "Weightless",
    });
    fetchTrackMetadata.mockRejectedValue(new Error("Spotify API request failed: 500"));

    const result = await resolveAnchorFree("mb_lb_500", NON_FRIDAY);

    expect(result.spotifyThrottled).toBe(false);
    expect(result.listenbrainzOutcome).toBe("metadata-failed");
  });

  it("a YIELDED ListenBrainz rung never burns a lifetime attempt, even with every other rung shut", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorApifyEnabled } = await import("./anchor-apify");
    const { SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY } = await import("./spotify-anchor-breaker");
    const { setSetting } = await import("./settings");

    await setAnchorApifyEnabled(false);
    await setSetting(SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY, NON_FRIDAY.toISOString());
    await seedCatalogue({ isrc: "ROWISRC0001", mbid: "mbid-lb", trackId: "mb_yield_nostamp" });
    lookupSpotifyIdsByMbid.mockResolvedValue({
      artistName: "Etherwood",
      recordingMbid: "mbid-lb",
      spotifyTrackIds: ["lbId"],
      trackName: "Weightless",
    });

    const result = await resolveAnchorFree("mb_yield_nostamp", NON_FRIDAY);

    expect(result.listenbrainzOutcome).toBe("yielded-on-breaker");

    expect((await anchorState("mb_yield_nostamp")).attempted).toBeNull();
  });

  it("a real settled miss with every rung shut DOES stamp (the yield rail is narrow)", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorApifyEnabled } = await import("./anchor-apify");

    await setAnchorApifyEnabled(false);
    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_real_miss" });

    await resolveAnchorFree("mb_real_miss", NON_FRIDAY);

    expect((await anchorState("mb_real_miss")).attempted).not.toBeNull();
  });

  it("a fuzzy search that throws a 429 also arms the yield law", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");

    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({ isrc: null, trackId: "mb_fuzzy_429" });
    searchTrackCandidates.mockRejectedValue(new Error("Spotify API request failed: 429"));

    const result = await resolveAnchorFree("mb_fuzzy_429", NON_FRIDAY);

    expect(result.spotifyThrottled).toBe(true);

    expect(result.spotifyIsrcAsked).toBe(false);
  });
});

async function askState(trackId: string): Promise<{ asked: unknown; attempted: unknown }> {
  const row = await db.execute({
    args: [trackId],
    sql: "select spotify_isrc_asked_at, spotify_anchor_attempted_at from tracks where track_id = ?",
  });

  return {
    asked: row.rows[0]?.spotify_isrc_asked_at,
    attempted: row.rows[0]?.spotify_anchor_attempted_at,
  };
}

describe("resolveAnchorFree — the paid rung is admitted only after a real free ask", () => {
  it("an ISRC row whose ask was DEFERRED is refused the paid rung and keeps its turn", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");

    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_deferred" });

    const result = await resolveAnchorFree("mb_deferred", NON_FRIDAY, { spotifySearch: false });

    expect(result.apifyEligible).toBe(false);
    expect(result.apifyIneligibleReason).toBe("awaiting_free_ask");

    expect(await askState("mb_deferred")).toEqual({ asked: null, attempted: null });
    expect(result.apifyBudgetRemaining).toBe(300);
    expect(findSpotifyTrackByIsrc).not.toHaveBeenCalled();
  });

  it("an ISRC row Spotify genuinely has nothing for writes the receipt and IS admitted", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");

    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_asked" });
    findSpotifyTrackByIsrc.mockResolvedValue({ match: null });
    searchTrackCandidates.mockResolvedValue([]);

    const result = await resolveAnchorFree("mb_asked", NON_FRIDAY);

    expect(findSpotifyTrackByIsrc).toHaveBeenCalledTimes(1);
    expect(result.apifyEligible).toBe(true);
    expect(result.apifyIneligibleReason).toBeNull();

    const state = await askState("mb_asked");
    expect(state.asked).not.toBeNull();
    expect(state.attempted).toBeNull();

    expect(result.apifyBudgetRemaining).toBe(299);
  });

  it("a THROTTLED ask writes no receipt and admits nothing — the yield law and the money rail agree", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");

    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_429" });
    findSpotifyTrackByIsrc.mockResolvedValue({ match: null, rateLimited: true });

    const result = await resolveAnchorFree("mb_429", NON_FRIDAY);

    expect(result.spotifyThrottled).toBe(true);

    expect(result.apifyEligible).toBe(false);
    expect(result.apifyIneligibleReason).toBe("awaiting_free_ask");
    expect((await askState("mb_429")).asked).toBeNull();
  });

  it("a receipt from an EARLIER tick admits the row without asking Spotify twice", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");

    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_prior" });
    await db.execute({
      args: ["mb_prior"],
      sql: "update tracks set spotify_isrc_asked_at = '2026-09-19T03:00:00.000Z' where track_id = ?",
    });

    const result = await resolveAnchorFree("mb_prior", NON_FRIDAY, { spotifySearch: false });

    expect(findSpotifyTrackByIsrc).not.toHaveBeenCalled();
    expect(result.apifyEligible).toBe(true);
    expect(result.apifyBudgetRemaining).toBe(299);
  });

  it("with the free search rungs DISARMED every row is admitted at once (the exemption)", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_exempt" });

    const result = await resolveAnchorFree("mb_exempt", NON_FRIDAY);

    expect(result.apifyEligible).toBe(true);
    expect(result.apifyIneligibleReason).toBeNull();
    expect((await askState("mb_exempt")).asked).toBeNull();
  });

  it("an ISRC-LESS row is admitted once the FUZZY rung actually ran", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");

    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({ isrc: null, trackId: "mb_fuzzy_ran" });
    searchTrackCandidates.mockResolvedValue([]);

    const ran = await resolveAnchorFree("mb_fuzzy_ran", NON_FRIDAY);

    expect(searchTrackCandidates).toHaveBeenCalledTimes(1);
    expect(ran.apifyEligible).toBe(true);

    expect((await askState("mb_fuzzy_ran")).asked).toBeNull();
  });

  it("an ISRC-LESS row whose fuzzy rung was deferred is refused", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");

    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({ isrc: null, trackId: "mb_fuzzy_deferred" });

    const result = await resolveAnchorFree("mb_fuzzy_deferred", NON_FRIDAY, {
      spotifySearch: false,
    });

    expect(searchTrackCandidates).not.toHaveBeenCalled();
    expect(result.apifyEligible).toBe(false);
    expect(result.apifyIneligibleReason).toBe("awaiting_free_ask");
  });

  it("a SPENT daily cap refuses an otherwise-admitted row, and the row keeps its turn", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorApifyDailyRows } = await import("./anchor-apify");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");

    await setAnchorSpotifySearchEnabled(true);
    await setAnchorApifyDailyRows(0);
    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_broke" });
    findSpotifyTrackByIsrc.mockResolvedValue({ match: null });
    searchTrackCandidates.mockResolvedValue([]);

    const result = await resolveAnchorFree("mb_broke", NON_FRIDAY);

    expect(result.apifyEligible).toBe(false);
    expect(result.apifyIneligibleReason).toBe("apify_budget_spent");
    expect(result.apifyBudgetRemaining).toBe(0);

    expect((await askState("mb_broke")).asked).not.toBeNull();
    expect((await askState("mb_broke")).attempted).toBeNull();
  });

  it("an ANCHORED row is never admitted and never charges the cap", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");

    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_won" });
    findSpotifyTrackByIsrc.mockResolvedValue({ match: { trackId: "spISRC" } });
    fetchTrackMetadata.mockResolvedValue(metadata());

    const result = await resolveAnchorFree("mb_won", NON_FRIDAY);

    expect(result.anchored).toBe(true);
    expect(result.apifyEligible).toBe(false);
    expect(result.apifyBudgetRemaining).toBe(300);

    expect((await askState("mb_won")).asked).toBeNull();
  });
});

describe("anchorTrack — the admission rule is re-checked at the write boundary", () => {
  const candidate = {
    artists: [{ id: "sp-etherwood", name: "Etherwood" }],
    durationMs: 261_800,
    isrc: "ROWISRC0001",
    spotifyTrackId: "spPaid",
    title: "Weightless",
  };

  it("honours a charged quota admission when the UTC day changes before the report", async () => {
    const { anchorTrack, resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");
    const { recordSpotifyThrottle } = await import("./spotify-anchor-breaker");
    const beforeReset = new Date("2026-07-22T23:59:00.000Z");
    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_quota_boundary" });
    for (let i = 0; i < 5; i += 1) {
      await recordSpotifyThrottle(beforeReset.getTime(), true);
    }
    expect((await resolveAnchorFree("mb_quota_boundary", beforeReset)).apifyEligible).toBe(true);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-23T00:01:00.000Z"));
    try {
      expect((await anchorTrack("mb_quota_boundary", [candidate])).anchored).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honours a paid receipt when an actor returns inside the Friday window", async () => {
    const { anchorTrack, resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");
    const { recordSpotifyThrottle } = await import("./spotify-anchor-breaker");
    const chargedAt = new Date("2026-07-24T03:59:00.000Z");
    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_friday_edge" });
    for (let i = 0; i < 5; i += 1) {
      await recordSpotifyThrottle(chargedAt.getTime(), true);
    }
    expect((await resolveAnchorFree("mb_friday_edge", chargedAt)).apifyEligible).toBe(true);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-24T04:01:00.000Z"));
    try {
      expect((await anchorTrack("mb_friday_edge", [candidate])).anchored).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires a charged receipt before accepting a late Friday report", async () => {
    const { anchorTrack, resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");
    const { recordSpotifyThrottle } = await import("./spotify-anchor-breaker");
    const chargedAt = new Date("2026-07-24T03:59:00.000Z");
    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_friday_late" });
    for (let i = 0; i < 5; i += 1) {
      await recordSpotifyThrottle(chargedAt.getTime(), true);
    }
    expect((await resolveAnchorFree("mb_friday_late", chargedAt)).apifyEligible).toBe(true);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-24T06:01:00.000Z"));
    try {
      await expect(anchorTrack("mb_friday_late", [candidate])).rejects.toMatchObject({
        reason: "awaiting_free_ask",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("honours a paid no-ISRC row after its settled fuzzy ask when quota trips", async () => {
    const { anchorTrack, resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");
    const { recordSpotifyThrottle } = await import("./spotify-anchor-breaker");
    const chargedAt = new Date("2026-07-22T12:00:00.000Z");
    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({ isrc: null, trackId: "mb_fuzzy_then_quota" });
    searchTrackCandidates.mockResolvedValue([]);
    expect((await resolveAnchorFree("mb_fuzzy_then_quota", chargedAt)).apifyEligible).toBe(true);
    for (let i = 0; i < 5; i += 1) {
      await recordSpotifyThrottle(chargedAt.getTime() + 60_000, true);
    }

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(chargedAt.getTime() + 2 * 60_000));
    try {
      expect((await anchorTrack("mb_fuzzy_then_quota", [candidate])).anchored).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a never-asked ISRC row with `awaiting_free_ask`, touching nothing", async () => {
    const { AnchorTrackError, anchorTrack } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");

    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_stale_box" });

    await expect(anchorTrack("mb_stale_box", [candidate])).rejects.toThrow(AnchorTrackError);
    await expect(anchorTrack("mb_stale_box", [candidate])).rejects.toMatchObject({
      reason: "awaiting_free_ask",
    });

    expect(await askState("mb_stale_box")).toEqual({ asked: null, attempted: null });
    expect((await anchorState("mb_stale_box")).uri).toBeNull();
  });

  it("lets the same row through once the receipt exists, and clears it on the hit", async () => {
    const { anchorTrack } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");

    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_admitted" });
    await db.execute({
      args: ["mb_admitted"],
      sql: "update tracks set spotify_isrc_asked_at = '2026-07-22T03:00:00.000Z' where track_id = ?",
    });

    expect(await anchorTrack("mb_admitted", [candidate])).toEqual({
      anchored: true,
      verifiedBy: "isrc",
    });
    expect((await askState("mb_admitted")).asked).toBeNull();
  });

  it("never holds back a row the free rung could not have asked about", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_flag_off" });
    expect((await anchorTrack("mb_flag_off", [candidate])).anchored).toBe(true);

    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");
    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({ isrc: null, trackId: "mb_no_isrc" });
    expect((await anchorTrack("mb_no_isrc", [candidate])).anchored).toBe(true);
  });

  it("a free rung is never made to wait for itself", async () => {
    const { anchorTrack } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");

    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_free_source" });

    expect(
      (await anchorTrack("mb_free_source", [candidate], { source: "spotify-isrc" })).anchored,
    ).toBe(true);
  });

  it("a MISS on an admitted row clears the receipt with the stamp it authorised", async () => {
    const { anchorTrack } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");

    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_admitted_miss" });
    await db.execute({
      args: ["mb_admitted_miss"],
      sql: "update tracks set spotify_isrc_asked_at = '2026-07-22T03:00:00.000Z' where track_id = ?",
    });

    expect((await anchorTrack("mb_admitted_miss", [])).anchored).toBe(false);

    const state = await askState("mb_admitted_miss");
    expect(state.asked).toBeNull();
    expect(state.attempted).not.toBeNull();
  });
});
