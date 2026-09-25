import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { REC_ELIGIBLE_WHERE } from "../catalogue-eligibility";
import { typedRow } from "./db";
import { type PublicUser } from "./public-auth";
import { ANCHOR_REASK_AFTER_DAYS, kindClause } from "./track-work";
import {
  createIntegrationDb,
  rowCount,
  seedAlbum,
  seedArtist,
  seedCatalogueTrack,
  seedEmbedding,
  seedLabel,
  seedTrack,
  syncHubCounts,
} from "./integration-db";

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

const DIMS = 1024;

function axis(index: number): number[] {
  const vector = Array.from<number>({ length: DIMS }).fill(0);
  vector[index] = 1;

  return vector;
}

async function embed(trackId: string, vector: number[]): Promise<void> {
  await seedEmbedding(db, trackId, vector);
}

function publicUser(id: string, emailVerified = true): PublicUser {
  return {
    createdAt: new Date().toISOString(),
    email: `${id}@example.com`,
    emailVerified,
    id,
    name: id,
    username: id,
  };
}

async function seedFrontierNode(id: string, state: "done" | "pending"): Promise<void> {
  const now = new Date().toISOString();

  await db.execute({
    args: [id, "release", "musicbrainz", `ext-${id}`, 1, state, now, now],
    sql: `insert into crawl_frontier
      (id, kind, source, external_id, hop, state, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?)`,
  });
}

async function patchTrack(
  trackId: string,
  set: string,
  args: (number | string)[] = [],
): Promise<void> {
  await db.execute({
    args: [...args, trackId],
    sql: `update tracks set ${set} where track_id = ?`,
  });
}

