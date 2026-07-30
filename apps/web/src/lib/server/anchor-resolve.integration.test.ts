import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb } from "./integration-db";

// THE FREE RUNG (`resolveAnchorFree`), against the REAL schema. Its guarantees are statements about
// SQL + the reuse of the anchor gate: on a ListenBrainz hit it fetches ONE candidate's metadata and
// runs it through the SAME verification `anchorTrack` uses, writing the anchor only on a hard match,
// and — crucially — it NEVER stamps a miss (so the Apify fallback still gets its turn on the row).
// The ListenBrainz client and the single Spotify metadata read are the two vendor edges, so they are
// mocked; the database + the verification gate + the stamping are the real thing.

let db: Client;

const lookupSpotifyIdsByMbid = vi.fn();
const fetchTrackMetadata = vi.fn();
const searchDeezerCandidates = vi.fn();

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

vi.mock("./listenbrainz", () => ({
  lookupSpotifyIdsByMbid: (...args: unknown[]) => lookupSpotifyIdsByMbid(...args),
}));

vi.mock("./spotify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./spotify")>();

  return { ...actual, fetchTrackMetadata: (...args: unknown[]) => fetchTrackMetadata(...args) };
});

vi.mock("./deezer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./deezer")>();

  return {
    ...actual,
    searchDeezerCandidates: (...args: unknown[]) => searchDeezerCandidates(...args),
  };
});

/** A libSQL cell → string. */
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Insert an UN-ANCHORED catalogue row, optionally carrying a MusicBrainz recording MBID. */
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
      row.mbid ?? null,
    ],
    sql: `insert into tracks (track_id, title, artists_json, duration_ms, isrc, mb_recording_id)
          values (?, ?, ?, ?, ?, ?)`,
  });
}

/** The anchor + attempt-stamp state of a row, for the assertions. */
async function anchorState(trackId: string): Promise<{
  attempted: unknown;
  deezerTrackId: unknown;
  deezerVerifiedAt: unknown;
  deezerVerifiedBy: unknown;
  isrc: unknown;
  uri: unknown;
}> {
  const row = await db.execute({
    args: [trackId],
    sql: `select spotify_uri, spotify_anchor_attempted_at, isrc,
                 deezer_track_id, deezer_verified_at, deezer_verified_by
          from tracks where track_id = ?`,
  });

  return {
    attempted: row.rows[0]?.spotify_anchor_attempted_at,
    deezerTrackId: row.rows[0]?.deezer_track_id,
    deezerVerifiedAt: row.rows[0]?.deezer_verified_at,
    deezerVerifiedBy: row.rows[0]?.deezer_verified_by,
    isrc: row.rows[0]?.isrc,
    uri: row.rows[0]?.spotify_uri,
  };
}

/** A full TrackMetadata for the mocked single by-id Spotify read. */
function metadata(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    albumImageUrl: "https://i.scdn.co/image/cover",
    artists: ["Etherwood"],
    durationMs: 261_800,
    isrc: "GBCJY1300173",
    spotifyArtistIds: ["sp-etherwood"],
    spotifyUri: "spotify:track:lbAnchor001",
    spotifyUrl: "https://open.spotify.com/track/lbAnchor001",
    title: "Weightless",
    trackId: "lbAnchor001",
    ...over,
  };
}

beforeEach(async () => {
  db = await createIntegrationDb();
  lookupSpotifyIdsByMbid.mockReset();
  fetchTrackMetadata.mockReset();
  // Deezer misses by default (the client never throws — an outage IS an empty list), so the
  // pre-anchor recovery rung is a no-op and the pre-Deezer waterfall behaviour is what's asserted.
  searchDeezerCandidates.mockReset();
  searchDeezerCandidates.mockResolvedValue([]);
});

