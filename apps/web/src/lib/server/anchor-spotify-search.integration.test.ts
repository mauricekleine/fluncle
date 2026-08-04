import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb } from "./integration-db";

// SLICE 2 — the DARK Spotify SEARCH rungs of the resolver waterfall, against the REAL schema + the
// REAL settings-KV flag. The whole point of the slice is a load-bearing safety property: when the dark
// flag `anchor_spotify_search_enabled` is OFF (the default), `resolveAnchorFree` issues ZERO Spotify
// SEARCH calls. So the two Spotify SEARCH edges (`findSpotifyTrackByIsrc`, `searchTrackCandidates`) are
// spied here and asserted NOT CALLED whenever the gate is closed, and the flag is set through the
// real `setAnchorSpotifySearchEnabled` (writing the real `settings` row) rather than a mock — the
// default-OFF must be proven, not assumed. The by-id metadata read + ListenBrainz are mocked as before;
// the database, the verification gate, the stamping, and the flag read are the real thing. `now` is
// injected so the Friday-window gate is deterministic (July 2026 is CEST, so Amsterdam = UTC + 2h).

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

/** A Wednesday noon — well outside the Friday-morning Frontier-refresh window. */
const NON_FRIDAY = new Date("2026-07-22T12:00:00Z");
/** Friday 07:00 Amsterdam (05:00 UTC in CEST) — inside the refresh window. */
const FRIDAY_WINDOW = new Date("2026-07-24T05:00:00Z");

/** A libSQL cell → string. */
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

/** A full TrackMetadata for the mocked by-id read. */
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

/** One `searchTrackCandidates` result (the fuzzy rung's candidate shape). */
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
  // ListenBrainz misses in every slice-2 test unless a test overrides it — the Spotify rungs are what
  // we are exercising, and they only run AFTER the free ListenBrainz rung misses.
  lookupSpotifyIdsByMbid.mockResolvedValue(null);
  // The pre-anchor Deezer recovery rung misses by default (a no-op for these Spotify-rung tests); an
  // ISRC-less row keeps whatever ISRC state the test seeds.
  searchDeezerCandidates.mockReset();
  searchDeezerCandidates.mockResolvedValue([]);
});

describe("resolveAnchorFree — the dark flag is the load-bearing gate", () => {
  it("flag OFF (default) ⇒ ZERO Spotify search calls, a clean un-stamped miss", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_off" });

    // No flag row written ⇒ default OFF. Even outside the Friday window, the rungs must not run.
    const result = await resolveAnchorFree("mb_off", NON_FRIDAY);

    expect(result).toEqual({
      anchored: false,
      apifyEnabled: true,
      freeDurationMsOmitted: 0,
      isrcRecoveredByDeezer: false,
      listenbrainzOutcome: "no-map",
      source: null,
      spotifyIsrcAsked: false,
      spotifySearchDone: false,
      spotifyThrottled: false,
      verifiedBy: null,
    });
    // THE LOAD-BEARING ASSERTION: not one Spotify SEARCH request while the flag is off.
    expect(findSpotifyTrackByIsrc).not.toHaveBeenCalled();
    expect(searchTrackCandidates).not.toHaveBeenCalled();
    // A free-rung miss never stamps the re-ask backoff — the Apify fallback keeps its turn.
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
      apifyEnabled: true,
      freeDurationMsOmitted: 0,
      isrcRecoveredByDeezer: false,
      listenbrainzOutcome: "no-map",
      source: "spotify-isrc",
      // The EXACT rung was spent — the narrower signal the box's per-tick ask budget meters.
      spotifyIsrcAsked: true,
      spotifySearchDone: true,
      spotifyThrottled: false,
      verifiedBy: "isrc",
    });
    expect(text((await anchorState("mb_isrc")).uri)).toBe("spotify:track:spISRC");
    expect(findSpotifyTrackByIsrc).toHaveBeenCalledTimes(1);
    // The ISRC rung hit, so the fuzzy search was never spent.
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
      apifyEnabled: true,
      freeDurationMsOmitted: 0,
      isrcRecoveredByDeezer: false,
      listenbrainzOutcome: "no-map",
      source: "spotify-search",
      spotifyIsrcAsked: false,
      spotifySearchDone: true,
      spotifyThrottled: false,
      verifiedBy: "search",
    });
    expect(text((await anchorState("mb_fuzzy")).uri)).toBe("spotify:track:spFuzzy");
    // A no-ISRC row never calls the ISRC rung.
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
    // The ISRC search finds nothing (a compilation-only ISRC), so the fuzzy rung takes over.
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
    // Right title/artist but 5s off — the ±2s triple refuses it. A genuine miss.
    searchTrackCandidates.mockResolvedValue([searchResult({ durationMs: 205_000, id: "spFar" })]);

    const result = await resolveAnchorFree("mb_gate_fail", NON_FRIDAY);

    expect(result).toEqual({
      anchored: false,
      apifyEnabled: true,
      freeDurationMsOmitted: 0,
      isrcRecoveredByDeezer: false,
      listenbrainzOutcome: "no-map",
      source: null,
      spotifyIsrcAsked: false,
      spotifySearchDone: true,
      spotifyThrottled: false,
      verifiedBy: null,
    });
    const state = await anchorState("mb_gate_fail");
    expect(state.uri).toBeNull();
    // THE KEY GUARANTEE: a free-rung miss does NOT stamp the re-ask backoff — Apify keeps its turn.
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
      apifyEnabled: true,
      freeDurationMsOmitted: 0,
      isrcRecoveredByDeezer: false,
      listenbrainzOutcome: "anchored",
      source: "listenbrainz",
      spotifyIsrcAsked: false,
      spotifySearchDone: false,
      spotifyThrottled: false,
      verifiedBy: "isrc",
    });
    expect(text((await anchorState("mb_lb")).uri)).toBe("spotify:track:lbId");
    // The ListenBrainz rung anchored, so the shared Spotify app was never asked to SEARCH.
    expect(findSpotifyTrackByIsrc).not.toHaveBeenCalled();
    expect(searchTrackCandidates).not.toHaveBeenCalled();
  });
});

