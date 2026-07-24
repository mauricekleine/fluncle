import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";
import { renderSitemap } from "./sitemap-test-kit";

// THE SAFETY PROPERTY OF THE tracks/findings SPLIT, proven against the REAL schema.
//
// `tracks` is the universal music object; `findings` is the certification (the Log ID,
// the note, the video, the found date). The whole reason the split exists is that a read
// which wants a coordinate MUST join through `findings` — so it structurally CANNOT
// mistake a raw catalogue track for a certified finding (docs/track-lifecycle.md).
//
// A mock cannot prove that: the guarantee lives in the SQL. So these cases seed an
// UNCERTIFIED catalogue track (a `tracks` row with NO `findings` row — the shape the
// catalogue epic will land in bulk) beside a real certified finding, and assert that
// every finding surface is blind to it. If someone later "helpfully" denormalises
// `log_id` back onto `tracks`, or drops a join, these fail.
//
// They run on the in-memory libSQL database built from the generated migrations, so the
// schema under test is byte-identical to production.

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

// ── The certify announce fan-out's side-effect seams (publish.ts) ─────────────────────────
// Certify now rides the same announce legs as the Spotify add (operator ruling, 2026-07-13), so
// the network-touching modules are stubbed with recorders. Partial mocks: everything else on
// each module (ApiError, the parsers) stays real.
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

// The pre-mint ISRC recovery (a verified Deezer-by-name lookup, tested for real in anchor's own
// suite). Mocked OFF by default so every existing certify case stays hermetic (no Deezer network)
// and behaves exactly as before; one case below flips it on to prove certify wires it in.
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
const FINDING_ID = "aaaaaaaaaaaaaaaaaaaaaa"; // 22 chars, the tracks PK shape
const CATALOGUE_ID = "bbbbbbbbbbbbbbbbbbbbbb";
// The write the agent-tier `update_track` path performs (embedding.ts): the validated JSON
// array converted server-side into the native F32_BLOB the database ranks in SQL.
const EMBED = `update tracks set embedding_blob = vector32(?) where track_id = ?`;