describe("resolveAnchorFree — a ListenBrainz hit through the verification gate", () => {
  it("anchors + stamps via ISRC-equality, using exactly ONE Spotify metadata read", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({ isrc: "gbcjy1300173", mbid: "mbid-1", trackId: "mb_rec-1" });
    lookupSpotifyIdsByMbid.mockResolvedValue({
      artistName: "Etherwood",
      recordingMbid: "mbid-1",
      spotifyTrackIds: ["lbAnchor001", "lbAnchor002"],
      trackName: "Weightless",
    });
    fetchTrackMetadata.mockResolvedValue(metadata());

    const result = await resolveAnchorFree("mb_rec-1");

    expect(result).toEqual({
      anchored: true,
      apifyEnabled: true,
      isrcRecoveredByDeezer: false,
      source: "listenbrainz",
      spotifySearchDone: false,
      verifiedBy: "isrc",
    });
    // The row already carried an ISRC, so the Deezer recovery rung is skipped entirely.
    expect(searchDeezerCandidates).not.toHaveBeenCalled();
    const state = await anchorState("mb_rec-1");
    expect(text(state.uri)).toBe("spotify:track:lbAnchor001");
    expect(state.attempted).not.toBeNull();

    // ONLY the FIRST id's metadata was fetched — the free rung's whole Spotify footprint is one GET.
    expect(fetchTrackMetadata).toHaveBeenCalledTimes(1);
    expect(fetchTrackMetadata).toHaveBeenCalledWith("lbAnchor001");
  });

  it("anchors a no-ISRC row via the folded artist + title + ±3s search triple", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      mbid: "mbid-2",
      title: "Dribble",
      trackId: "mb_search",
    });
    lookupSpotifyIdsByMbid.mockResolvedValue({
      artistName: "Muffler",
      recordingMbid: "mbid-2",
      spotifyTrackIds: ["lbDribble"],
      trackName: "Dribble",
    });
    fetchTrackMetadata.mockResolvedValue(
      metadata({
        artists: ["Muffler"],
        durationMs: 201_000,
        isrc: null,
        spotifyArtistIds: ["sp-muffler"],
        title: "Dribble",
        trackId: "lbDribble",
      }),
    );

    const result = await resolveAnchorFree("mb_search");

    expect(result).toEqual({
      anchored: true,
      apifyEnabled: true,
      isrcRecoveredByDeezer: false,
      source: "listenbrainz",
      spotifySearchDone: false,
      verifiedBy: "search",
    });
    expect(text((await anchorState("mb_search")).uri)).toBe("spotify:track:lbDribble");
  });
});

describe("resolveAnchorFree — a candidate that FAILS verification is never stamped", () => {
  it("leaves the row un-anchored AND un-stamped (the Apify fallback keeps its turn)", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    // The row's ISRC and the candidate's differ, AND the candidate's duration is 3s off — so neither
    // the ISRC rung nor the search triple can verify it. It is a genuine miss.
    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: "ROWISRC00001",
      mbid: "mbid-3",
      title: "Dribble",
      trackId: "mb_wrong",
    });
    lookupSpotifyIdsByMbid.mockResolvedValue({
      artistName: "Muffler",
      recordingMbid: "mbid-3",
      spotifyTrackIds: ["lbWrong"],
      trackName: "Dribble",
    });
    fetchTrackMetadata.mockResolvedValue(
      metadata({
        artists: ["Muffler"],
        durationMs: 203_500,
        isrc: "OTHERISRC999",
        title: "Dribble",
        trackId: "lbWrong",
      }),
    );

    const result = await resolveAnchorFree("mb_wrong");

    expect(result).toEqual({
      anchored: false,
      apifyEnabled: true,
      isrcRecoveredByDeezer: false,
      source: null,
      spotifySearchDone: false,
      verifiedBy: null,
    });
    const state = await anchorState("mb_wrong");
    expect(state.uri).toBeNull();
    // THE KEY GUARANTEE: a free-rung miss does NOT stamp the re-ask backoff.
    expect(state.attempted).toBeNull();
  });
});

describe("resolveAnchorFree — the zero-Spotify-call misses", () => {
  it("returns a clean miss with NO vendor call when the row has no recording MBID", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({ mbid: null, trackId: "mb_nombid" });

    const result = await resolveAnchorFree("mb_nombid");

    expect(result).toEqual({
      anchored: false,
      apifyEnabled: true,
      isrcRecoveredByDeezer: false,
      source: null,
      spotifySearchDone: false,
      verifiedBy: null,
    });
    expect(lookupSpotifyIdsByMbid).not.toHaveBeenCalled();
    expect(fetchTrackMetadata).not.toHaveBeenCalled();
    expect((await anchorState("mb_nombid")).attempted).toBeNull();
  });

  it("returns a clean miss with NO Spotify call when ListenBrainz has no mapping", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({ mbid: "mbid-x", trackId: "mb_lbmiss" });
    lookupSpotifyIdsByMbid.mockResolvedValue(null);

    const result = await resolveAnchorFree("mb_lbmiss");

    expect(result).toEqual({
      anchored: false,
      apifyEnabled: true,
      isrcRecoveredByDeezer: false,
      source: null,
      spotifySearchDone: false,
      verifiedBy: null,
    });
    expect(fetchTrackMetadata).not.toHaveBeenCalled();
    expect((await anchorState("mb_lbmiss")).attempted).toBeNull();
  });

  it("returns a clean miss (never throws, never stamps) when the Spotify read fails", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({ mbid: "mbid-y", trackId: "mb_sperr" });
    lookupSpotifyIdsByMbid.mockResolvedValue({
      artistName: null,
      recordingMbid: "mbid-y",
      spotifyTrackIds: ["lbErr"],
      trackName: null,
    });
    fetchTrackMetadata.mockRejectedValue(new Error("Spotify API request failed: 429"));

    const result = await resolveAnchorFree("mb_sperr");

    expect(result).toEqual({
      anchored: false,
      apifyEnabled: true,
      isrcRecoveredByDeezer: false,
      source: null,
      spotifySearchDone: false,
      verifiedBy: null,
    });
    expect((await anchorState("mb_sperr")).attempted).toBeNull();
  });
});

