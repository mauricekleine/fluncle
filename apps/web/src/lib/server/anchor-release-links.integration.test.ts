import { type Client } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb } from "./integration-db";

let db: Client;
let directory: string;
let spotifyAllowed = true;
const albumId = "A".repeat(22);
const cache = new Map<string, string>();
const cacheGet = vi.fn(async (key: string) => {
  const value = cache.get(key);
  return value ? JSON.parse(value) : null;
});
const cachePut = vi.fn(async (key: string, value: string) => {
  cache.set(key, value);
});
const mbFetch = vi.fn();
const fetchSpotifyAlbumTracks = vi.fn();
const fetchTrackMetadata = vi.fn();
const lookupSpotifyIdsByMbid = vi.fn();
const lookupSpotifyIdsByMetadata = vi.fn();

vi.mock("cloudflare:workers", () => ({
  env: { SPOTIFY_ALBUM_TRACKS: { get: cacheGet, put: cachePut } },
  waitUntil: () => undefined,
}));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, getDb: () => Promise.resolve(db) };
});

vi.mock("./musicbrainz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./musicbrainz")>();
  return { ...actual, mbFetch: (...args: unknown[]) => mbFetch(...args) };
});

vi.mock("./anchor-spotify-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./anchor-spotify-search")>();
  return {
    ...actual,
    anchorSpotifyBreakerAllows: async () => true,
    anchorSpotifySearchAllowed: async () => spotifyAllowed,
    anchorSpotifySearchGate: async () => ({ nextEligibleAt: null, reason: "flag_off" }),
    isAnchorSpotifySearchEnabled: async () => false,
  };
});

vi.mock("./spotify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./spotify")>();
  return {
    ...actual,
    fetchSpotifyAlbumTracks: (...args: unknown[]) => fetchSpotifyAlbumTracks(...args),
    fetchTrackMetadata: (...args: unknown[]) => fetchTrackMetadata(...args),
  };
});

vi.mock("./listenbrainz", () => ({
  lookupSpotifyIdsByMbid: (...args: unknown[]) => lookupSpotifyIdsByMbid(...args),
  lookupSpotifyIdsByMetadata: (...args: unknown[]) => lookupSpotifyIdsByMetadata(...args),
}));

const albumTracks = [
  {
    artists: [{ id: "artist1", name: "Etherwood" }],
    discNumber: 1,
    durationMs: 261_800,
    isrc: null,
    spotifyTrackId: "spotify-one",
    title: "Weightless",
    trackNumber: 1,
  },
  {
    artists: [{ id: "artist1", name: "Etherwood" }],
    discNumber: 1,
    durationMs: 280_000,
    isrc: null,
    spotifyTrackId: "spotify-two",
    title: "Signals (VIP)",
    trackNumber: 2,
  },
];

async function seed(trackId: string, mbid: string, title: string, duration: number, isrc?: string) {
  await db.execute({
    args: [trackId, mbid, title, '["Etherwood"]', duration, isrc ?? null],
    sql: `insert into tracks (track_id, mb_recording_id, title, artists_json, duration_ms, isrc)
          values (?, ?, ?, ?, ?, ?)`,
  });
}

async function uri(trackId: string) {
  const result = await db.execute({
    args: [trackId],
    sql: "select spotify_uri, spotify_anchor_attempted_at, spotify_anchor_attempts from tracks where track_id = ?",
  });
  return result.rows[0];
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "fluncle-release-links-"));
  db = await createIntegrationDb({ url: `file:${join(directory, "anchor.db")}` });
  cache.clear();
  cacheGet.mockClear();
  cachePut.mockClear();
  mbFetch.mockReset();
  fetchSpotifyAlbumTracks.mockReset();
  fetchTrackMetadata.mockReset();
  lookupSpotifyIdsByMbid.mockReset().mockResolvedValue({ outcome: "no-map" });
  lookupSpotifyIdsByMetadata.mockReset().mockResolvedValue({ outcome: "no-map" });
  spotifyAllowed = true;
  mbFetch.mockImplementation(async (path: string) => ({
    data: path.startsWith("/recording/")
      ? { releases: [{ id: "release-1" }] }
      : {
          media: [
            {
              tracks: [
                { recording: { id: "rec-1" } },
                { recording: { id: "rec-2" } },
                { recording: { id: "rec-3" } },
              ],
            },
          ],
          relations: [{ url: { resource: `https://open.spotify.com/album/${albumId}` } }],
        },
    rateLimited: false,
  }));
  fetchSpotifyAlbumTracks.mockImplementation(async (_id: string, onPage: () => Promise<void>) => {
    await onPage();
    return albumTracks;
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  db.close();
  await rm(directory, { force: true, recursive: true });
});

