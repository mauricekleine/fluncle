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

const NOW = "2026-07-01T00:00:00.000Z";
const FINDING_ID = "aaaaaaaaaaaaaaaaaaaaaa"; // 22 chars, the tracks PK shape
const CATALOGUE_ID = "bbbbbbbbbbbbbbbbbbbbbb";
// The dual write the agent-tier `update_track` path performs (embedding.ts): the JSON
// array (the source of truth) and the native F32_BLOB the database ranks in SQL.
const EMBED = `update tracks set embedding_json = ?, embedding_blob = vector32(?) where track_id = ?`;

beforeEach(async () => {
  db = await createIntegrationDb();
  await seedTrack(db, { logId: "004.7.2I", title: "A Certified Track", trackId: FINDING_ID });
  await seedCatalogueTrack(db, { title: "An Uncertified Catalogue Track", trackId: CATALOGUE_ID });
});

describe("the tracks/findings split — an uncertified catalogue track is not a finding", () => {
  it("seeds exactly what it claims: two tracks, one finding", async () => {
    const tracks = await db.execute("select count(*) as n from tracks");
    const findings = await db.execute("select count(*) as n from findings");

    expect(Number(tracks.rows[0]?.n)).toBe(2);
    expect(Number(findings.rows[0]?.n)).toBe(1);
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

    // THE SHARPEST CASE. `embedding_json` lives on `tracks`, so an uncertified catalogue
    // track can carry a perfectly good MuQ vector — the sonic space does not care whether
    // Fluncle certified it. Only the join keeps it out of a public neighbours row. Give
    // BOTH candidates a vector, make the catalogue track the NEARER one, and it still must
    // not come back: a `/log` "more like this" row that linked a coordinate-less track
    // would be a dead link on the public site.
    const target = "cccccccccccccccccccccc";
    await seedTrack(db, { logId: "004.7.3J", title: "The Target", trackId: target });

    const vector = (first: number): string =>
      JSON.stringify([first, ...Array.from({ length: 1023 }, () => 0.01)]);

    await db.execute({ args: [vector(1), vector(1), target], sql: EMBED });
    await db.execute({ args: [vector(0.99), vector(0.99), CATALOGUE_ID], sql: EMBED }); // nearest
    await db.execute({ args: [vector(0.2), vector(0.2), FINDING_ID], sql: EMBED }); // further

    const similar = await getSimilarFindings(target, 6);

    expect(similar.map((item) => item.trackId)).toEqual([FINDING_ID]);
  });

  it("does not inflate a label's finding count", async () => {
    const { listLabels } = await import("./labels");

    // Both tracks carry the SAME label — only the certified one may count.
    await db.execute("update tracks set label = 'Hospital Records'");
    await db.execute({
      args: [NOW, NOW],
      sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
            values ('l1', 'Hospital Records', 'hospital-records', 'undecided', ?, ?)`,
    });

    const labels = await listLabels();

    expect(labels.find((label) => label.slug === "hospital-records")?.findingCount).toBe(1);
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
                   embedding_json is not null as has_vector, source_audio_key
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

  it("CAN be embedded — the dual write lands the vector the Ear ranks against", async () => {
    const { updateTrack } = await import("./track-update");

    const vector = JSON.stringify(Array.from({ length: 1024 }, () => 0.03125));
    await updateTrack(CATALOGUE_ID, { embedding: vector }, { writer: "agent" });

    // Both forms: the JSON (the source of truth) and the F32_BLOB the database ranks in SQL.
    // Without this write the row has no vector, and a row with no vector is invisible to The
    // Ear — which is precisely what the pre-split queues guaranteed.
    const row = await db.execute({
      args: [CATALOGUE_ID],
      sql: `select embedding_json is not null as j, embedding_blob is not null as b
            from tracks where track_id = ?`,
    });
    expect(Number(row.rows[0]?.j)).toBe(1);
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