describe("resolveAnchorFree — slice 3: the Apify kill-flag (out-of-budget → graceful state)", () => {
  /** A Wednesday noon — well outside the Friday-refresh window, so only the flags decide. */
  const NON_FRIDAY = new Date("2026-07-22T12:00:00Z");

  it("flag OFF ⇒ a FULL free-rung miss is STAMPED (backs off) and reports apifyEnabled:false", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorApifyEnabled } = await import("./anchor-apify");

    // Out of Apify budget. A row with no MBID (ListenBrainz never runs) that carries an ISRC (Deezer
    // recovery skipped) is a clean full miss with no anchor — and no Apify rung is coming to stamp it.
    await setAnchorApifyEnabled(false);
    await seedCatalogue({ isrc: "ROWISRC00001", mbid: null, trackId: "mb_apify_off" });

    const result = await resolveAnchorFree("mb_apify_off", NON_FRIDAY);

    expect(result).toEqual({
      anchored: false,
      apifyEnabled: false,
      isrcRecoveredByDeezer: false,
      source: null,
      spotifySearchDone: false,
      verifiedBy: null,
    });
    const state = await anchorState("mb_apify_off");
    expect(state.uri).toBeNull();
    // THE SLICE-3 GUARANTEE: with Apify off, the free rung backs the exhausted row off itself, so it
    // enters the 14-day re-ask backoff instead of recirculating at the head of the worklist forever.
    expect(state.attempted).not.toBeNull();
  });

  it("flag ON (default) ⇒ the SAME full miss is NOT stamped and reports apifyEnabled:true (unchanged)", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorApifyEnabled } = await import("./anchor-apify");

    // Apify has budget (the steady state). The identical full miss must behave EXACTLY as before slice 3:
    // it leaves the row un-stamped so the metered Apify fallback keeps its turn on it.
    await setAnchorApifyEnabled(true);
    await seedCatalogue({ isrc: "ROWISRC00001", mbid: null, trackId: "mb_apify_on" });

    const result = await resolveAnchorFree("mb_apify_on", NON_FRIDAY);

    expect(result).toEqual({
      anchored: false,
      apifyEnabled: true,
      isrcRecoveredByDeezer: false,
      source: null,
      spotifySearchDone: false,
      verifiedBy: null,
    });
    // Byte-for-byte the pre-slice-3 behaviour: a free-rung miss does NOT stamp the re-ask backoff.
    expect((await anchorState("mb_apify_on")).attempted).toBeNull();
  });

  it("flag OFF but a ListenBrainz HIT is never re-stamped (a hit already wrote the anchor + attempt)", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorApifyEnabled } = await import("./anchor-apify");

    // Apify off, but this row ANCHORS via ListenBrainz — the stamp comes from the hit's own write, not
    // the slice-3 back-off. The flag must not double-stamp or otherwise disturb the hit path.
    await setAnchorApifyEnabled(false);
    await seedCatalogue({ isrc: "gbcjy1300173", mbid: "mbid-hit", trackId: "mb_apify_off_hit" });
    lookupSpotifyIdsByMbid.mockResolvedValue({
      artistName: "Etherwood",
      recordingMbid: "mbid-hit",
      spotifyTrackIds: ["lbAnchor001"],
      trackName: "Weightless",
    });
    fetchTrackMetadata.mockResolvedValue(metadata());

    const result = await resolveAnchorFree("mb_apify_off_hit", NON_FRIDAY);

    expect(result).toEqual({
      anchored: true,
      apifyEnabled: false,
      isrcRecoveredByDeezer: false,
      source: "listenbrainz",
      spotifySearchDone: false,
      verifiedBy: "isrc",
    });
    const state = await anchorState("mb_apify_off_hit");
    expect(text(state.uri)).toBe("spotify:track:lbAnchor001");
    expect(state.attempted).not.toBeNull();
  });
});