// ── THE LISTENBRAINZ RUNG'S ONE SPOTIFY CALL ─────────────────────────────────────────────────────
// The by-id metadata read (`GET /v1/tracks/{id}`) draws on the SAME official app the search rungs do,
// and it consulted nothing at all — so through Spotify's throttle windows every free candidate
// died on it and its row was re-bought from Apify (~1,400/day). These pin the two halves of the fix:
// the read YIELDS to the throttle breaker, and it RECORDS into the shared call meter.
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

    // THE LOAD-BEARING HALF: not one Spotify request was issued for this row.
    expect(fetchTrackMetadata).not.toHaveBeenCalled();
    expect(result.listenbrainzOutcome).toBe("yielded-on-breaker");
    expect(result.anchored).toBe(false);
    // A yield is not a settled miss: the row keeps its turn, un-anchored and UN-STAMPED.
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
    // The default mock: ListenBrainz holds no mapping for this recording.

    // The gate sits AFTER the free ListenBrainz lookup on purpose. `no-map` is a fact about the ROW
    // that stays true whatever Spotify is doing, and reporting it as a yield instead would blind the
    // tally to where candidates actually die — the tripped breaker did not cost us this candidate.
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
    // The whole point of metering it: the catalogue's draw on the shared app is now VISIBLE to the
    // user-facing paths that pace against the same window.
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

    // Skipping a SEARCH costs nothing; skipping this read throws away a free anchor and buys a billed
    // Apify search in its place. So the meter counts the by-id read and never blocks it.
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
    // Deferred, never exhausted — the row keeps its turn.
    expect((await anchorState("mb_window_spent")).attempted).toBeNull();
  });
});

// ── THE TICK GUARDS + THE YIELD LAW (the exact-ISRC rung's conservative return) ───────────────────
describe("resolveAnchorFree — the caller's deferral and the yield law", () => {
  it("`spotifySearch: false` skips both rungs even with the flag ON, and stamps nothing", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");
    const { setAnchorApifyEnabled } = await import("./anchor-apify");

    await setAnchorSpotifySearchEnabled(true);
    // Apify OFF too: the stamp branch is armed, and a DEFERRED row must still not be stamped —
    // it is "not yet", never "exhausted".
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
    // Apify OFF arms the terminal-stamp branch — the exact state the yield law has to override.
    await setAnchorApifyEnabled(false);
    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_429" });
    findSpotifyTrackByIsrc.mockResolvedValue({ rateLimited: true });

    const result = await resolveAnchorFree("mb_429", NON_FRIDAY);

    expect(result.spotifyThrottled).toBe(true);
    expect(result.spotifyIsrcAsked).toBe(true);
    expect(searchTrackCandidates).not.toHaveBeenCalled();
    // PASS-ENDING, NEVER ROW-FAILING: the question was not put to Spotify, so the row is deferred
    // rather than exhausted and must not spend a lifetime attempt on a call that did not happen.
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

    // The rung is free; its READ is not. "ANY 429 in the anchor path" has to mean this one too, or
    // the law would sit waiting on the breaker's much slower 5-in-10-minutes threshold.
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

    // The reachable worst case: Apify off, the search flag off (so nothing is "pending"), and the
    // breaker tripped. Every previous rule would read that as an exhausted row and stamp it.
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
    // Nothing was asked of Spotify about this row, so it is deferred — not exhausted.
    expect((await anchorState("mb_yield_nostamp")).attempted).toBeNull();
  });

  it("a real settled miss with every rung shut DOES stamp (the yield rail is narrow)", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorApifyEnabled } = await import("./anchor-apify");

    await setAnchorApifyEnabled(false);
    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_real_miss" });
    // ListenBrainz has no mapping (the default mock): the rung RAN and found nothing.

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
    // A no-ISRC row never reaches the exact rung, so the budget's unit is untouched.
    expect(result.spotifyIsrcAsked).toBe(false);
  });
});
