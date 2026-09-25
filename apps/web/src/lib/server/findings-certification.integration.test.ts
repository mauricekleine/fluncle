import { type Client } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createIntegrationDb,
  seedCatalogueTrack,
  seedEmbedding,
  seedTrack,
} from "./integration-db";
import { renderSitemap } from "./sitemap-test-kit";

let db: Client;
let fixtureDirectory: string | undefined;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

const playlistAdds: string[] = [];
const telegramPosts: { logId?: string; spotifyUrl: string }[] = [];
const blueskyPosts: string[] = [];
let isrcLookup: {
  match?: { albumImageUrl?: string; spotifyUri: string; spotifyUrl: string; trackId: string };
  rateLimited: boolean;
} = { rateLimited: false };

vi.mock("./spotify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./spotify")>();

  return {
    ...actual,
    addTrackToPlaylist: vi.fn(async (track: { spotifyUri: string }) => {
      playlistAdds.push(track.spotifyUri);
    }),
    findSpotifyTrackByIsrc: vi.fn(async () => isrcLookup),
  };
});

let recoveredIsrc: string | undefined;
vi.mock("./anchor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./anchor")>();

  return { ...actual, recoverIsrcViaDeezer: vi.fn(async () => recoveredIsrc) };
});

vi.mock("./telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./telegram")>();

  return {
    ...actual,
    postToTelegram: vi.fn(async (track: { spotifyUrl: string }, _note?: string, logId?: string) => {
      telegramPosts.push({ logId, spotifyUrl: track.spotifyUrl });
    }),
  };
});

vi.mock("./lastfm", () => ({ lastfmLove: vi.fn(async () => undefined) }));
vi.mock("./push", () => ({ notifyNewFinding: vi.fn(() => undefined) }));
vi.mock("./bluesky", () => ({
  postToBluesky: vi.fn(async (track: { trackId: string }) => {
    blueskyPosts.push(track.trackId);
  }),
}));

const NOW = "2026-07-01T00:00:00.000Z";
const FINDING_ID = "aaaaaaaaaaaaaaaaaaaaaa";
const CATALOGUE_ID = "bbbbbbbbbbbbbbbbbbbbbb";

async function embed(trackId: string, first: number): Promise<void> {
  await seedEmbedding(db, trackId, [first, ...Array.from({ length: 1023 }, () => 0.01)]);
}

beforeEach(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "fluncle-findings-certification-"));
  db = await createIntegrationDb({ url: `file:${join(fixtureDirectory, "fixture.db")}` });

  await seedTrack(db, {
    addedToSpotify: true,
    logId: "004.7.2I",
    postedToTelegram: true,
    title: "A Certified Track",
    trackId: FINDING_ID,
  });
  await seedCatalogueTrack(db, { title: "An Uncertified Catalogue Track", trackId: CATALOGUE_ID });
  playlistAdds.length = 0;
  telegramPosts.length = 0;
  blueskyPosts.length = 0;
  isrcLookup = { rateLimited: false };
  recoveredIsrc = undefined;
});

afterEach(async () => {
  db.close();

  if (fixtureDirectory !== undefined) {
    await rm(fixtureDirectory, { force: true, recursive: true });
    fixtureDirectory = undefined;
  }
});

