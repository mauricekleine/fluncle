import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";

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
