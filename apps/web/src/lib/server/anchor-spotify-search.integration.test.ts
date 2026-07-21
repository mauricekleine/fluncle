import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb } from "./integration-db";

// SLICE 2 — the DARK Spotify SEARCH rungs of the resolver waterfall, against the REAL schema + the
// REAL settings-KV flag. The whole point of the slice is a load-bearing safety property: when the dark
// flag `anchor_spotify_search_enabled` is OFF (the default), `resolveAnchorFree` issues ZERO Spotify
// SEARCH calls. So the two Spotify SEARCH edges (`findSpotifyTrackByIsrc`, `searchTrackCandidates`) are
// spied here and asserted NOT CALLED whenever the gate is closed, and the flag is flipped through the
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
  lookupSpotifyIdsByMbid: (...args: unknown[]) => lookupSpotifyIdsByMbid(...args),
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
});

describe("resolveAnchorFree — the dark flag is the load-bearing gate", () => {
  it("flag OFF (default) ⇒ ZERO Spotify search calls, a clean un-stamped miss", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({ isrc: "ROWISRC0001", trackId: "mb_off" });

    // No flag row written ⇒ default OFF. Even outside the Friday window, the rungs must not run.
    const result = await resolveAnchorFree("mb_off", NON_FRIDAY);

    expect(result).toEqual({
      anchored: false,
      source: null,
      spotifySearchDone: false,
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
      source: "spotify-isrc",
      spotifySearchDone: true,
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
      source: "spotify-search",
      spotifySearchDone: true,
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
      source: null,
      spotifySearchDone: true,
      verifiedBy: null,
    });
    const state = await anchorState("mb_gate_fail");
    expect(state.uri).toBeNull();
    // THE KEY GUARANTEE: a free-rung miss does NOT stamp the re-ask backoff — Apify keeps its turn.
    expect(state.attempted).toBeNull();
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
      source: "listenbrainz",
      spotifySearchDone: false,
      verifiedBy: "isrc",
    });
    expect(text((await anchorState("mb_lb")).uri)).toBe("spotify:track:lbId");
    // The ListenBrainz rung anchored, so the shared Spotify app was never asked to SEARCH.
    expect(findSpotifyTrackByIsrc).not.toHaveBeenCalled();
    expect(searchTrackCandidates).not.toHaveBeenCalled();
  });
});