describe("the tracks/findings split — an uncertified catalogue track is not a finding", () => {
  it("seeds exactly what it claims: two tracks, one finding", async () => {
    const tracks = await db.execute("select count(*) as n from tracks");
    const findings = await db.execute("select count(*) as n from findings");

    expect(Number(tracks.rows[0]?.n)).toBe(2);
    expect(Number(findings.rows[0]?.n)).toBe(1);
  });

  it("maintains is_catalogue as the materialized discriminator: catalogue=1, finding=0", async () => {
    const catalogue = await db.execute({
      args: [CATALOGUE_ID],
      sql: "select is_catalogue from tracks where track_id = ?",
    });
    const finding = await db.execute({
      args: [FINDING_ID],
      sql: "select is_catalogue from tracks where track_id = ?",
    });

    expect(Number(catalogue.rows[0]?.is_catalogue)).toBe(1);
    expect(Number(finding.rows[0]?.is_catalogue)).toBe(0);
  });

  it("keeps the feed blind to it — listTracks returns the finding only, and counts one", async () => {
    const { listTracks } = await import("./tracks");
    const page = await listTracks({ limit: 50 });

    expect(page.tracks.map((track) => track.trackId)).toEqual([FINDING_ID]);

    expect(page.totalCount).toBe(1);
  });

  it("cannot be fetched by id through a finding read (getTrackByIdOrLogId)", async () => {
    const { getTrackByIdOrLogId } = await import("./tracks");

    await expect(getTrackByIdOrLogId(FINDING_ID)).resolves.toMatchObject({ logId: "004.7.2I" });

    await expect(getTrackByIdOrLogId(CATALOGUE_ID)).resolves.toBeUndefined();
  });

  it("never surfaces through admin search, however matchable its title is", async () => {
    const { searchTracks } = await import("./tracks");

    const hits = await searchTracks({ q: "track" });

    expect(hits.map((hit) => hit.trackId)).toEqual([FINDING_ID]);
  });

  it("is absent from a batched id hydrate (getTracksByIds drops it silently)", async () => {
    const { getTracksByIds } = await import("./tracks");

    const byId = await getTracksByIds([FINDING_ID, CATALOGUE_ID]);

    expect(Object.keys(byId)).toEqual([FINDING_ID]);
  });

  it("is invisible to the enrichment queue — a catalogue track is nobody's work item", async () => {
    const { listTracks } = await import("./tracks");

    const queue = await listTracks({ limit: 50, status: "queue" });

    expect(queue.tracks.map((track) => track.trackId)).toEqual([FINDING_ID]);
  });

  it('never surfaces in "more like this", even when it HAS an embedding', async () => {
    const { getSimilarFindings } = await import("./tracks");

    const target = "cccccccccccccccccccccc";
    await seedTrack(db, { logId: "004.7.3J", title: "The Target", trackId: target });

    await embed(target, 1);
    await embed(CATALOGUE_ID, 0.99);
    await embed(FINDING_ID, 0.2);

    const similar = await getSimilarFindings(target, 6, { allowBoundedSql: true });

    expect(similar.map((item) => item.trackId)).toEqual([FINDING_ID]);
  });

  it("does not inflate a label's finding count", async () => {
    const { listLabelsPage } = await import("./labels");

    await db.execute("update tracks set label = 'Hospital Records'");
    await db.execute({
      args: [NOW, NOW],
      sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
            values ('l1', 'Hospital Records', 'hospital-records', 'undecided', ?, ?)`,
    });
    await db.execute("update tracks set label_id = 'l1'");

    const page = await listLabelsPage("undecided", 1);

    expect(page.items.find((label) => label.slug === "hospital-records")?.findingCount).toBe(1);
  });

  it("a certification can be REVOKED by deleting its findings row — the track survives", async () => {
    const { getTrackByIdOrLogId, listTracks } = await import("./tracks");

    await db.execute({ args: [FINDING_ID], sql: `delete from findings where track_id = ?` });

    const rows = await db.execute("select count(*) as n from tracks");
    expect(Number(rows.rows[0]?.n)).toBe(2);

    await expect(getTrackByIdOrLogId(FINDING_ID)).resolves.toBeUndefined();
    expect((await listTracks({ limit: 50 })).tracks).toEqual([]);
  });
});

describe("the certification rail — a catalogue track is measured, never spoken about", () => {
  const analysisOf = async (trackId: string) => {
    const result = await db.execute({
      args: [trackId],
      sql: `select bpm, key, features_json, analyzed_from,
                   has_embedding as has_vector, source_audio_key, source_verification
            from tracks where track_id = ?`,
    });

    return result.rows[0];
  };

  it("CAN be analysed — bpm, key, features and the provenance all land on the tracks row", async () => {
    const { updateTrack } = await import("./track-update");

    const result = await updateTrack(
      CATALOGUE_ID,
      {
        analyzedFrom: "full",
        bpm: 174,
        bpmSource: "dsp",
        features: JSON.stringify({ centroidHz: 2100 }),
        key: "9A",
        keySource: "dsp",
      },
      { writer: "agent" },
    );

    expect(result.trackId).toBe(CATALOGUE_ID);

    const row = await analysisOf(CATALOGUE_ID);
    expect(Number(row?.bpm)).toBe(174);
    expect(row?.key).toBe("9A");
    expect(row?.analyzed_from).toBe("full");
    expect(row?.features_json).toBe(JSON.stringify({ centroidHz: 2100 }));
  });

  it("CAN be embedded — the write lands the F32_BLOB the Ear ranks against", async () => {
    const { updateTrack } = await import("./track-update");

    const vector = JSON.stringify(Array.from({ length: 1024 }, () => 0.03125));
    await updateTrack(CATALOGUE_ID, { embedding: vector }, { writer: "agent" });

    const row = await db.execute({
      args: [CATALOGUE_ID],
      sql: `select count(*) as b from track_embeddings where track_id = ?`,
    });
    expect(Number(row.rows[0]?.b)).toBe(1);
  });

  it("CAN take the capture side-channel — the bytes are a property of the recording", async () => {
    const { updateTrack } = await import("./track-update");

    await updateTrack(
      CATALOGUE_ID,
      {
        captureStatus: "done",
        sourceAudioKey: `${CATALOGUE_ID}/abc.webm`,
        sourceVerification: "soundcloud-archive-match",
      },
      { writer: "agent" },
    );

    const row = await analysisOf(CATALOGUE_ID);
    expect(row?.source_audio_key).toBe(`${CATALOGUE_ID}/abc.webm`);
    expect(row?.source_verification).toBe("soundcloud-archive-match");
  });

  it("CANNOT get a NOTE — Fluncle does not write about a track he has not been to", async () => {
    const { updateTrack } = await import("./track-update");

    await expect(
      updateTrack(CATALOGUE_ID, { note: "A monster of a roller." }, { writer: "operator" }),
    ).rejects.toMatchObject({ code: "uncertified", status: 409 });

    const { fillEmptyNote } = await import("./track-update");
    await expect(fillEmptyNote(CATALOGUE_ID, "An auto-authored note.")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("CANNOT get an OBSERVATION — no spoken word about an uncertified track", async () => {
    const { updateTrack } = await import("./track-update");

    await expect(
      updateTrack(
        CATALOGUE_ID,
        {
          observationAudioUrl: "https://example.invalid/observation.mp3",
          observationDurationMs: 12_000,
          observationGeneratedAt: NOW,
          observationScript: "Recovered audio, fragmentary.",
        },
        { writer: "agent" },
      ),
    ).rejects.toMatchObject({ code: "uncertified", status: 409 });
  });

  it("CANNOT get a VIDEO — the render is a certification artifact", async () => {
    const { updateTrack } = await import("./track-update");

    await expect(
      updateTrack(
        CATALOGUE_ID,
        { videoUrl: "https://example.invalid/footage.mp4", videoVehicle: "submarine" },
        { writer: "operator" },
      ),
    ).rejects.toMatchObject({ code: "uncertified", status: 409 });
  });

  it("CANNOT be PUBLISHED — `requireTrack`, the guard on every publish + video op, is blind to it", async () => {
    const { requireTrack } = await import("./orpc/_shared");

    await expect(requireTrack(FINDING_ID)).resolves.toMatchObject({ logId: "004.7.2I" });
    await expect(requireTrack(CATALOGUE_ID)).rejects.toMatchObject({ status: 404 });

    const { listSocialPosts } = await import("./social");
    expect(await listSocialPosts(CATALOGUE_ID)).toEqual([]);
  });

  it("CANNOT get a context note, a galaxy, an enrichment status, or a COORDINATE", async () => {
    const { updateTrack } = await import("./track-update");

    const forbidden = [
      { contextNote: "Facts from the web." },
      { contextStatus: "resolved" as const },
      { enrichmentStatus: "done" as const },
      { galaxyId: "g1" },
      { logId: "auto" },
    ];

    for (const update of forbidden) {
      await expect(updateTrack(CATALOGUE_ID, update, { writer: "operator" })).rejects.toMatchObject(
        { code: "uncertified", status: 409 },
      );
    }
  });

  it("names the refused field, and never half-applies the write", async () => {
    const { updateTrack } = await import("./track-update");

    await expect(
      updateTrack(CATALOGUE_ID, { bpm: 174, note: "Sneaking a note in." }, { writer: "operator" }),
    ).rejects.toMatchObject({ code: "uncertified", message: expect.stringContaining("note") });

    expect((await analysisOf(CATALOGUE_ID))?.bpm).toBeNull();
  });

  it("never INSERTs a findings row — certifying a track is publish_track's job alone", async () => {
    const { updateTrack } = await import("./track-update");

    await updateTrack(CATALOGUE_ID, { bpm: 174 }, { writer: "agent" });

    const findings = await db.execute("select count(*) as n from findings");
    expect(Number(findings.rows[0]?.n)).toBe(1);
  });

  it("never bumps a lastmod it does not have — an analysis write is not news", async () => {
    const { updateTrack } = await import("./track-update");

    await updateTrack(CATALOGUE_ID, { bpm: 174 }, { writer: "agent" });

    const findings = await db.execute({
      args: [CATALOGUE_ID],
      sql: `select count(*) as n from findings where track_id = ?`,
    });
    expect(Number(findings.rows[0]?.n)).toBe(0);
  });

  it("still lets a FINDING take every one of those fields — the rail gates on certification, not on the field", async () => {
    const { updateTrack } = await import("./track-update");

    const result = await updateTrack(
      FINDING_ID,
      { bpm: 174, note: "A monster of a roller.", videoVehicle: "submarine" },
      { writer: "operator" },
    );

    expect(result.fields).toEqual(expect.arrayContaining(["bpm", "note", "video_vehicle"]));
  });
});

describe("a CRAWLED track never reaches a public surface", () => {
  const CRAWLED_ID = "mb_9f2b1c44-0000-4000-8000-abcdefabcdef";

  beforeEach(async () => {
    await db.execute({
      args: [CRAWLED_ID],
      sql: `insert into tracks (track_id, title, artists_json, duration_ms, label, isrc)
            values (?, 'A Crawled Track', '["Etherwood"]', 261901, 'Med School', 'GBCJY1300173')`,
    });
  });

  it("has no findings row — the crawler cannot certify, because it has no ears", async () => {
    const row = await db.execute({
      args: [CRAWLED_ID],
      sql: "select count(*) as n from findings where track_id = ?",
    });

    expect(Number(row.rows[0]?.n)).toBe(0);
  });

  it("is absent from /log — there is no coordinate to land on", async () => {
    const { getTrackByIdOrLogId, listTracks } = await import("./tracks");

    const feed = await listTracks({ limit: 50 });
    expect(feed.tracks.map((track) => track.trackId)).not.toContain(CRAWLED_ID);
    await expect(getTrackByIdOrLogId(CRAWLED_ID)).resolves.toBeUndefined();
  });

  it("is absent from the RSS feed (the real /rss.xml handler)", async () => {
    const { Route } = await import("../../routes/rss[.]xml");
    const handlers = Route.options.server?.handlers as
      | { GET: (ctx: unknown) => Promise<Response> }
      | undefined;
    const xml = await (await handlers?.GET({}))?.text();

    expect(xml).toContain("A Certified Track");
    expect(xml).not.toContain("A Crawled Track");
  });

  it("is absent from the sitemap (the real handlers — the index AND every child)", async () => {
    const { indexXml, shards, xml } = await renderSitemap();

    expect(indexXml).toContain("<sitemapindex");
    expect(shards).toContain("pages-1.xml");
    expect(shards).toContain("findings-1.xml");

    expect(xml).toContain("/log/004.7.2I");
    expect(xml).not.toContain(CRAWLED_ID);

    expect(xml).not.toContain("A Crawled Track");
  });

  it("is absent from the Galaxy game's star field", async () => {
    const { listTracks } = await import("./tracks");

    const page = await listTracks({ limit: 50 });

    expect(page.tracks.every((track) => track.logId)).toBe(true);
    expect(page.tracks.map((track) => track.trackId)).not.toContain(CRAWLED_ID);
  });

  it("is nobody's work item — it cannot enter the capture or enrichment queue", async () => {
    const { listTracks } = await import("./tracks");

    const crawled = await db.execute({
      args: [CRAWLED_ID],
      sql: "select capture_status from tracks where track_id = ?",
    });
    expect(crawled.rows[0]?.capture_status).toBe("pending");

    const capture = await listTracks({ captureQueue: true, limit: 50 });
    expect(capture.tracks.map((track) => track.trackId)).not.toContain(CRAWLED_ID);

    const enrich = await listTracks({ limit: 50, status: "queue" });
    expect(enrich.tracks.map((track) => track.trackId)).not.toContain(CRAWLED_ID);
  });
});

describe("certify in place — logging an existing catalogue track without creating a new one", () => {
  it("mints the finding for the existing row, and creates NO new track", async () => {
    const { certifyExistingTrack } = await import("./publish");

    const before = await db.execute("select count(*) as n from tracks");
    const { logId } = await certifyExistingTrack(CATALOGUE_ID, {
      note: "logged from the telescope",
    });

    expect(logId).toMatch(/\d{3}\.\d+\.\d+[A-Z]/);
    const after = await db.execute("select count(*) as n from tracks");
    expect(Number(after.rows[0]?.n)).toBe(Number(before.rows[0]?.n));

    const finding = await db.execute({
      args: [CATALOGUE_ID],
      sql: "select log_id, note from findings where track_id = ?",
    });
    expect(finding.rows[0]?.log_id).toBe(logId);
    expect(finding.rows[0]?.note).toBe("logged from the telescope");

    const flag = await db.execute({
      args: [CATALOGUE_ID],
      sql: "select is_catalogue from tracks where track_id = ?",
    });
    expect(Number(flag.rows[0]?.is_catalogue)).toBe(0);
  });

  it("REFUSES a row that is certified AND fully announced (409) — never a second finding", async () => {
    const { certifyExistingTrack } = await import("./publish");

    await expect(certifyExistingTrack(FINDING_ID)).rejects.toThrow(/already logged/i);

    const findings = await db.execute({
      args: [FINDING_ID],
      sql: "select count(*) as n from findings where track_id = ?",
    });
    expect(Number(findings.rows[0]?.n)).toBe(1);
  });

  it("REFUSES a track that does not exist (404)", async () => {
    const { certifyExistingTrack } = await import("./publish");

    await expect(certifyExistingTrack("cccccccccccccccccccccc")).rejects.toThrow(/no track/i);
  });

  it("credits the label, the album AND every credited artist's certified count, leaving renderable alone", async () => {
    const { certifyExistingTrack } = await import("./publish");
    const now = "2026-07-26T00:00:00.000Z";

    await db.batch(
      [
        {
          args: [now, now],
          sql: `insert into labels (id, name, slug, created_at, updated_at, renderable_track_count, certified_finding_count)
                values ('lab-1', 'Hospital Records', 'hospital-records', ?, ?, 1, 0)`,
        },
        {
          args: [now, now],
          sql: `insert into albums (id, name, slug, created_at, updated_at, renderable_track_count, certified_finding_count)
                values ('alb-1', 'Sight To Behold', 'sight-to-behold', ?, ?, 1, 0)`,
        },
        {
          args: [now, now],
          sql: `insert into artists (id, name, slug, created_at, updated_at, renderable_track_count, certified_finding_count)
                values ('art-1', 'Logistics', 'logistics', ?, ?, 1, 0)`,
        },
        {
          args: [CATALOGUE_ID],
          sql: `update tracks set label_id = 'lab-1', album_id = 'alb-1' where track_id = ?`,
        },
        {
          args: [CATALOGUE_ID],
          sql: `insert into track_artists (track_id, artist_id, position) values (?, 'art-1', 1)`,
        },
      ],
      "write",
    );

    await certifyExistingTrack(CATALOGUE_ID);

    const counted = await db.execute(
      `select 'labels' as kind, renderable_track_count as r, certified_finding_count as c from labels where id = 'lab-1'
       union all
       select 'albums', renderable_track_count, certified_finding_count from albums where id = 'alb-1'
       union all
       select 'artists', renderable_track_count, certified_finding_count from artists where id = 'art-1'`,
    );

    for (const row of counted.rows) {
      expect({ c: Number(row.c), kind: row.kind, r: Number(row.r) }).toEqual({
        c: 1,
        kind: row.kind,
        r: 1,
      });
    }
  });

  it("fans out on mint — resolves presence by exact ISRC, adds to the playlist, posts to Telegram", async () => {
    const { certifyExistingTrack } = await import("./publish");

    await db.execute({
      args: ["GBTEST7700042", CATALOGUE_ID],
      sql: "update tracks set isrc = ?, spotify_uri = null, spotify_url = null where track_id = ?",
    });
    isrcLookup = {
      match: {
        spotifyUri: "spotify:track:resolved42",
        spotifyUrl: "https://open.spotify.com/track/resolved42",
        trackId: "resolved42",
      },
      rateLimited: false,
    };

    const { logId } = await certifyExistingTrack(CATALOGUE_ID);

    expect(playlistAdds).toEqual(["spotify:track:resolved42"]);
    expect(telegramPosts).toEqual([
      { logId, spotifyUrl: "https://open.spotify.com/track/resolved42" },
    ]);

    expect(blueskyPosts).toEqual([CATALOGUE_ID]);

    const finding = await db.execute({
      args: [CATALOGUE_ID],
      sql: "select added_to_spotify, posted_to_telegram, spotify_error from findings where track_id = ?",
    });
    expect(Number(finding.rows[0]?.added_to_spotify)).toBe(1);
    expect(Number(finding.rows[0]?.posted_to_telegram)).toBe(1);
    expect(finding.rows[0]?.spotify_error).toBeNull();
    const track = await db.execute({
      args: [CATALOGUE_ID],
      sql: "select spotify_uri from tracks where track_id = ?",
    });
    expect(track.rows[0]?.spotify_uri).toBe("spotify:track:resolved42");
  });

  it("recovers a missing ISRC before minting — an ISRC-less catalogue row is never born silent", async () => {
    const { certifyExistingTrack } = await import("./publish");

    await db.execute({
      args: [CATALOGUE_ID],
      sql: "update tracks set isrc = null, spotify_uri = null, spotify_url = null where track_id = ?",
    });

    recoveredIsrc = "GBTEST9900001";
    isrcLookup = {
      match: {
        spotifyUri: "spotify:track:recovered1",
        spotifyUrl: "https://open.spotify.com/track/recovered1",
        trackId: "recovered1",
      },
      rateLimited: false,
    };

    const { logId } = await certifyExistingTrack(CATALOGUE_ID);

    expect(logId).toMatch(/\d{3}\.\d+\.\d+[A-Z]/);
    const track = await db.execute({
      args: [CATALOGUE_ID],
      sql: "select spotify_uri from tracks where track_id = ?",
    });
    expect(track.rows[0]?.spotify_uri).toBe("spotify:track:recovered1");
  });

  it("REFUSES to certify without a Spotify anchor — 409, mints nothing, announces nothing", async () => {
    const { certifyExistingTrack } = await import("./publish");

    await db.execute({
      args: [CATALOGUE_ID],
      sql: "update tracks set spotify_uri = null, spotify_url = null where track_id = ?",
    });

    await expect(certifyExistingTrack(CATALOGUE_ID)).rejects.toThrow(/no spotify identity/i);

    expect(playlistAdds).toEqual([]);
    expect(blueskyPosts).toEqual([]);
    expect(telegramPosts).toEqual([]);
    const findings = await db.execute({
      args: [CATALOGUE_ID],
      sql: "select count(*) as n from findings where track_id = ?",
    });
    expect(Number(findings.rows[0]?.n)).toBe(0);
  });

  it("certifies clean once the anchor lands — the 409'd track's ISRC resolves later", async () => {
    const { certifyExistingTrack } = await import("./publish");

    await db.execute({
      args: [CATALOGUE_ID],
      sql: "update tracks set spotify_uri = null, spotify_url = null where track_id = ?",
    });
    await expect(certifyExistingTrack(CATALOGUE_ID)).rejects.toThrow(/no spotify identity/i);
    expect(telegramPosts).toEqual([]);

    await db.execute({
      args: ["GBTEST7700043", CATALOGUE_ID],
      sql: "update tracks set isrc = ? where track_id = ?",
    });
    isrcLookup = {
      match: {
        spotifyUri: "spotify:track:late43",
        spotifyUrl: "https://open.spotify.com/track/late43",
        trackId: "late43",
      },
      rateLimited: false,
    };

    const { logId } = await certifyExistingTrack(CATALOGUE_ID);

    expect(playlistAdds).toEqual(["spotify:track:late43"]);
    expect(telegramPosts).toEqual([{ logId, spotifyUrl: "https://open.spotify.com/track/late43" }]);
    const findings = await db.execute({
      args: [CATALOGUE_ID],
      sql: "select count(*) as n from findings where track_id = ?",
    });
    expect(Number(findings.rows[0]?.n)).toBe(1);
    const track = await db.execute({
      args: [CATALOGUE_ID],
      sql: "select spotify_uri from tracks where track_id = ?",
    });
    expect(track.rows[0]?.spotify_uri).toBe("spotify:track:late43");
  });
});