async function linkArtist(trackId: string, artistId: string, position: number): Promise<void> {
  await db.execute({
    args: [artistId, position, trackId],
    sql: `insert into track_artists (artist_id, position, track_id) values (?, ?, ?)`,
  });
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

describe("recordCatalogueSnapshot (real SQL)", () => {
  it("upserts idempotently per UTC day: two same-day calls are ONE row, the second overwrites", async () => {
    const { recordCatalogueSnapshot } = await import("./funnel");

    await seedCatalogueTrack(db, { trackId: "cat-1" });
    await seedCatalogueTrack(db, { trackId: "cat-2" });

    const first = await recordCatalogueSnapshot({ day: "2026-07-18" });

    expect(first.snapshot.day).toBe("2026-07-18");
    expect(first.snapshot.crawled).toBe(2);
    expect(await rowCount(db, "catalogue_snapshots")).toBe(1);

    await seedCatalogueTrack(db, { trackId: "cat-3" });
    const second = await recordCatalogueSnapshot({ day: "2026-07-18" });

    expect(await rowCount(db, "catalogue_snapshots")).toBe(1);
    expect(second.snapshot.crawled).toBe(3);

    const stored = await db.execute(
      "select crawled from catalogue_snapshots where day = '2026-07-18'",
    );

    expect(Number((stored.rows[0] as unknown as { crawled: number }).crawled)).toBe(3);
  });

  it("a DIFFERENT day is a new row (the series grows one row per day)", async () => {
    const { recordCatalogueSnapshot } = await import("./funnel");

    await seedCatalogueTrack(db, { trackId: "cat-1" });
    await recordCatalogueSnapshot({ day: "2026-07-17" });
    await recordCatalogueSnapshot({ day: "2026-07-18" });

    expect(await rowCount(db, "catalogue_snapshots")).toBe(2);
  });
});

describe("computeCatalogueSnapshotCounts stages (real SQL)", () => {
  it("counts each stage against hand-inserted fixtures across every gate", async () => {
    const { computeCatalogueSnapshotCounts } = await import("./funnel");

    await seedTrack(db, { logId: "001.1.1A", trackId: "find-1" });
    await seedTrack(db, { logId: "002.1.1A", trackId: "find-2" });

    await seedCatalogueTrack(db, { trackId: "cat-anchored" });
    await seedCatalogueTrack(db, { trackId: "cat-unanchored" });
    await patchTrack("cat-unanchored", "spotify_uri = null");
    await seedCatalogueTrack(db, { trackId: "cat-captured" });
    await patchTrack("cat-captured", "source_audio_key = 'k/a.webm'");
    await seedCatalogueTrack(db, { trackId: "cat-analyzed" });
    await patchTrack("cat-analyzed", "source_audio_key = 'k/b.webm', analyzed_from = 'full'");
    await seedCatalogueTrack(db, { trackId: "cat-embedded" });
    await patchTrack("cat-embedded", "source_audio_key = 'k/c.webm', analyzed_from = 'full'");
    await embed("cat-embedded", axis(0));

    const counts = await computeCatalogueSnapshotCounts();

    expect(counts.certified).toBe(2);
    expect(counts.crawled).toBe(5);
    expect(counts.anchored).toBe(4);
    expect(counts.captured).toBe(3);
    expect(counts.analyzed).toBe(2);
    expect(counts.embedded).toBe(1);

    expect(counts.recEligible).toBe(1);
  });

  it("recEligible excludes a dismissed / duplicate / long-form / near-dup embedded row", async () => {
    const { computeCatalogueSnapshotCounts } = await import("./funnel");

    for (const id of ["clean", "dismissed", "dup", "longform", "neardup"]) {
      await seedCatalogueTrack(db, { trackId: `e-${id}` });
      await embed(`e-${id}`, axis(0));
    }

    await patchTrack("e-dismissed", "dismissed_at = '2026-01-01T00:00:00.000Z'");
    await patchTrack("e-dup", "duplicate_of_track_id = 'x'");
    await patchTrack("e-longform", "duration_ms = 1200000");
    await patchTrack("e-neardup", "nearest_finding_score = 0.999");

    const counts = await computeCatalogueSnapshotCounts();

    expect(counts.embedded).toBe(5);
    expect(counts.recEligible).toBe(1);
  });
});

describe("computeCatalogueSnapshotCounts queues (real SQL)", () => {
  it("each queue depth equals the sweep's OWN count function (no drift)", async () => {
    const { computeCatalogueSnapshotCounts } = await import("./funnel");
    const { countTrackWork } = await import("./track-work");
    const { setCatalogueCapturePaused } = await import("./capture-budget");

    await setCatalogueCapturePaused(false);

    await seedCatalogueTrack(db, { trackId: "cap-ready" });
    await patchTrack("cap-ready", "capture_priority = 1");

    await seedCatalogueTrack(db, { trackId: "measured" });
    await patchTrack("measured", "source_audio_key = 'k/m.webm'");

    await seedCatalogueTrack(db, { trackId: "anc-noisrc" });
    await patchTrack("anc-noisrc", "spotify_uri = null");
    await seedCatalogueTrack(db, { trackId: "anc-isrc" });
    await patchTrack("anc-isrc", "spotify_uri = null, isrc = 'GB1234567890'");

    const counts = await computeCatalogueSnapshotCounts();

    expect(counts.captureQueue).toBe(await countTrackWork({ kind: "capture", scope: "catalogue" }));
    expect(counts.analyzeQueue).toBe(await countTrackWork({ kind: "analyze", scope: "catalogue" }));
    expect(counts.embedQueue).toBe(await countTrackWork({ kind: "embed", scope: "catalogue" }));
    expect(counts.anchorQueueIsrc + counts.anchorQueueNoIsrc).toBe(
      await countTrackWork({ kind: "anchor", scope: "catalogue" }),
    );

    expect(counts.anchorQueueIsrc).toBe(1);
    expect(counts.anchorQueueNoIsrc).toBe(1);
    expect(counts.captureQueue).toBe(1);
  });

  it("splits the anchor queue by embedding (ready vs awaiting audio), summing to the whole queue", async () => {
    const { getFunnel } = await import("./funnel");
    const { countTrackWork } = await import("./track-work");

    await seedCatalogueTrack(db, { trackId: "anc-ready" });
    await patchTrack("anc-ready", "spotify_uri = null");
    await embed("anc-ready", axis(0));

    await seedCatalogueTrack(db, { trackId: "anc-awaiting" });
    await patchTrack("anc-awaiting", "spotify_uri = null");

    await seedCatalogueTrack(db, { trackId: "already-anchored" });

    const { live } = await getFunnel();

    expect(live.queues.anchorQueueReady).toBe(1);
    expect(live.queues.anchorQueueAwaitingAudio).toBe(1);

    const whole = live.queues.anchorQueueIsrc + live.queues.anchorQueueNoIsrc;
    expect(live.queues.anchorQueueReady + live.queues.anchorQueueAwaitingAudio).toBe(whole);
    expect(whole).toBe(await countTrackWork({ kind: "anchor", scope: "catalogue" }));
  });

  it("benches a row attempted inside the re-ask window (anchorBackoff), and keeps a lapsed one in the queue", async () => {
    const { computeCatalogueSnapshotCounts } = await import("./funnel");
    const now = Date.now();
    const recent = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    const stale = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

    await seedCatalogueTrack(db, { trackId: "benched" });
    await patchTrack("benched", "spotify_uri = null, spotify_anchor_attempted_at = ?", [recent]);
    await seedCatalogueTrack(db, { trackId: "re-askable" });
    await patchTrack("re-askable", "spotify_uri = null, spotify_anchor_attempted_at = ?", [stale]);

    const counts = await computeCatalogueSnapshotCounts();

    expect(counts.anchorBackoff).toBe(1);

    expect(counts.anchorQueueNoIsrc).toBe(1);
  });

  it("reads the crawl frontier's done + pending counts", async () => {
    const { computeCatalogueSnapshotCounts } = await import("./funnel");

    await seedFrontierNode("d1", "done");
    await seedFrontierNode("d2", "done");
    await seedFrontierNode("p1", "pending");

    const counts = await computeCatalogueSnapshotCounts();

    expect(counts.frontierDone).toBe(2);
    expect(counts.frontierPending).toBe(1);
  });
});

describe("the rec-eligibility count agrees with listRecommendations' scan (real SQL)", () => {
  it("recEligible equals the catalogue rows listRecommendations actually returns", async () => {
    const { computeCatalogueSnapshotCounts } = await import("./funnel");
    const { listRecommendations, saveRecSeed } = await import("./recommendations");
    const user = publicUser("user-A");

    await seedTrack(db, { logId: "001.1.1A", trackId: "seed-finding" });
    await embed("seed-finding", axis(0));
    await saveRecSeed(user, { logId: "001.1.1A" });

    for (let index = 0; index < 4; index += 1) {
      await seedCatalogueTrack(db, { artists: [`Artist ${index}`], trackId: `elig-${index}` });
      await embed(`elig-${index}`, axis(index + 1));
    }

    await seedCatalogueTrack(db, { trackId: "no-vector" });
    await seedCatalogueTrack(db, { trackId: "unanchored" });
    await patchTrack("unanchored", "spotify_uri = null");
    await embed("unanchored", axis(20));
    await seedCatalogueTrack(db, { trackId: "dismissed" });
    await patchTrack("dismissed", "dismissed_at = '2026-01-01T00:00:00.000Z'");
    await embed("dismissed", axis(21));

    const counts = await computeCatalogueSnapshotCounts();
    const recs = await listRecommendations(user);

    expect(recs).not.toBeInstanceOf(Response);

    if (recs instanceof Response) {
      return;
    }

    expect(counts.recEligible).toBe(4);
    expect(recs.catalogue).toHaveLength(counts.recEligible);
  });
});

describe("getFunnel (real SQL)", () => {
  it("returns the live pipeline + meters and the bounded series oldest-first", async () => {
    const { getFunnel, recordCatalogueSnapshot } = await import("./funnel");

    await seedCatalogueTrack(db, { trackId: "cat-1" });

    await recordCatalogueSnapshot({ day: "2026-07-16" });
    await recordCatalogueSnapshot({ day: "2026-07-17" });
    await recordCatalogueSnapshot({ day: "2026-07-18" });

    const view = await getFunnel();

    expect(view.live.stages.crawled).toBe(1);
    expect(view.live.queues).toHaveProperty("captureQueue");
    expect(view.live.meters.captureBudget).toHaveProperty("remainingTracks");
    expect(typeof view.live.meters.frontierPending).toBe("number");

    expect(view.series.map((row) => row.day)).toEqual(["2026-07-16", "2026-07-17", "2026-07-18"]);
  });

  it("caps the series to the window and walks it ASC (last N days only)", async () => {
    const { getFunnel, recordCatalogueSnapshot } = await import("./funnel");

    const today = new Date();
    const day = (offsetDays: number) =>
      new Date(today.getTime() - offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    await recordCatalogueSnapshot({ day: day(0) });
    await recordCatalogueSnapshot({ day: day(100) });

    const view = await getFunnel(90);

    expect(view.series.map((row) => row.day)).toEqual([day(0)]);
  });

  it("computes the live block on EVERY call — a count change shows without a new snapshot", async () => {
    const { getFunnel, recordCatalogueSnapshot } = await import("./funnel");

    await seedCatalogueTrack(db, { trackId: "cat-1" });
    await recordCatalogueSnapshot({ day: "2026-07-18" });

    const first = await getFunnel();
    expect(first.live.stages.crawled).toBe(1);

    await seedCatalogueTrack(db, { trackId: "cat-2" });

    const second = await getFunnel();
    expect(second.live.stages.crawled).toBe(2);

    expect(second.series.map((row) => row.day)).toEqual(["2026-07-18"]);
    expect(second.series[0]?.crawled).toBe(1);
  });
});

describe("getFunnel publicSurfaces (real SQL)", () => {
  it("routes the tracks card through the usable projected total", async () => {
    const { getFunnel } = await import("./funnel");
    const { rebuildPublicProjection } = await import("./public-projections");
    const { PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY } = await import("./public-projection-cutover");
    await seedCatalogueTrack(db, { trackId: "projected-track" });
    await rebuildPublicProjection(db, "public_aggregates", {
      generation: "funnel-aggregate",
      limit: 10,
    });
    await db.execute(`update public_aggregate_state set default_track_total = 123
      where scope = 'tracks'`);
    await db.execute({
      args: [PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY, "true"],
      sql: `insert into settings (key, value) values (?, ?)`,
    });

    expect((await getFunnel()).live.publicSurfaces.tracks).toBe(123);
  });

  it("publicSurfaces.tracks equals the /tracks hub's own count (findings + catalogue)", async () => {
    const { getFunnel } = await import("./funnel");
    const { tracksHubCountQuery } = await import("./tracks-hub");

    await seedTrack(db, { logId: "001.1.1A", trackId: "find-1" });
    await seedTrack(db, { logId: "002.1.1A", trackId: "find-2" });
    await seedCatalogueTrack(db, { trackId: "cat-1" });
    await seedCatalogueTrack(db, { trackId: "cat-2" });
    await seedCatalogueTrack(db, { trackId: "cat-3" });

    const { live } = await getFunnel();

    expect(live.publicSurfaces.tracks).toBe(5);

    const hubCount = await db.execute(tracksHubCountQuery({}));
    expect(live.publicSurfaces.tracks).toBe(
      Number((hubCount.rows[0] as unknown as { total: number }).total),
    );
  });

  it("counts the INDEXABLE artists/albums/labels (renderable ≥ 3) and agrees with the sitemap rows", async () => {
    const { getFunnel } = await import("./funnel");
    const { ARTIST_INDEX_MIN_FINDINGS, listArtistSitemapRows } = await import("./artists");
    const { ALBUM_INDEX_MIN_TRACKS, listAlbumSitemapRows } = await import("./albums");
    const { LABEL_INDEX_MIN_TRACKS, listLabelSitemapRows } = await import("./labels");

    await seedArtist(db, { id: "art-in", slug: "art-in" });
    await seedArtist(db, { id: "art-out", slug: "art-out" });
    await seedAlbum(db, { id: "alb-in", slug: "alb-in" });
    await seedAlbum(db, { id: "alb-out", slug: "alb-out" });
    await seedLabel(db, { id: "lab-in", slug: "lab-in" });
    await seedLabel(db, { id: "lab-out", slug: "lab-out" });

    for (let index = 0; index < 3; index += 1) {
      const id = `t-in-${index}`;
      await seedCatalogueTrack(db, { trackId: id });
      await linkArtist(id, "art-in", index);
      await patchTrack(id, "album_id = 'alb-in', label_id = 'lab-in'");
    }

    for (let index = 0; index < 2; index += 1) {
      const id = `t-out-${index}`;
      await seedCatalogueTrack(db, { trackId: id });
      await linkArtist(id, "art-out", index);
      await patchTrack(id, "album_id = 'alb-out', label_id = 'lab-out'");
    }

    await syncHubCounts(db);

    const { live } = await getFunnel();

    expect(live.publicSurfaces.artists).toBe(1);
    expect(live.publicSurfaces.albums).toBe(1);
    expect(live.publicSurfaces.labels).toBe(1);

    expect(live.publicSurfaces.artists).toBe(
      (await listArtistSitemapRows(ARTIST_INDEX_MIN_FINDINGS)).length,
    );
    expect(live.publicSurfaces.albums).toBe(
      (await listAlbumSitemapRows(ALBUM_INDEX_MIN_TRACKS)).length,
    );
    expect(live.publicSurfaces.labels).toBe(
      (await listLabelSitemapRows(LABEL_INDEX_MIN_TRACKS)).length,
    );
  });
});

export async function runStageScan() {
  const result = await db.execute(`select
    sum(case when f.track_id is null then 1 else 0 end) as crawled,
    sum(case when f.track_id is null and t.spotify_uri is not null then 1 else 0 end) as anchored,
    sum(case when f.track_id is null and t.source_audio_key is not null then 1 else 0 end) as captured,
    sum(case when f.track_id is null and t.analyzed_from = 'full' then 1 else 0 end) as analyzed,
    sum(case when f.track_id is null and emb.track_id is not null then 1 else 0 end) as embedded,
    sum(case when ${REC_ELIGIBLE_WHERE} then 1 else 0 end) as rec_eligible,
    sum(case when f.track_id is not null then 1 else 0 end) as certified
    from tracks t
    left join findings f on f.track_id = t.track_id
    left join track_embeddings emb on emb.track_id = t.track_id`);
  const row = typedRow<Record<string, number | null>>(result.rows);

  return {
    analyzed: Number(row?.analyzed ?? 0),
    anchored: Number(row?.anchored ?? 0),
    captured: Number(row?.captured ?? 0),
    certified: Number(row?.certified ?? 0),
    crawled: Number(row?.crawled ?? 0),
    embedded: Number(row?.embedded ?? 0),
    recEligible: Number(row?.rec_eligible ?? 0),
  };
}

export async function countAnchorQueueSplit() {
  const anchor = kindClause("anchor");
  const result = await db.execute({
    args: anchor.args,
    sql: `select
      sum(case when t.isrc is not null and emb.track_id is not null then 1 else 0 end) as isrc_ready,
      sum(case when t.isrc is not null and emb.track_id is null then 1 else 0 end) as isrc_awaiting,
      sum(case when t.isrc is null and emb.track_id is not null then 1 else 0 end) as no_isrc_ready,
      sum(case when t.isrc is null and emb.track_id is null then 1 else 0 end) as no_isrc_awaiting
      from tracks t
      left join findings f on f.track_id = t.track_id
      left join track_embeddings emb on emb.track_id = t.track_id
      where ${anchor.sql}`,
  });
  const row = typedRow<Record<string, number | null>>(result.rows);
  const isrcReady = Number(row?.isrc_ready ?? 0);
  const isrcAwaiting = Number(row?.isrc_awaiting ?? 0);
  const noIsrcReady = Number(row?.no_isrc_ready ?? 0);
  const noIsrcAwaiting = Number(row?.no_isrc_awaiting ?? 0);

  return {
    awaitingAudio: isrcAwaiting + noIsrcAwaiting,
    ready: isrcReady + noIsrcReady,
    withIsrc: isrcReady + isrcAwaiting,
    withoutIsrc: noIsrcReady + noIsrcAwaiting,
  };
}

export async function countAnchorBackoff() {
  const cutoff = new Date(Date.now() - ANCHOR_REASK_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const result = await db.execute({
    args: [cutoff],
    sql: `select count(*) as n from tracks t
      left join findings f on f.track_id = t.track_id
      where f.track_id is null
        and t.spotify_uri is null
        and t.duration_ms > 0
        and t.dismissed_at is null
        and t.duplicate_of_track_id is null
        and t.spotify_anchor_attempted_at is not null
        and t.spotify_anchor_attempted_at >= ?`,
  });

  return Number(typedRow<{ n: number }>(result.rows)?.n ?? 0);
}

describe("the folded funnel scan == its three standalone reference scans (real SQL)", () => {
  it("stages, anchor split, and backoff match the three separate queries on a mixed seed", async () => {
    const { runFoldedFunnelScan } = await import("./funnel");

    const now = Date.now();
    const recent = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    const lapsed = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

    await seedTrack(db, { logId: "001.1.1A", trackId: "certified-0" });
    await embed("certified-0", axis(0));
    await seedCatalogueTrack(db, { trackId: "crawled-0" });

    await seedCatalogueTrack(db, { trackId: "captured-0" });
    await patchTrack("captured-0", "source_audio_key = 'k/c.webm'");
    await seedCatalogueTrack(db, { trackId: "analyzed-0" });
    await patchTrack("analyzed-0", "source_audio_key = 'k/a.webm', analyzed_from = 'full'");

    await seedCatalogueTrack(db, { artists: ["Elig Artist"], trackId: "elig-0" });
    await embed("elig-0", axis(1));

    await seedCatalogueTrack(db, { trackId: "anc-isrc-ready" });
    await patchTrack("anc-isrc-ready", "spotify_uri = null, isrc = 'GB0000000001'");
    await embed("anc-isrc-ready", axis(2));
    await seedCatalogueTrack(db, { trackId: "anc-isrc-awaiting" });
    await patchTrack("anc-isrc-awaiting", "spotify_uri = null, isrc = 'GB0000000002'");
    await seedCatalogueTrack(db, { trackId: "anc-noisrc-awaiting" });
    await patchTrack("anc-noisrc-awaiting", "spotify_uri = null");
    await seedCatalogueTrack(db, { trackId: "anc-benched" });
    await patchTrack("anc-benched", "spotify_uri = null, spotify_anchor_attempted_at = ?", [
      recent,
    ]);
    await seedCatalogueTrack(db, { trackId: "anc-lapsed" });
    await patchTrack("anc-lapsed", "spotify_uri = null, spotify_anchor_attempted_at = ?", [lapsed]);

    const folded = await runFoldedFunnelScan();

    expect(folded.stages).toEqual(await runStageScan());
    expect(folded.anchorSplit).toEqual(await countAnchorQueueSplit());
    expect(folded.anchorBackoff).toBe(await countAnchorBackoff());

    expect(folded.stages.certified).toBe(1);
    expect(folded.stages.crawled).toBeGreaterThan(0);
    expect(folded.anchorSplit.withIsrc).toBe(2);
    expect(folded.anchorSplit.withoutIsrc).toBeGreaterThan(0);
    expect(folded.anchorSplit.ready).toBeGreaterThan(0);
    expect(folded.anchorSplit.awaitingAudio).toBeGreaterThan(0);
    expect(folded.anchorBackoff).toBe(1);
  });

  it("reads every arm out of the covering index, touching no table row and no findings join", async () => {
    const { foldedFunnelScanStatement } = await import("./funnel");
    const statement = foldedFunnelScanStatement();

    expect(statement.sql).not.toContain("track_embeddings");
    expect(statement.sql).not.toContain("findings");

    const plan = await db.execute({
      args: statement.args,
      sql: `explain query plan ${statement.sql}`,
    });
    const detail = plan.rows.map((row) => JSON.stringify(row.detail)).join(" | ");

    expect(detail).toContain("COVERING INDEX tracks_funnel_scan_idx");
  });
});

describe("the authorized capture backlog (real SQL)", () => {
  async function seedBacklog(): Promise<void> {
    await seedCatalogueTrack(db, { trackId: "b-t3-anchored" });
    await patchTrack("b-t3-anchored", "capture_priority = 3");
    await seedCatalogueTrack(db, { trackId: "b-t3-unanchored" });
    await patchTrack("b-t3-unanchored", "capture_priority = 3, spotify_uri = null");
    await seedCatalogueTrack(db, { trackId: "b-t1-unanchored" });
    await patchTrack("b-t1-unanchored", "capture_priority = 1, spotify_uri = null");

    await seedCatalogueTrack(db, { trackId: "b-vetoed" });
    await patchTrack("b-vetoed", "capture_priority = -1");
  }

  it("reports the same backlog with the budget shut as with it open, while the queue depth follows the brake", async () => {
    const { getFunnel } = await import("./funnel");
    const { countTrackWork } = await import("./track-work");
    const { setCatalogueCapturePaused } = await import("./capture-budget");

    await seedBacklog();

    await setCatalogueCapturePaused(true);
    const shut = await getFunnel();

    expect(await countTrackWork({ kind: "capture", scope: "catalogue" })).toBe(0);
    expect(shut.live.queues.captureQueue).toBe(0);
    expect(shut.live.captureBacklog.budgetOpen).toBe(false);
    expect(shut.live.captureBacklog.authorized).toBe(3);

    await setCatalogueCapturePaused(false);
    const open = await getFunnel();

    expect(open.live.captureBacklog.budgetOpen).toBe(true);
    expect(open.live.captureBacklog.authorized).toBe(3);

    expect(open.live.queues.captureQueue).toBe(
      await countTrackWork({ kind: "capture", scope: "catalogue" }),
    );
    expect(open.live.queues.captureQueue).toBe(3);
  });

  it("splits the backlog by tier and anchor, highest tier first, summing to the whole", async () => {
    const { getFunnel } = await import("./funnel");
    const { setCatalogueCapturePaused } = await import("./capture-budget");

    await setCatalogueCapturePaused(true);
    await seedBacklog();

    const { captureBacklog } = (await getFunnel()).live;

    expect(captureBacklog.tiers).toEqual([
      { anchored: 1, tier: 3, unanchored: 1 },
      { anchored: 0, tier: 1, unanchored: 1 },
    ]);
    expect(captureBacklog.authorizedAnchored).toBe(1);
    expect(
      captureBacklog.tiers.reduce((total, row) => total + row.anchored + row.unanchored, 0),
    ).toBe(captureBacklog.authorized);
  });

  it("seeks the catalogue capture index and groups in index order, with no sort", async () => {
    const { catalogueCaptureBacklogStatement } = await import("./funnel");
    const statement = catalogueCaptureBacklogStatement();
    const plan = await db.execute({
      args: statement.args,
      sql: `explain query plan ${statement.sql}`,
    });
    const detail = plan.rows.map((row) => JSON.stringify(row.detail)).join(" | ");

    expect(detail).toContain("tracks_catalogue_capture_idx");
    expect(detail).not.toContain("TEMP B-TREE");
  });

  it("the daily snapshot runs none of the live-only reads", async () => {
    const { catalogueCaptureBacklogStatement, computeCatalogueSnapshotCounts } =
      await import("./funnel");
    const { setCatalogueCapturePaused } = await import("./capture-budget");

    await setCatalogueCapturePaused(true);
    await seedBacklog();

    const spy = vi.spyOn(db, "execute");
    const counts = await computeCatalogueSnapshotCounts();
    const statements = spy.mock.calls.map((call) => {
      const input = call[0] as string | { sql: string };
      return typeof input === "string" ? input : input.sql;
    });

    spy.mockRestore();

    expect(counts.crawled).toBe(4);
    expect(statements.length).toBeGreaterThan(0);
    expect(statements).not.toContain(catalogueCaptureBacklogStatement().sql);
    expect(statements.filter((sql) => sql.includes("renderable_track_count"))).toEqual([]);
    expect(statements.filter((sql) => sql.includes("source_audio_attempted_at >="))).toEqual([]);
  });
});

describe("recordCatalogueSnapshot self-healing (real SQL)", () => {
  it("fills a missing previous day when it runs inside the catch-up grace window", async () => {
    const { recordCatalogueSnapshot } = await import("./funnel");

    await seedCatalogueTrack(db, { trackId: "heal-1" });

    const write = await recordCatalogueSnapshot({ now: new Date("2026-07-19T01:30:00.000Z") });

    expect(write.snapshot.day).toBe("2026-07-19");
    expect(write.backfilledDays).toEqual(["2026-07-18"]);
    expect(await rowCount(db, "catalogue_snapshots")).toBe(2);
  });

  it("never invents a day outside the grace window, and never overwrites one that exists", async () => {
    const { recordCatalogueSnapshot } = await import("./funnel");

    await seedCatalogueTrack(db, { trackId: "heal-2" });

    const late = await recordCatalogueSnapshot({ now: new Date("2026-07-19T23:45:00.000Z") });

    expect(late.backfilledDays).toEqual([]);
    expect(await rowCount(db, "catalogue_snapshots")).toBe(1);

    const healed = await recordCatalogueSnapshot({ now: new Date("2026-07-20T01:00:00.000Z") });

    expect(healed.backfilledDays).toEqual([]);
    expect(await rowCount(db, "catalogue_snapshots")).toBe(2);
  });
});
