// The demand signal, proven against the REAL migrated schema on an in-memory libSQL engine (the
// fresh-entity.test.ts harness). What is easy to get wrong and impossible to see without a DB:
//
//   1. PATH EXTRACTION is literal — only `/artist/<slug>` and `/label/<slug>` count; `/admin*`, a
//      nested path, the homepage, and a `?query` tail are all dropped.
//   2. SLUG → ENTITY resolution skips an unknown slug silently, and `demand_score` is the SUMMED
//      pageviews of everything a track hangs off (an artist on it + its label accumulate).
//   3. THE REWRITE IS IDEMPOTENT — each run CLEARS every prior value then re-sets, so a
//      de-trending entity falls back to NULL.
//   4. THE VETO IS NEVER RESURRECTED — a demanded row on a `capture_priority < 0` label gets a
//      `demand_score` but the capture queue still excludes it, and demand only reorders WITHIN a
//      tier (a demanded row is captured before an undemanded sibling AT ITS TIER, never lifted).
//   5. THE FRONTIER REORDER stays WITHIN A HOP and only touches PENDING nodes.
//   6. NO KEY = A CLEAN NO-OP — the columns are left untouched (never wiped on a missing key).

import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import { createIntegrationDb } from "./integration-db";
import {
  classifySocialReferrer,
  extractEntityPath,
  readSocialReferrers,
  recordDemand,
  summarizeDemand,
  summarizeReferrers,
} from "./demand";
import { setCatalogueCapturePaused } from "./capture-budget";
import { listTrackWork } from "./track-work";

const NOW = new Date("2026-07-17T12:00:00.000Z");
const API_KEY = "sa-test-key";

let db: Client;

async function seedArtist(id: string, slug: string, mbid: null | string): Promise<void> {
  await db.execute({
    args: [id, `Artist ${id}`, slug, mbid],
    sql: `insert into artists (id, name, slug, mbid, created_at, updated_at) values (?, ?, ?, ?, 'x', 'x')`,
  });
}

async function seedLabel(id: string, slug: string): Promise<void> {
  await db.execute({
    args: [id, `Label ${id}`, slug],
    sql: `insert into labels (id, name, slug, created_at, updated_at) values (?, ?, ?, 'x', 'x')`,
  });
}