describe("resolveAnchorFree — the pre-anchor Deezer ISRC-recovery rung", () => {
  it("recovers a verified ISRC into an empty row, then anchors via the exact-ISRC rung", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    // An ISRC-LESS crawler row. Deezer holds the real ISRC; its search hit matches the row's folded
    // identity + duration (±3s), so it is trusted. The recovered ISRC then equals the ListenBrainz
    // candidate's own metadata ISRC, so the row anchors through the EXACT-ISRC rung (not fuzzy).
    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      mbid: "mbid-dz",
      title: "Dribble",
      trackId: "mb_dz",
    });
    searchDeezerCandidates.mockResolvedValue([
      { artistName: "Muffler", durationMs: 201_000, isrc: "GBTESTDZ0001", title: "Dribble" },
    ]);
    lookupSpotifyIdsByMbid.mockResolvedValue({
      artistName: "Muffler",
      recordingMbid: "mbid-dz",
      spotifyTrackIds: ["lbDz"],
      trackName: "Dribble",
    });
    fetchTrackMetadata.mockResolvedValue(
      metadata({
        artists: ["Muffler"],
        durationMs: 201_000,
        isrc: "GBTESTDZ0001",
        title: "Dribble",
        trackId: "lbDz",
      }),
    );

    const result = await resolveAnchorFree("mb_dz");

    expect(result).toEqual({
      anchored: true,
      apifyEnabled: true,
      isrcRecoveredByDeezer: true,
      source: "listenbrainz",
      spotifySearchDone: false,
      verifiedBy: "isrc",
    });
    const state = await anchorState("mb_dz");
    // The recovered ISRC was persisted, and it drove the anchor.
    expect(text(state.isrc)).toBe("GBTESTDZ0001");
    expect(text(state.uri)).toBe("spotify:track:lbDz");
  });

  it("does NOT recover when the Deezer hit fails the fold+duration verification (stays ISRC-less → fuzzy)", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      mbid: "mbid-dzbad",
      title: "Dribble",
      trackId: "mb_dzbad",
    });
    // A hit whose duration is 3.5s off the row (> the ±3s bar) — a wrong recording. It must be refused,
    // so its ISRC is never trusted and the row stays ISRC-less.
    searchDeezerCandidates.mockResolvedValue([
      { artistName: "Muffler", durationMs: 203_500, isrc: "GBWRONGDZ001", title: "Dribble" },
    ]);
    lookupSpotifyIdsByMbid.mockResolvedValue(null);

    const result = await resolveAnchorFree("mb_dzbad");

    expect(result).toEqual({
      anchored: false,
      apifyEnabled: true,
      isrcRecoveredByDeezer: false,
      source: null,
      spotifySearchDone: false,
      verifiedBy: null,
    });
    const state = await anchorState("mb_dzbad");
    expect(state.isrc).toBeNull();
    expect(state.attempted).toBeNull();
  });

  it("never overwrites a row that already carries an ISRC (recovery is skipped)", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: "EXISTINGISRC",
      mbid: "mbid-dzhas",
      title: "Dribble",
      trackId: "mb_dzhas",
    });
    lookupSpotifyIdsByMbid.mockResolvedValue(null);

    const result = await resolveAnchorFree("mb_dzhas");

    expect(result.isrcRecoveredByDeezer).toBe(false);
    // The recovery rung is gated on an EMPTY ISRC, so Deezer is never even asked.
    expect(searchDeezerCandidates).not.toHaveBeenCalled();
    expect(text((await anchorState("mb_dzhas")).isrc)).toBe("EXISTINGISRC");
  });

  it("degrades cleanly to the normal waterfall on a Deezer outage (empty result)", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      mbid: "mbid-dzout",
      title: "Dribble",
      trackId: "mb_dzout",
    });
    // The Deezer client swallows an outage into an empty list (it never throws), so recovery is a
    // no-op and the row anchors exactly as it would have without this rung — via the search triple.
    searchDeezerCandidates.mockResolvedValue([]);
    lookupSpotifyIdsByMbid.mockResolvedValue({
      artistName: "Muffler",
      recordingMbid: "mbid-dzout",
      spotifyTrackIds: ["lbDzOut"],
      trackName: "Dribble",
    });
    fetchTrackMetadata.mockResolvedValue(
      metadata({
        artists: ["Muffler"],
        durationMs: 201_000,
        isrc: null,
        title: "Dribble",
        trackId: "lbDzOut",
      }),
    );

    const result = await resolveAnchorFree("mb_dzout");

    expect(result).toEqual({
      anchored: true,
      apifyEnabled: true,
      isrcRecoveredByDeezer: false,
      source: "listenbrainz",
      spotifySearchDone: false,
      verifiedBy: "search",
    });
    expect(searchDeezerCandidates).toHaveBeenCalledTimes(1);
    expect(text((await anchorState("mb_dzout")).isrc)).toBeFalsy();
  });
});