beforeEach(async () => {
  db = await createIntegrationDb();
  // Seeded FULLY ANNOUNCED (both legs done): certify's resume semantics re-run missing legs on
  // an incompletely-announced finding, so only a complete one exercises the 409.
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

describe("the tracks/findings split — an uncertified catalogue track is not a finding", () => {
  it("seeds exactly what it claims: two tracks, one finding", async () => {
    const tracks = await db.execute("select count(*) as n from tracks");
    const findings = await db.execute("select count(*) as n from findings");

    expect(Number(tracks.rows[0]?.n)).toBe(2);
    expect(Number(findings.rows[0]?.n)).toBe(1);
  });

  it("maintains is_catalogue as the materialized discriminator: catalogue=1, finding=0", async () => {
    // The keystone invariant (docs/db-scale-backlog Wave 2 #1): `is_catalogue = 1` iff a track has
    // NO findings row. The catalogue track is born 1 (the DDL default); the certified track carries
    // a findings row, so seedTrack flipped it to 0 — exactly as publishTrack/certifyExistingTrack do.
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
    // The "Found · N" counter must not inflate with the catalogue either — the count
    // query runs over the SAME join, not a bare `count(*) from tracks`.
    expect(page.totalCount).toBe(1);
  });

  it("cannot be fetched by id through a finding read (getTrackByIdOrLogId)", async () => {
    const { getTrackByIdOrLogId } = await import("./tracks");

    await expect(getTrackByIdOrLogId(FINDING_ID)).resolves.toMatchObject({ logId: "004.7.2I" });
    // The catalogue track EXISTS in `tracks` — the join is the only thing hiding it.
    await expect(getTrackByIdOrLogId(CATALOGUE_ID)).resolves.toBeUndefined();
  });

  it("never surfaces through admin search, however matchable its title is", async () => {
    const { searchTracks } = await import("./tracks");

    // BOTH titles contain "track", so only the join can be what excludes the catalogue one.
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

    // `enrichment_status` lives on `findings` and defaults to `pending`, so the certified
    // finding IS queued. The catalogue track has no such column to carry a status at all,
    // which is exactly the point: the sweeps cannot pick up work that was never certified.
    const queue = await listTracks({ limit: 50, status: "queue" });

    expect(queue.tracks.map((track) => track.trackId)).toEqual([FINDING_ID]);
  });

  it('never surfaces in "more like this", even when it HAS an embedding', async () => {
    const { getSimilarFindings } = await import("./tracks");

    // THE SHARPEST CASE. `embedding_blob` lives on `tracks`, so an uncertified catalogue
    // track can carry a perfectly good MuQ vector — the sonic space does not care whether
    // Fluncle certified it. Only the join keeps it out of a public neighbours row. Give
    // BOTH candidates a vector, make the catalogue track the NEARER one, and it still must
    // not come back: a `/log` "more like this" row that linked a coordinate-less track
    // would be a dead link on the public site.
    const target = "cccccccccccccccccccccc";
    await seedTrack(db, { logId: "004.7.3J", title: "The Target", trackId: target });

    const vector = (first: number): string =>
      JSON.stringify([first, ...Array.from({ length: 1023 }, () => 0.01)]);

    await db.execute({ args: [vector(1), target], sql: EMBED });
    await db.execute({ args: [vector(0.99), CATALOGUE_ID], sql: EMBED }); // nearest
    await db.execute({ args: [vector(0.2), FINDING_ID], sql: EMBED }); // further

    const similar = await getSimilarFindings(target, 6);

    expect(similar.map((item) => item.trackId)).toEqual([FINDING_ID]);
  });

  it("does not inflate a label's finding count", async () => {
    const { listLabelsPage } = await import("./labels");

    // Both tracks carry the SAME label — only the certified one may count. In production every
    // finding's track carries the indexed `label_id` edge the admin count reads by (stamped by
    // the publish link + the deploy backfill); stamp it here so the count reads that edge, not the
    // raw string. The uncertified catalogue track is linked too — HUB_CERTIFIED still excludes it
    // (no `log_id`), which is exactly the guarantee under test.
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

    // The recording is still on file (its analysis, embedding and capture are intact —
    // they were never certification data), but it is no longer a finding anywhere.
    const rows = await db.execute("select count(*) as n from tracks");
    expect(Number(rows.rows[0]?.n)).toBe(2);

    await expect(getTrackByIdOrLogId(FINDING_ID)).resolves.toBeUndefined();
    expect((await listTracks({ limit: 50 })).tracks).toEqual([]);
  });
});

// ── THE CERTIFICATION RAIL: measured, never spoken about ─────────────────────────────
//
// The split gives the catalogue a NEW capability and a NEW danger, and they are the same
// write path. The capability: analysis and embedding are measurements of a RECORDING —
// BPM, key, features, the MuQ vector all live on `tracks` — so they must work on an
// uncertified track, or The Ear has nothing to rank. The danger: `update_track` is ONE
// generic endpoint, and the fields that make Fluncle SPEAK (the note, the context note,
// the observation, the video, the galaxy, the coordinate) go through the very same call.
//
// **Fluncle does not speak about a track he has not been to** (ratified canon). So an
// uncertified track must take every analysis field and REFUSE every certification field.
//
// And refuse LOUDLY. `update findings … where track_id = ?` on a row with no finding
// matches zero rows — it SUCCEEDS, silently, reporting the fields as written. That is the
// worst available failure, and it is why the rail is a 409 in `updateTrack` rather than a
// hopeful WHERE clause.
describe("the certification rail — a catalogue track is measured, never spoken about", () => {
  const analysisOf = async (trackId: string) => {
    const result = await db.execute({
      args: [trackId],
      sql: `select bpm, key, features_json, analyzed_from,
                   embedding_blob is not null as has_vector, source_audio_key
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

    // The vector lands as the native F32_BLOB the database ranks in SQL — the ONLY stored
    // form. Without this write the row has no vector, and
    // a row with no vector is invisible to The Ear — which the pre-split queues guaranteed.
    const row = await db.execute({
      args: [CATALOGUE_ID],
      sql: `select embedding_blob is not null as b from tracks where track_id = ?`,
    });
    expect(Number(row.rows[0]?.b)).toBe(1);
  });

  it("CAN take the capture side-channel — the bytes are a property of the recording", async () => {
    const { updateTrack } = await import("./track-update");

    await updateTrack(
      CATALOGUE_ID,
      { captureStatus: "done", sourceAudioKey: `${CATALOGUE_ID}/abc.webm` },
      { writer: "agent" },
    );

    expect((await analysisOf(CATALOGUE_ID))?.source_audio_key).toBe(`${CATALOGUE_ID}/abc.webm`);
  });

  it("CANNOT get a NOTE — Fluncle does not write about a track he has not been to", async () => {
    const { updateTrack } = await import("./track-update");

    await expect(
      updateTrack(CATALOGUE_ID, { note: "A monster of a roller." }, { writer: "operator" }),
    ).rejects.toMatchObject({ code: "uncertified", status: 409 });

    // Not even the operator, and not even by the fill-empty-only auto-note path.
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

    // `requireTrack` is the shared resolver behind the social-publish ops (admin-social) and
    // the video control-plane (finalize / requeue / purge). It goes through
    // `getTrackByIdOrLogId`, which drives the FINDING JOIN — so a catalogue track is a 404
    // there and no publish or video op can so much as name it. The read join and the write
    // rail enforce the same rule from two directions.
    await expect(requireTrack(FINDING_ID)).resolves.toMatchObject({ logId: "004.7.2I" });
    await expect(requireTrack(CATALOGUE_ID)).rejects.toMatchObject({ status: 404 });

    // And nothing has ever been posted for it.
    const { listSocialPosts } = await import("./social");
    expect(await listSocialPosts(CATALOGUE_ID)).toEqual([]);
  });

  it("CANNOT get a context note, a galaxy, an enrichment status, or a COORDINATE", async () => {
    const { updateTrack } = await import("./track-update");

    // Each of these writes a `findings` column. On a catalogue row the SQL would match zero
    // rows and report success — so each is rejected by name, not left to the WHERE clause.
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

    // A mixed payload — a legal measurement AND an illegal claim — is rejected WHOLE. The
    // bpm must not land: a partial success on a certification write is how a catalogue track
    // would quietly acquire half a finding.
    await expect(
      updateTrack(CATALOGUE_ID, { bpm: 174, note: "Sneaking a note in." }, { writer: "operator" }),
    ).rejects.toMatchObject({ code: "uncertified", message: expect.stringContaining("note") });

    expect((await analysisOf(CATALOGUE_ID))?.bpm).toBeNull();
  });

  it("never INSERTs a findings row — certifying a track is publish_track's job alone", async () => {
    const { updateTrack } = await import("./track-update");

    await updateTrack(CATALOGUE_ID, { bpm: 174 }, { writer: "agent" });

    const findings = await db.execute("select count(*) as n from findings");
    expect(Number(findings.rows[0]?.n)).toBe(1); // still only the one real finding
  });

  it("never bumps a lastmod it does not have — an analysis write is not news", async () => {
    const { updateTrack } = await import("./track-update");

    // `bpm` is in VISIBLE_FIELDS, so on a FINDING it moves `updated_at` (the sitemap/log
    // lastmod). A catalogue track has no /log page to stale and no `findings` row to bump.
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

// ── THE CRAWLER'S RAIL ────────────────────────────────────────────────────────
//
// The catalogue crawler is the first thing that writes uncertified tracks IN BULK
// (docs/catalogue-crawler.md), so the split stops being a design property and starts
// being a promise to the public: `llms.txt` asserts, truthfully, that "every track in the
// archive is one he found, listened to, and certified." One crawled row leaking into a
// feed makes that sentence a lie.
//
// The cases above prove the SERVER READS are blind to it. These prove the PUBLIC EMITTERS
// are — by running the real route handlers, over the real schema, against a row the real
// crawler wrote. Not a re-implementation of their SQL: the handlers themselves.

describe("a CRAWLED track never reaches a public surface", () => {
  const CRAWLED_ID = "mb_9f2b1c44-0000-4000-8000-abcdefabcdef";

  beforeEach(async () => {
    // The exact insert `crawl.ts` performs: metadata only, no `findings` row, every
    // queue column left at its DDL default.
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

    // The /log index is `listTracks`; a /log/<logId> page resolves through the same join.
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
    // The index carries no <url> of its own — it points at children. So the certification rail
    // has to hold in the CHILDREN, and that is where it is asserted: every shard the index
    // advertises is fetched and searched.
    const { indexXml, shards, xml } = await renderSitemap();

    expect(indexXml).toContain("<sitemapindex");
    expect(shards).toContain("pages-1.xml");
    expect(shards).toContain("findings-1.xml");

    expect(xml).toContain("/log/004.7.2I");
    expect(xml).not.toContain(CRAWLED_ID);
    // No Log ID exists for it, so there is no URL a crawler could even be pointed at.
    expect(xml).not.toContain("A Crawled Track");
  });

  it("is absent from the Galaxy game's star field", async () => {
    const { listTracks } = await import("./tracks");

    // The game (src/game/game.ts) pages `fetchTracks` → `/api/v1/tracks` → `listTracks`,
    // and places a star per finding with a Log ID. A crawled track has neither, so it can
    // never be a waypoint: you cannot fly to a place Fluncle never stood.
    const page = await listTracks({ limit: 50 });

    expect(page.tracks.every((track) => track.logId)).toBe(true);
    expect(page.tracks.map((track) => track.trackId)).not.toContain(CRAWLED_ID);
  });

  it("is nobody's work item — it cannot enter the capture or enrichment queue", async () => {
    const { listTracks } = await import("./tracks");

    // `capture_status` sits on `tracks`, so the crawled row DOES carry a 'pending' — and
    // that is exactly why the queue's predicate is `findings.log_id is not null`. Without
    // the join, a 10k-row crawl would enqueue 10k capture jobs on the first tick, and the
    // first sign would be the invoice.
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

// CERTIFY IN PLACE — the "Log it" the Ear's workstation fires (docs/the-ear.md § The operator's
// actions). It turns an EXISTING catalogue row into a finding by minting ONLY the certification
// half; it must NOT create a new `tracks` row, and it must refuse a row that is already a finding.
describe("certify in place — logging an existing catalogue track without creating a new one", () => {
  it("mints the finding for the existing row, and creates NO new track", async () => {
    const { certifyExistingTrack } = await import("./publish");

    const before = await db.execute("select count(*) as n from tracks");
    const { logId } = await certifyExistingTrack(CATALOGUE_ID, {
      note: "logged from the telescope",
    });

    // A real coordinate, minted onto the EXISTING row — and no second track was inserted.
    expect(logId).toMatch(/\d{3}\.\d+\.\d+[A-Z]/);
    const after = await db.execute("select count(*) as n from tracks");
    expect(Number(after.rows[0]?.n)).toBe(Number(before.rows[0]?.n));

    // The catalogue row is now a finding: a `findings` row exists, carrying the coordinate + note.
    const finding = await db.execute({
      args: [CATALOGUE_ID],
      sql: "select log_id, note from findings where track_id = ?",
    });
    expect(finding.rows[0]?.log_id).toBe(logId);
    expect(finding.rows[0]?.note).toBe("logged from the telescope");

    // The catalogue discriminator flipped 1 → 0 in the SAME atomic write that minted the finding:
    // the row is now certified, so every consumer that reads `is_catalogue` treats it as such.
    const flag = await db.execute({
      args: [CATALOGUE_ID],
      sql: "select is_catalogue from tracks where track_id = ?",
    });
    expect(Number(flag.rows[0]?.is_catalogue)).toBe(0);
  });

  it("REFUSES a row that is certified AND fully announced (409) — never a second finding", async () => {
    const { certifyExistingTrack } = await import("./publish");

    await expect(certifyExistingTrack(FINDING_ID)).rejects.toThrow(/already logged/i);

    // Exactly one finding for that track, unchanged.
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

  // ── The announce fan-out (operator ruling, 2026-07-13: a finding is a finding however it
  // arrives, so certify rides the same legs as the Spotify add — presence resolved, never
  // assumed; a leg failure recorded, never unwinding the mint; missing legs resumable). ──
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
    // Bluesky rides the announce wave when the Spotify link exists (its card is built on it).
    expect(blueskyPosts).toEqual([CATALOGUE_ID]);

    // The flags stamped, the resolved identity written back onto the track.
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

    // The exact shape that used to mint SILENT: ISRC-less (the crawler's MusicBrainz ISRC is sparse
    // for underground DnB) AND un-anchored. Once certified it left the anchor sweep's reach, so its
    // ISRC was never recovered and the app had no preview to resolve.
    await db.execute({
      args: [CATALOGUE_ID],
      sql: "update tracks set isrc = null, spotify_uri = null, spotify_url = null where track_id = ?",
    });
    // The pre-mint rung recovers the real ISRC, which then drives the Spotify anchor pre-flight —
    // so the row CERTIFIES (instead of the 409 below) and is born with a resolvable preview.
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

    // It MINTED (without the recovery this same row 409s below) and anchored via the recovered ISRC.
    expect(logId).toMatch(/\d{3}\.\d+\.\d+[A-Z]/);
    const track = await db.execute({
      args: [CATALOGUE_ID],
      sql: "select spotify_uri from tracks where track_id = ?",
    });
    expect(track.rows[0]?.spotify_uri).toBe("spotify:track:recovered1");
  });

  it("REFUSES to certify without a Spotify anchor — 409, mints nothing, announces nothing", async () => {
    const { certifyExistingTrack } = await import("./publish");

    // RULED 2026-07-15: the public playlist carries every banger, so only a Spotify-linked
    // track can be certified. No stored identity, no ISRC → no lookup can run → refuse.
    await db.execute({
      args: [CATALOGUE_ID],
      sql: "update tracks set spotify_uri = null, spotify_url = null where track_id = ?",
    });

    await expect(certifyExistingTrack(CATALOGUE_ID)).rejects.toThrow(/no spotify identity/i);

    // Nothing minted, nothing announced — the refusal is total.
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

    // First attempt: no identity, no ISRC → the pre-flight refuses, mints nothing.
    await db.execute({
      args: [CATALOGUE_ID],
      sql: "update tracks set spotify_uri = null, spotify_url = null where track_id = ?",
    });
    await expect(certifyExistingTrack(CATALOGUE_ID)).rejects.toThrow(/no spotify identity/i);
    expect(telegramPosts).toEqual([]);

    // An ISRC lands later (the crawler's anchor backfill); certify again — this time the
    // pre-flight resolves the identity, stamps it back, and the certify runs end to end.
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