async function seedTrack(options: {
  artistIds?: string[];
  capturePriority?: number;
  labelId?: null | string;
  trackId: string;
}): Promise<void> {
  await db.execute({
    args: [
      options.trackId,
      `Title ${options.trackId}`,
      JSON.stringify(["Someone"]),
      options.labelId ?? null,
      options.capturePriority ?? null,
    ],
    sql: `insert into tracks
            (track_id, title, artists_json, label_id, capture_priority, duration_ms)
          values (?, ?, ?, ?, ?, 210000)`,
  });

  for (const [index, artistId] of (options.artistIds ?? []).entries()) {
    await db.execute({
      args: [options.trackId, artistId, index + 1],
      sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, ?)`,
    });
  }
}

async function seedFrontier(options: {
  externalId: string;
  hop: number;
  id: string;
  kind: "artist" | "label" | "release";
  labelSlug?: null | string;
  state?: "done" | "pending";
}): Promise<void> {
  await db.execute({
    args: [
      options.id,
      options.kind,
      options.externalId,
      options.hop,
      options.labelSlug ?? null,
      options.state ?? "pending",
      // created_at ordered so id-independent order is checkable.
      `2026-07-01T00:00:0${options.id.length % 10}.000Z`,
    ],
    sql: `insert into crawl_frontier
            (id, kind, source, external_id, hop, label_slug, state, created_at, updated_at)
          values (?, ?, 'musicbrainz', ?, ?, ?, ?, ?, 'x')`,
  });
}

/** A fetch stub that returns the given SA `pages` as a version-5 response. */
function saFetch(pages: { pageviews?: number; value: string }[]): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ pages }), { status: 200 })) as unknown as typeof fetch;
}

async function demandScore(trackId: string): Promise<null | number> {
  const row = (
    await db.execute({ args: [trackId], sql: `select demand_score from tracks where track_id = ?` })
  ).rows[0] as { demand_score: null | number } | undefined;

  return row?.demand_score ?? null;
}

async function demandRank(id: string): Promise<number> {
  const row = (
    await db.execute({ args: [id], sql: `select demand_rank from crawl_frontier where id = ?` })
  ).rows[0] as { demand_rank: number } | undefined;

  return Number(row?.demand_rank);
}

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
  process.env.SIMPLE_ANALYTICS_API_KEY = API_KEY;
});

afterEach(() => {
  delete process.env.SIMPLE_ANALYTICS_API_KEY;
});

describe("path extraction", () => {
  it("keeps only bare /artist/<slug> and /label/<slug>, dropping everything else", () => {
    expect(extractEntityPath("/artist/camo-and-krooked")).toEqual({
      kind: "artist",
      slug: "camo-and-krooked",
    });
    expect(extractEntityPath("/label/critical-music")).toEqual({
      kind: "label",
      slug: "critical-music",
    });
    // A query tail is stripped before the match.
    expect(extractEntityPath("/artist/noisia?ref=x")).toEqual({ kind: "artist", slug: "noisia" });

    // Everything that is NOT an entity page is dropped.
    expect(extractEntityPath("/admin/catalogue")).toBeUndefined();
    expect(extractEntityPath("/artist/x/releases")).toBeUndefined();
    expect(extractEntityPath("/log/200.7.abc")).toBeUndefined();
    expect(extractEntityPath("/")).toBeUndefined();
  });

  it("sums pageviews per slug and splits artist vs label", () => {
    const { artists, labels } = summarizeDemand([
      { pageviews: 10, value: "/artist/a" },
      { pageviews: 5, value: "/artist/a" },
      { pageviews: 8, value: "/label/l" },
      { pageviews: 99, value: "/admin/x" },
    ]);

    expect(artists.get("a")).toBe(15);
    expect(labels.get("l")).toBe(8);
    expect(artists.size).toBe(1);
  });
});

describe("recordDemand — the rewrite", () => {
  it("scores tracks by their demanded entities, skips unknown slugs, and sums across entities", async () => {
    await seedArtist("art_a", "artist-a", "mb_a");
    await seedLabel("lab_l", "label-l");
    // t1: only the demanded artist. t2: only the demanded label. t3: BOTH (sums).
    // t4: unrelated (stays null).
    await seedTrack({ artistIds: ["art_a"], trackId: "t1" });
    await seedTrack({ labelId: "lab_l", trackId: "t2" });
    await seedTrack({ artistIds: ["art_a"], labelId: "lab_l", trackId: "t3" });
    await seedTrack({ trackId: "t4" });

    const summary = await recordDemand({
      fetchImpl: saFetch([
        { pageviews: 10, value: "/artist/artist-a" },
        { pageviews: 4, value: "/label/label-l" },
        { pageviews: 999, value: "/artist/nobody" }, // unknown slug — skipped
        { pageviews: 500, value: "/admin/catalogue" }, // not an entity page — dropped
      ]),
      now: NOW,
    });

    expect(summary.configured).toBe(true);
    expect(summary.demandedArtists).toBe(1);
    expect(summary.demandedLabels).toBe(1);
    expect(summary.unknownSlugs).toBe(1);
    expect(summary.tracksScored).toBe(3);
    expect(summary.window).toEqual({ end: "2026-07-17", start: "2026-06-17" });

    expect(await demandScore("t1")).toBe(10);
    expect(await demandScore("t2")).toBe(4);
    expect(await demandScore("t3")).toBe(14); // 10 (artist) + 4 (label)
    expect(await demandScore("t4")).toBeNull();
  });

  it("is idempotent: a second run CLEARS the prior scores then re-sets", async () => {
    await seedArtist("art_a", "artist-a", null);
    await seedTrack({ artistIds: ["art_a"], trackId: "t1" });

    await recordDemand({
      fetchImpl: saFetch([{ pageviews: 10, value: "/artist/artist-a" }]),
      now: NOW,
    });
    expect(await demandScore("t1")).toBe(10);

    // A second run where the artist no longer trends: its score must fall back to NULL.
    await recordDemand({
      fetchImpl: saFetch([{ pageviews: 3, value: "/label/nobody" }]),
      now: NOW,
    });
    expect(await demandScore("t1")).toBeNull();
  });

  it("scores a vetoed row but the capture queue still excludes it, and demand only reorders within a tier", async () => {
    await seedArtist("art_a", "artist-a", null);
    // A demanded ruled-out-label row (capture_priority −1) — it gets a demand_score, but the veto holds.
    await seedTrack({ artistIds: ["art_a"], capturePriority: -1, trackId: "t_veto" });
    // Two same-tier catalogue rows: t_hi is demanded, t_lo is not — demand breaks the tie.
    await seedTrack({ artistIds: ["art_a"], capturePriority: 3, trackId: "t_hi" });
    await seedTrack({ capturePriority: 3, trackId: "t_lo" });

    await recordDemand({
      fetchImpl: saFetch([{ pageviews: 10, value: "/artist/artist-a" }]),
      now: NOW,
    });

    expect(await demandScore("t_veto")).toBe(10); // the score IS written
    expect(await demandScore("t_hi")).toBe(10);
    expect(await demandScore("t_lo")).toBeNull();

    // Open the (default-deny) capture budget so the catalogue queue hands rows out.
    await setCatalogueCapturePaused(false);
    const queue = await listTrackWork({ kind: "capture", scope: "catalogue" });
    const ids = queue.map((item) => item.trackId);

    // THE VETO: the −1 row is excluded regardless of its demand_score.
    expect(ids).not.toContain("t_veto");
    // WITHIN-TIER: both cp=3 rows are present, demanded first.
    expect(ids.indexOf("t_hi")).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf("t_hi")).toBeLessThan(ids.indexOf("t_lo"));
  });

  it("promotes only PENDING frontier nodes of demanded entities, within a hop", async () => {
    await seedArtist("art_a", "artist-a", "mb_artist_a");
    await seedLabel("lab_l", "label-l");

    // Same hop: a demanded label's subtree node, a demanded artist node, and an undemanded sibling.
    await seedFrontier({
      externalId: "rel1",
      hop: 1,
      id: "n_label",
      kind: "release",
      labelSlug: "label-l",
    });
    await seedFrontier({ externalId: "mb_artist_a", hop: 1, id: "n_artist", kind: "artist" });
    await seedFrontier({
      externalId: "rel2",
      hop: 1,
      id: "n_other",
      kind: "release",
      labelSlug: "other",
    });
    // An ALREADY-EXPANDED node of the demanded label — never promoted.
    await seedFrontier({
      externalId: "rel0",
      hop: 0,
      id: "n_done",
      kind: "release",
      labelSlug: "label-l",
      state: "done",
    });

    const summary = await recordDemand({
      fetchImpl: saFetch([
        { pageviews: 6, value: "/label/label-l" },
        { pageviews: 9, value: "/artist/artist-a" },
      ]),
      now: NOW,
    });

    expect(await demandRank("n_label")).toBe(0); // demanded label subtree
    expect(await demandRank("n_artist")).toBe(0); // demanded artist by MBID
    expect(await demandRank("n_other")).toBe(1); // undemanded sibling
    expect(await demandRank("n_done")).toBe(1); // not pending — untouched
    expect(summary.frontierPromoted).toBe(2);
  });

  it("no key = a clean no-op: the demand columns are left untouched", async () => {
    delete process.env.SIMPLE_ANALYTICS_API_KEY;

    await seedArtist("art_a", "artist-a", null);
    await seedTrack({ artistIds: ["art_a"], trackId: "t1" });
    // Pre-seed a demand_score — a missing key must NOT wipe it.
    await db.execute({
      args: [],
      sql: `update tracks set demand_score = 42 where track_id = 't1'`,
    });

    const summary = await recordDemand({ fetchImpl: saFetch([]), now: NOW });

    expect(summary.configured).toBe(false);
    expect(summary.tracksScored).toBe(0);
    expect(await demandScore("t1")).toBe(42); // untouched
  });
});

// ── The social referrers read (Part 3 — the site-side half of reach) ─────────────────────────────
// `classifySocialReferrer` / `summarizeReferrers` are pure; `readSocialReferrers` folds an SA
// `fields=referrers` response into per-platform social→site arrivals (unprovisioned → clean no-op).

/** A fetch stub returning the given SA `referrers` as a version-5 response. */
function saReferrersFetch(referrers: { pageviews?: number; value: string }[]): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ referrers }), { status: 200 })) as unknown as typeof fetch;
}

describe("classifySocialReferrer", () => {
  it("maps a known social host (incl. short-link + subdomain) to its platform", () => {
    expect(classifySocialReferrer("t.co")).toBe("x");
    expect(classifySocialReferrer("www.tiktok.com")).toBe("tiktok");
    expect(classifySocialReferrer("l.instagram.com")).toBe("instagram");
    expect(classifySocialReferrer("youtu.be")).toBe("youtube");
  });

  it("returns undefined for a non-social referrer", () => {
    expect(classifySocialReferrer("google.com")).toBeUndefined();
    expect(classifySocialReferrer("")).toBeUndefined();
  });
});

describe("summarizeReferrers", () => {
  it("folds several hosts of one platform together and drops non-social + zero rows, highest-first", () => {
    const arrivals = summarizeReferrers([
      { pageviews: 10, value: "t.co" },
      { pageviews: 5, value: "twitter.com" },
      { pageviews: 40, value: "www.tiktok.com" },
      { pageviews: 100, value: "google.com" }, // non-social → dropped
      { pageviews: 0, value: "youtube.com" }, // zero → dropped
    ]);

    expect(arrivals).toEqual([
      { pageviews: 40, platform: "tiktok" },
      { pageviews: 15, platform: "x" },
    ]);
  });
});

describe("readSocialReferrers", () => {
  it("returns per-platform arrivals + the total from the SA referrers read", async () => {
    const result = await readSocialReferrers({
      fetchImpl: saReferrersFetch([
        { pageviews: 30, value: "www.tiktok.com" },
        { pageviews: 12, value: "t.co" },
      ]),
      now: NOW,
    });

    expect(result.configured).toBe(true);
    expect(result.total).toBe(42);
    expect(result.arrivals).toEqual([
      { pageviews: 30, platform: "tiktok" },
      { pageviews: 12, platform: "x" },
    ]);
  });

  it("is a clean no-op with no key (never a wrong signal)", async () => {
    delete process.env.SIMPLE_ANALYTICS_API_KEY;

    const result = await readSocialReferrers({ fetchImpl: saReferrersFetch([]), now: NOW });

    expect(result.configured).toBe(false);
    expect(result.total).toBe(0);
    expect(result.arrivals).toEqual([]);
  });
});