describe("release-link anchor rung", () => {
  it("anchors the whole release with one album fetch, then uses KV for a later row", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    await seed("mb_rec-1", "rec-1", "Weightless", 261_901, "GBTEST000001");
    await seed("mb_rec-2", "rec-2", "Signals (VIP)", 279_500);
    await db.execute({
      args: ["mb_rec-2"],
      sql: "update tracks set spotify_anchor_paid_state = 'pending' where track_id = ?",
    });

    const first = await resolveAnchorFree("mb_rec-1");
    expect(first.source).toBe("release-link");
    expect(first.anchoredByReleaseLink).toBe(2);
    expect(first.releaseLinkAlbumsFetched).toBe(1);
    expect(fetchSpotifyAlbumTracks).toHaveBeenCalledTimes(1);
    expect(cachePut).toHaveBeenCalledWith(`album:${albumId}`, expect.any(String), {
      expirationTtl: 30 * 24 * 60 * 60,
    });
    expect((await uri("mb_rec-1"))?.spotify_uri).toBe("spotify:track:spotify-one");
    expect((await uri("mb_rec-2"))?.spotify_uri).toBe("spotify:track:spotify-two");

    await seed("mb_rec-3", "rec-3", "Weightless", 261_900, "GBTEST000001");
    const second = await resolveAnchorFree("mb_rec-3");
    expect(second.releaseLinkCacheHits).toBe(1);
    expect(second.releaseLinkAlbumsFetched ?? 0).toBe(0);
    expect(fetchSpotifyAlbumTracks).toHaveBeenCalledTimes(1);
    expect((await uri("mb_rec-3"))?.spotify_uri).toBe("spotify:track:spotify-one");
  });

  it("settles sibling rows before the box prepares its normal resolver batch", async () => {
    const { resolveAnchorReleaseLink } = await import("./anchor");
    await seed("mb_rec-1", "rec-1", "Weightless", 261_901, "GBTEST000001");
    await seed("mb_rec-2", "rec-2", "Signals (VIP)", 279_500);
    const first = await resolveAnchorReleaseLink("mb_rec-1");
    const second = await resolveAnchorReleaseLink("mb_rec-2");
    expect(first.anchoredCount).toBe(2);
    expect(second.anchoredCount).toBe(0);
    expect(first.anchored).toBe(true);
    expect(second.anchored).toBe(true);
    expect(fetchSpotifyAlbumTracks).toHaveBeenCalledTimes(1);
  });

  it("leaves a nonmatching version and duration unstamped on this rung", async () => {
    const { resolveReleaseLinks } = await import("./anchor-release-links");
    const { anchorTrack } = await import("./anchor");
    await seed("mb_rec-1", "rec-1", "Weightless (VIP)", 261_800);
    await seed("mb_rec-3", "rec-3", "Weightless", 300_000);
    const result = await resolveReleaseLinks(
      "mb_rec-1",
      "rec-1",
      new Date(),
      true,
      async (id, tracks) =>
        (
          await anchorTrack(
            id,
            tracks.map((track) => ({
              artists: track.artists,
              durationMs: track.durationMs,
              isrc: track.isrc,
              spotifyTrackId: track.spotifyTrackId,
              title: track.title,
            })),
            { skipVersionReview: true, source: "release-link", stampOnMiss: false },
          )
        ).anchored,
    );
    expect(result.anchoredCount).toBe(0);
    expect(
      (await db.execute("select anchor_review_json from tracks where track_id = 'mb_rec-1'"))
        .rows[0]?.anchor_review_json,
    ).toBeNull();
    expect(await uri("mb_rec-1")).toMatchObject({
      spotify_anchor_attempted_at: null,
      spotify_anchor_attempts: null,
      spotify_uri: null,
    });
    expect(await uri("mb_rec-3")).toMatchObject({
      spotify_anchor_attempted_at: null,
      spotify_anchor_attempts: null,
      spotify_uri: null,
    });
  });

  it("keeps network probing separate from signed, bounded database commits", async () => {
    vi.stubEnv("ADMIN_SESSION_SECRET", "release-phase-secret");
    const { commitAnchorReleaseLink, probeAnchorReleaseLink, signAnchorReleaseProbe } =
      await import("./anchor");
    await seed("mb_rec-1", "rec-1", "Weightless", 261_901);
    await seed("mb_rec-2", "rec-2", "Signals (VIP)", 279_500);
    const probe = await probeAnchorReleaseLink("mb_rec-1");
    expect(probe.evidence[0]?.recordingIds).toEqual(["rec-1", "rec-2", "rec-3"]);
    expect((await db.execute("select * from anchor_release_links")).rows).toHaveLength(0);
    expect((await uri("mb_rec-1"))?.spotify_uri).toBeNull();
    const proof = await signAnchorReleaseProbe(probe);
    await expect(
      commitAnchorReleaseLink({ ...probe, trackId: "mb_rec-2" }, proof, 0),
    ).rejects.toThrow("invalid or expired release probe");
    const first = await commitAnchorReleaseLink(probe, proof, 0);
    expect(first.anchoredCount).toBe(2);
    expect((await db.execute("select * from anchor_release_links")).rows).toHaveLength(1);
  });

  it("resumes sibling writes at the returned cursor and preserves a newer mapping", async () => {
    const { probeAnchorReleaseLink } = await import("./anchor");
    const { commitReleaseLinks } = await import("./anchor-release-links");
    await seed("mb_rec-1", "rec-1", "Weightless", 261_901);
    await seed("mb_rec-2", "rec-2", "Signals (VIP)", 279_500);
    const probe = await probeAnchorReleaseLink("mb_rec-1");
    await db.execute({
      args: ["release-1", "B".repeat(22), "2099-01-01T00:00:00.000Z"],
      sql: "insert into anchor_release_links (release_mbid, spotify_album_id, checked_at) values (?, ?, ?)",
    });
    const anchored: string[] = [];
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(12_000);
    let first;
    try {
      first = await commitReleaseLinks(probe, async (id) => {
        anchored.push(id);
        return true;
      });
    } finally {
      clock.mockRestore();
    }
    expect(first.remainder).toBe(1);
    expect(first.anchoredCount).toBe(1);
    const second = await commitReleaseLinks(
      probe,
      async (id) => {
        anchored.push(id);
        return true;
      },
      first.remainder ?? 0,
    );
    expect(second.remainder).toBeNull();
    expect(second.anchoredCount).toBe(1);
    expect(anchored).toEqual(["mb_rec-1", "mb_rec-2"]);
    expect(
      (await db.execute("select spotify_album_id from anchor_release_links")).rows[0]
        ?.spotify_album_id,
    ).toBe("B".repeat(22));
  });

  it("round-trips signed release evidence through the admin phase routes", async () => {
    vi.stubEnv("ADMIN_SESSION_SECRET", "release-route-secret");
    vi.stubEnv("FLUNCLE_AGENT_TOKEN", "release-route-agent");
    const { handleOrpc } = await import("./orpc");
    await seed("mb_rec-1", "rec-1", "Weightless", 261_901);
    cache.set(
      `album:${albumId}`,
      JSON.stringify([
        {
          ...albumTracks[0],
          artists: [
            {
              external_urls: { spotify: "https://open.spotify.com/artist/artist1" },
              href: "https://api.spotify.com/v1/artists/artist1",
              id: "artist1",
              name: "Etherwood",
              type: "artist",
              uri: "spotify:artist:artist1",
            },
          ],
        },
      ]),
    );
    const post = async (path: string, body: unknown) =>
      handleOrpc(
        new Request(`https://www.fluncle.com/api/v1${path}`, {
          body: JSON.stringify(body),
          headers: {
            Authorization: "Bearer release-route-agent",
            "Content-Type": "application/json",
          },
          method: "POST",
        }),
      );
    const probed = await post("/admin/catalogue/anchor/release/probe", { trackId: "mb_rec-1" });
    expect(probed?.status).toBe(200);
    const body = (await probed?.json()) as { probe: unknown; proof: string };
    expect(fetchSpotifyAlbumTracks).not.toHaveBeenCalled();
    expect((await db.execute("select * from anchor_release_links")).rows).toHaveLength(0);
    const committed = await post("/admin/catalogue/anchor/release/commit", {
      cursor: 0,
      probe: body.probe,
      proof: body.proof,
    });
    expect(committed?.status).toBe(200);
    expect(await committed?.json()).toMatchObject({ anchored: true, anchoredCount: 1 });
  });

  it("backs off a release with no album and never stores a track list in Turso", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    await seed("mb_rec-1", "rec-1", "Weightless", 261_901);
    mbFetch.mockImplementation(async (path: string) => ({
      data: path.startsWith("/recording/")
        ? { releases: [{ id: "release-1" }] }
        : { media: [], relations: [] },
      rateLimited: false,
    }));
    const first = await resolveAnchorFree("mb_rec-1");
    const second = await resolveAnchorFree("mb_rec-1");
    expect(first.releaseLinkNoAlbum).toBe(1);
    expect(second.releaseLinkNoAlbum ?? 0).toBe(0);
    expect(second.releaseLinkBackoffSkipped).toBe(1);
    expect(
      mbFetch.mock.calls.filter(([path]) => String(path).startsWith("/release/")),
    ).toHaveLength(1);
    const mapping = await db.execute(
      "select spotify_album_id, checked_at from anchor_release_links",
    );
    expect(mapping.rows).toHaveLength(1);
    expect(mapping.rows[0]?.spotify_album_id).toBeNull();
    expect(typeof mapping.rows[0]?.checked_at).toBe("string");
    expect(fetchSpotifyAlbumTracks).not.toHaveBeenCalled();
  });

  it("defers the album fetch when the Spotify gate closes", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    await seed("mb_rec-1", "rec-1", "Weightless", 261_901);
    spotifyAllowed = false;
    const result = await resolveAnchorFree("mb_rec-1");
    expect(result.releaseLinkAlbumsFetched ?? 0).toBe(0);
    expect(fetchSpotifyAlbumTracks).not.toHaveBeenCalled();
    expect((await uri("mb_rec-1"))?.spotify_uri).toBeNull();
  });

  it("does not negative-cache an album when the Spotify gate closes between pages", async () => {
    const { resolveAnchorReleaseLink } = await import("./anchor");
    await seed("mb_rec-1", "rec-1", "Weightless", 261_901);
    fetchSpotifyAlbumTracks.mockImplementationOnce(
      async (_id: string, onPage: () => Promise<void>) => {
        await onPage();
        spotifyAllowed = false;
        await onPage();
        return albumTracks;
      },
    );
    const first = await resolveAnchorReleaseLink("mb_rec-1");
    expect(first.albumFetchFailed).toBe(0);
    expect(cache.has(`album-error:${albumId}`)).toBe(false);
    spotifyAllowed = true;
    const second = await resolveAnchorReleaseLink("mb_rec-1");
    expect(second.albumsFetched).toBe(1);
    expect(fetchSpotifyAlbumTracks).toHaveBeenCalledTimes(2);
  });

  it("yields the release operation on a quota response without charging the row", async () => {
    const { resolveAnchorReleaseLink } = await import("./anchor");
    await seed("mb_rec-1", "rec-1", "Weightless", 261_901);
    fetchSpotifyAlbumTracks.mockRejectedValue(
      new Error("Spotify API request failed: 429 QUOTA_EXCEEDED"),
    );
    const result = await resolveAnchorReleaseLink("mb_rec-1");
    expect(result.throttled).toBe(true);
    expect(fetchTrackMetadata).not.toHaveBeenCalled();
    expect(await uri("mb_rec-1")).toMatchObject({
      spotify_anchor_attempted_at: null,
      spotify_anchor_attempts: null,
      spotify_uri: null,
    });
  });

  it("uses metadata only after the MBID lookup misses and verifies its by-id candidate", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    await seed("mb_rec-1", "rec-1", "Weightless", 261_901, "GBTEST000001");
    mbFetch.mockResolvedValue({ data: { releases: [] }, rateLimited: false });
    lookupSpotifyIdsByMetadata.mockResolvedValue({
      match: { spotifyTrackIds: ["lb-track"] },
      outcome: "match",
    });
    fetchTrackMetadata.mockResolvedValue({
      artists: ["Etherwood"],
      durationMs: 261_800,
      isrc: "GBTEST000001",
      spotifyArtistIds: ["artist1"],
      title: "Weightless",
    });
    const result = await resolveAnchorFree("mb_rec-1");
    expect(result.source).toBe("listenbrainz-metadata");
    expect(fetchTrackMetadata).toHaveBeenCalledWith("lb-track", "anchor");
    expect(lookupSpotifyIdsByMetadata).toHaveBeenCalledTimes(1);

    await seed("mb_rec-2", "rec-2", "Weightless", 261_901, "GBTEST000001");
    lookupSpotifyIdsByMbid.mockResolvedValue({
      match: { spotifyTrackIds: ["lb-track"] },
      outcome: "match",
    });
    await resolveAnchorFree("mb_rec-2");
    expect(lookupSpotifyIdsByMetadata).toHaveBeenCalledTimes(1);
  });
  it("keeps the next rung available after a release 429 or MusicBrainz failure", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    await seed("mb_rec-1", "rec-1", "Weightless", 261_901);
    fetchSpotifyAlbumTracks.mockRejectedValue(new Error("Spotify API request failed: 429"));
    const throttled = await resolveAnchorFree("mb_rec-1");
    expect(throttled.listenbrainzOutcome).toBe("no-map");
    expect(lookupSpotifyIdsByMbid).toHaveBeenCalled();
    mbFetch.mockRejectedValue(new Error("MusicBrainz unavailable"));
    const failed = await resolveAnchorFree("mb_rec-1");
    expect(failed.listenbrainzOutcome).toBe("no-map");
  });

  it("backs off a failed album fetch for one day and counts the failure", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    await seed("mb_rec-1", "rec-1", "Weightless", 261_901);
    fetchSpotifyAlbumTracks.mockRejectedValue(new Error("Spotify API request failed: 404"));
    const first = await resolveAnchorFree("mb_rec-1");
    const second = await resolveAnchorFree("mb_rec-1");
    expect(first.releaseLinkAlbumFetchFailed).toBe(1);
    expect(second.releaseLinkBackoffSkipped).toBe(1);
    expect(fetchSpotifyAlbumTracks).toHaveBeenCalledTimes(1);
  });

  it("refreshes a checked album mapping and an expired miss after thirty days", async () => {
    const { resolveAnchorReleaseLink } = await import("./anchor");
    await seed("mb_rec-1", "rec-1", "Weightless", 261_901);
    await db.execute({
      args: ["release-1", null, "2026-01-01T00:00:00.000Z"],
      sql: "insert into anchor_release_links (release_mbid, spotify_album_id, checked_at) values (?, ?, ?)",
    });
    mbFetch.mockImplementation(async (path: string) => ({
      data: path.startsWith("/recording/")
        ? { releases: [{ id: "release-1" }] }
        : { media: [], relations: [] },
      rateLimited: false,
    }));
    const now = new Date("2026-10-01T00:00:00.000Z");
    const miss = await resolveAnchorReleaseLink("mb_rec-1", now);
    expect(miss.noAlbum).toBe(1);
    expect(
      (await db.execute("select checked_at from anchor_release_links")).rows[0]?.checked_at,
    ).toBe(now.toISOString());
    await db.execute({
      args: [albumId, "2026-01-01T00:00:00.000Z", "release-1"],
      sql: "update anchor_release_links set spotify_album_id = ?, checked_at = ? where release_mbid = ?",
    });
    const album = await resolveAnchorReleaseLink("mb_rec-1", now);
    expect(album.noAlbum).toBe(1);
    expect(
      (await db.execute("select spotify_album_id from anchor_release_links")).rows[0]
        ?.spotify_album_id,
    ).toBeNull();
  });

  it("keeps a fresh album mapping while reading its release siblings", async () => {
    const { probeAnchorReleaseLink } = await import("./anchor");
    await seed("mb_rec-1", "rec-1", "Weightless", 261_901);
    const checkedAt = "2026-09-20T00:00:00.000Z";
    await db.execute({
      args: ["release-1", albumId, checkedAt],
      sql: "insert into anchor_release_links (release_mbid, spotify_album_id, checked_at) values (?, ?, ?)",
    });
    mbFetch.mockImplementation(async (path: string) => ({
      data: path.startsWith("/recording/")
        ? { releases: [{ id: "release-1" }] }
        : { media: [{ tracks: [{ recording: { id: "rec-1" } }] }], relations: [] },
      rateLimited: false,
    }));
    const probe = await probeAnchorReleaseLink("mb_rec-1", new Date("2026-10-01T00:00:00.000Z"));
    expect(probe.evidence[0]).toMatchObject({
      albumId,
      checkedAt: null,
      siblingTrackIds: ["mb_rec-1"],
    });
    expect(
      (await db.execute("select checked_at from anchor_release_links")).rows[0]?.checked_at,
    ).toBe(checkedAt);
  });

  it("reads every release's prior link in one query and honours each one", async () => {
    const { probeAnchorReleaseLink } = await import("./anchor");
    await seed("mb_rec-1", "rec-1", "Weightless", 261_901);
    const checkedAt = "2026-09-20T00:00:00.000Z";
    const mappedAlbum = "B".repeat(22);
    await db.execute({
      args: ["release-1", null, checkedAt, "release-2", mappedAlbum, checkedAt],
      sql: "insert into anchor_release_links (release_mbid, spotify_album_id, checked_at) values (?, ?, ?), (?, ?, ?)",
    });
    mbFetch.mockImplementation(async (path: string) => ({
      data: path.startsWith("/recording/")
        ? { releases: [{ id: "release-1" }, { id: "release-2" }, { id: "release-3" }] }
        : {
            media: [{ tracks: [{ recording: { id: "rec-1" } }] }],
            relations: [{ url: { resource: `https://open.spotify.com/album/${albumId}` } }],
          },
      rateLimited: false,
    }));
    const execute = vi.spyOn(db, "execute");
    const now = new Date("2026-10-01T00:00:00.000Z");
    const probe = await probeAnchorReleaseLink("mb_rec-1", now);
    const linkReads = execute.mock.calls.filter(([statement]) =>
      /from anchor_release_links/.test(typeof statement === "string" ? statement : statement.sql),
    );
    execute.mockRestore();
    expect(linkReads).toHaveLength(1);
    expect(probe.result.backoffSkipped).toBe(1);
    expect(
      probe.evidence.map(({ albumId: id, checkedAt: at, releaseId }) => [releaseId, id, at]),
    ).toEqual([
      ["release-2", mappedAlbum, null],
      ["release-3", albumId, now.toISOString()],
    ]);
    expect(
      mbFetch.mock.calls.filter(([path]) => String(path).startsWith("/release/release-1")),
    ).toHaveLength(0);
  });

  it("caches recording-to-release IDs for thirty days", async () => {
    const { probeAnchorReleaseLink } = await import("./anchor");
    await seed("mb_rec-1", "rec-1", "Weightless", 261_901);
    await probeAnchorReleaseLink("mb_rec-1");
    await probeAnchorReleaseLink("mb_rec-1");
    expect(
      mbFetch.mock.calls.filter(([path]) => String(path).startsWith("/recording/")),
    ).toHaveLength(1);
    expect(cachePut).toHaveBeenCalledWith("recording-releases:rec-1", '["release-1"]', {
      expirationTtl: 30 * 24 * 60 * 60,
    });
  });

  it("anchors only eligible sibling catalogue rows", async () => {
    const { resolveAnchorReleaseLink } = await import("./anchor");
    const exclusions = ["dismissed", "duplicate", "capped", "various", "certified", "disabled"];
    await seed("mb_rec-1", "rec-1", "Weightless", 261_901);
    for (const name of exclusions) {
      await seed(`mb_${name}`, "rec-1", "Weightless", 261_901);
    }
    await db.execute(
      "update tracks set dismissed_at = '2026-01-01' where track_id = 'mb_dismissed'",
    );
    await db.execute(
      "update tracks set duplicate_of_track_id = 'mb_rec-1' where track_id = 'mb_duplicate'",
    );
    await db.execute("update tracks set spotify_anchor_attempts = 6 where track_id = 'mb_capped'");
    await db.execute(
      "update tracks set artists_json = '[\"Various Artists\"]' where track_id = 'mb_various'",
    );
    await db.execute(
      "insert into findings (track_id, added_at) values ('mb_certified', '2026-01-01')",
    );
    await db.execute(`insert into labels (id, name, slug, seed_state, created_at, updated_at)
                      values ('disabled', 'Disabled', 'disabled', 'disabled', '2026-01-01', '2026-01-01')`);
    await db.execute("update tracks set label_id = 'disabled' where track_id = 'mb_disabled'");
    const result = await resolveAnchorReleaseLink("mb_rec-1");
    expect(result.anchoredCount).toBe(1);
    for (const name of exclusions) {
      expect((await uri(`mb_${name}`))?.spotify_uri).toBeNull();
    }
  });

  it("re-checks sibling eligibility at commit time", async () => {
    vi.stubEnv("ADMIN_SESSION_SECRET", "release-phase-secret");
    const { commitAnchorReleaseLink, probeAnchorReleaseLink, signAnchorReleaseProbe } =
      await import("./anchor");
    await seed("mb_rec-1", "rec-1", "Weightless", 261_901);
    await seed("mb_rec-2", "rec-2", "Signals (VIP)", 279_500);
    const probe = await probeAnchorReleaseLink("mb_rec-1");
    await db.execute("update tracks set dismissed_at = '2026-01-01' where track_id = 'mb_rec-2'");

    const result = await commitAnchorReleaseLink(probe, await signAnchorReleaseProbe(probe), 0);
    expect(result.anchoredCount).toBe(1);
    expect((await uri("mb_rec-1"))?.spotify_uri).toBe("spotify:track:spotify-one");
    expect((await uri("mb_rec-2"))?.spotify_uri).toBeNull();
  });

  it("skips a malformed album track and never caches an empty track list", async () => {
    const { resolveAnchorReleaseLink } = await import("./anchor");
    await seed("mb_rec-1", "rec-1", "Weightless", 261_901);
    cache.set(
      `album:${albumId}`,
      JSON.stringify([
        { ...albumTracks[0], artists: [{ id: null, name: "Broken" }] },
        albumTracks[1],
      ]),
    );

    const result = await resolveAnchorReleaseLink("mb_rec-1");
    expect(result.cacheHits).toBe(1);
    expect((await uri("mb_rec-1"))?.spotify_uri).toBeNull();

    cache.clear();
    cachePut.mockClear();
    fetchSpotifyAlbumTracks.mockImplementation(async (_id: string, onPage: () => Promise<void>) => {
      await onPage();
      return [];
    });
    await resolveAnchorReleaseLink("mb_rec-1");
    expect(cachePut).not.toHaveBeenCalledWith(
      `album:${albumId}`,
      expect.anything(),
      expect.anything(),
    );
  });

  it("uses ListenBrainz metadata for a row with no recording MBID", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    await seed("mb_no-mbid", "", "Weightless", 261_901);
    lookupSpotifyIdsByMetadata.mockResolvedValue({
      match: { spotifyTrackIds: ["lb-track"] },
      outcome: "match",
    });
    fetchTrackMetadata.mockResolvedValue({
      artists: ["Etherwood"],
      durationMs: 261_800,
      isrc: null,
      spotifyArtistIds: ["artist1"],
      title: "Weightless",
    });
    const result = await resolveAnchorFree("mb_no-mbid");
    expect(result.source).toBe("listenbrainz-metadata");
    expect(lookupSpotifyIdsByMetadata).toHaveBeenCalledTimes(1);
  });
});