// ── THE BOX-FETCHED DEEZER HITS ──────────────────────────────────────────────────────────────────
// Deezer's tokenless quota is per-IP and the Worker egresses from Cloudflare's saturated shared edge,
// so the SEARCH moved to the box (0 recoveries out of 5,133 rows over 3 days from the edge; 25/25
// clean from the box). ONLY the fetch moved. These tests pin the half that did NOT: the gate is still
// the only thing that can authorise an ISRC write, and it is the same gate, applied to the row as the
// DATABASE holds it — so box-supplied hits get precisely what Worker-fetched ones got.
describe("resolveAnchorFree — Deezer hits supplied by the box", () => {
  it("verifies box-supplied hits and writes the recovered ISRC, without asking Deezer itself", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      mbid: null,
      title: "Dribble",
      trackId: "mb_box_ok",
    });
    lookupSpotifyIdsByMbid.mockResolvedValue(null);

    const result = await resolveAnchorFree("mb_box_ok", new Date(), {
      deezerCandidates: [
        { artistName: "Muffler", durationMs: 201_000, isrc: "GBBOXDZ00001", title: "Dribble" },
      ],
    });

    expect(result.isrcRecoveredByDeezer).toBe(true);
    expect(text((await anchorState("mb_box_ok")).isrc)).toBe("GBBOXDZ00001");
    // The Worker issued NO Deezer request of its own — the whole point of moving the fetch.
    expect(searchDeezerCandidates).not.toHaveBeenCalled();
  });

  // ── THE DEEZER LINK, KEPT (schema.ts § `deezer_track_id`) ────────────────────────────────────
  // The hits this rung already fetches carry Deezer's own track id, and it used to be dropped. A hit
  // that CLEARS the gate is this recording on Deezer, so its id is kept — in the same statement as
  // the ISRC, with the rung that cleared as its provenance. No extra request is made for it.
  it("keeps the verified hit's Deezer id with the rung that cleared", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      mbid: null,
      title: "Dribble",
      trackId: "mb_box_dzid",
    });
    lookupSpotifyIdsByMbid.mockResolvedValue(null);

    await resolveAnchorFree("mb_box_dzid", new Date(), {
      deezerCandidates: [
        {
          artistName: "Muffler",
          deezerTrackId: "3135556",
          durationMs: 201_000,
          isrc: "GBBOXDZ00003",
          title: "Dribble",
        },
      ],
    });

    const state = await anchorState("mb_box_dzid");

    expect(text(state.deezerTrackId)).toBe("3135556");
    expect(text(state.deezerVerifiedBy)).toBe("search");
    expect(state.deezerVerifiedAt).not.toBeNull();
  });

  it("keeps NO Deezer id off a hit that failed the gate", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      mbid: null,
      title: "Dribble",
      trackId: "mb_box_dzbad",
    });
    lookupSpotifyIdsByMbid.mockResolvedValue(null);

    // A remix, carrying a perfectly real Deezer id. The fold refuses it, and refusing the ISRC and
    // refusing the link is the same act — a wrong link on a public page is the worse of the two.
    await resolveAnchorFree("mb_box_dzbad", new Date(), {
      deezerCandidates: [
        {
          artistName: "Muffler",
          deezerTrackId: "3135557",
          durationMs: 200_000,
          isrc: "GBWRONGVER02",
          title: "Dribble (Calibre Remix)",
        },
      ],
    });

    const state = await anchorState("mb_box_dzbad");

    expect(state.deezerTrackId).toBeNull();
    expect(state.deezerVerifiedBy).toBeNull();
    expect(state.deezerVerifiedAt).toBeNull();
  });

  it("recovers the ISRC from a hit an older box sent without an id, and keeps no link", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      mbid: null,
      title: "Dribble",
      trackId: "mb_box_dznone",
    });
    lookupSpotifyIdsByMbid.mockResolvedValue(null);

    // The id is not evidence the gate reads, so a box on a build that predates the field degrades to
    // "no link kept" and never to a refused recovery.
    const result = await resolveAnchorFree("mb_box_dznone", new Date(), {
      deezerCandidates: [
        { artistName: "Muffler", durationMs: 200_000, isrc: "GBBOXDZ00004", title: "Dribble" },
      ],
    });

    const state = await anchorState("mb_box_dznone");

    expect(result.isrcRecoveredByDeezer).toBe(true);
    expect(text(state.isrc)).toBe("GBBOXDZ00004");
    expect(state.deezerTrackId).toBeNull();
  });

  it("refuses a box-supplied hit that fails the gate — the box cannot bypass verification", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      mbid: null,
      title: "Dribble",
      trackId: "mb_box_bad",
    });
    lookupSpotifyIdsByMbid.mockResolvedValue(null);

    const result = await resolveAnchorFree("mb_box_bad", new Date(), {
      deezerCandidates: [
        // Wrong artist — the folded identity disagrees, so the ISRC is refused…
        { artistName: "Etherwood", durationMs: 200_000, isrc: "GBWRONGART01", title: "Dribble" },
        // …wrong version descriptor, so the original can never take the remix's ISRC…
        {
          artistName: "Muffler",
          durationMs: 200_000,
          isrc: "GBWRONGVER01",
          title: "Dribble (Calibre Remix)",
        },
        // …and a duration outside the ratified window, so a different recording is refused too.
        { artistName: "Muffler", durationMs: 240_000, isrc: "GBWRONGDUR01", title: "Dribble" },
      ],
    });

    expect(result.isrcRecoveredByDeezer).toBe(false);
    expect((await anchorState("mb_box_bad")).isrc).toBeNull();
    expect(searchDeezerCandidates).not.toHaveBeenCalled();
  });

  it("never overwrites an existing ISRC with a box-supplied one (the server owns the ISRC-less gate)", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: "EXISTINGISRC",
      mbid: null,
      title: "Dribble",
      trackId: "mb_box_has",
    });
    lookupSpotifyIdsByMbid.mockResolvedValue(null);

    // A perfectly verifiable hit — but the ROW already carries an ISRC, and that gate is the
    // server's to read, not the box's to assert. The fill-empty-only write stands.
    const result = await resolveAnchorFree("mb_box_has", new Date(), {
      deezerCandidates: [
        { artistName: "Muffler", durationMs: 200_000, isrc: "GBBOXDZ00002", title: "Dribble" },
      ],
    });

    expect(result.isrcRecoveredByDeezer).toBe(false);
    expect(text((await anchorState("mb_box_has")).isrc)).toBe("EXISTINGISRC");
  });

  it("an EMPTY supplied list means the box searched and found nothing — the Worker does not re-ask", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      mbid: null,
      title: "Dribble",
      trackId: "mb_box_empty",
    });
    lookupSpotifyIdsByMbid.mockResolvedValue(null);

    const result = await resolveAnchorFree("mb_box_empty", new Date(), { deezerCandidates: [] });

    expect(result.isrcRecoveredByDeezer).toBe(false);
    expect((await anchorState("mb_box_empty")).isrc).toBeNull();
    // Re-asking from the saturated shared edge is a known-dead request, so it is never made.
    expect(searchDeezerCandidates).not.toHaveBeenCalled();
  });

  it("falls back to searching Deezer itself when no hits are supplied (the certify path, unchanged)", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      mbid: null,
      title: "Dribble",
      trackId: "mb_box_absent",
    });
    lookupSpotifyIdsByMbid.mockResolvedValue(null);
    searchDeezerCandidates.mockResolvedValue([
      { artistName: "Muffler", durationMs: 200_500, isrc: "GBSELFDZ0001", title: "Dribble" },
    ]);

    const result = await resolveAnchorFree("mb_box_absent");

    expect(result.isrcRecoveredByDeezer).toBe(true);
    expect(searchDeezerCandidates).toHaveBeenCalledTimes(1);
    expect(text((await anchorState("mb_box_absent")).isrc)).toBe("GBSELFDZ0001");
  });
});
