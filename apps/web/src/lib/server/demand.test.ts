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

      `2026-07-01T00:00:0${options.id.length % 10}.000Z`,
    ],
    sql: `insert into crawl_frontier
            (id, kind, source, external_id, hop, label_slug, state, created_at, updated_at)
          values (?, ?, 'musicbrainz', ?, ?, ?, ?, ?, 'x')`,
  });
}

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

    expect(extractEntityPath("/artist/noisia?ref=x")).toEqual({ kind: "artist", slug: "noisia" });

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

    await seedTrack({ artistIds: ["art_a"], trackId: "t1" });
    await seedTrack({ labelId: "lab_l", trackId: "t2" });
    await seedTrack({ artistIds: ["art_a"], labelId: "lab_l", trackId: "t3" });
    await seedTrack({ trackId: "t4" });

    const summary = await recordDemand({
      fetchImpl: saFetch([
        { pageviews: 10, value: "/artist/artist-a" },
        { pageviews: 4, value: "/label/label-l" },
        { pageviews: 999, value: "/artist/nobody" },
        { pageviews: 500, value: "/admin/catalogue" },
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
    expect(await demandScore("t3")).toBe(14);
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

    await recordDemand({
      fetchImpl: saFetch([{ pageviews: 3, value: "/label/nobody" }]),
      now: NOW,
    });
    expect(await demandScore("t1")).toBeNull();
  });

  it("scores a vetoed row but the capture queue still excludes it, and demand only reorders within a tier", async () => {
    await seedArtist("art_a", "artist-a", null);

    await seedTrack({ artistIds: ["art_a"], capturePriority: -1, trackId: "t_veto" });

    await seedTrack({ artistIds: ["art_a"], capturePriority: 3, trackId: "t_hi" });
    await seedTrack({ capturePriority: 3, trackId: "t_lo" });

    await recordDemand({
      fetchImpl: saFetch([{ pageviews: 10, value: "/artist/artist-a" }]),
      now: NOW,
    });

    expect(await demandScore("t_veto")).toBe(10);
    expect(await demandScore("t_hi")).toBe(10);
    expect(await demandScore("t_lo")).toBeNull();

    await setCatalogueCapturePaused(false);
    const queue = await listTrackWork({ kind: "capture", scope: "catalogue" });
    const ids = queue.map((item) => item.trackId);

    expect(ids).not.toContain("t_veto");

    expect(ids.indexOf("t_hi")).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf("t_hi")).toBeLessThan(ids.indexOf("t_lo"));
  });

  it("promotes only PENDING frontier nodes of demanded entities, within a hop", async () => {
    await seedArtist("art_a", "artist-a", "mb_artist_a");
    await seedLabel("lab_l", "label-l");

    await seedFrontier({
      externalId: "rel1",
      hop: 1,
      id: "n_label",
      kind: "release",
      labelSlug: "label-l",
    });

    await seedFrontier({
      externalId: "mb_artist_a",
      hop: 1,
      id: "musicbrainz:artist:mb_artist_a",
      kind: "artist",
    });
    await seedFrontier({
      externalId: "rel2",
      hop: 1,
      id: "n_other",
      kind: "release",
      labelSlug: "other",
    });

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

    expect(await demandRank("n_label")).toBe(0);
    expect(await demandRank("musicbrainz:artist:mb_artist_a")).toBe(0);
    expect(await demandRank("n_other")).toBe(1);
    expect(await demandRank("n_done")).toBe(1);
    expect(summary.frontierPromoted).toBe(2);
  });

  it("no key = a clean no-op: the demand columns are left untouched", async () => {
    delete process.env.SIMPLE_ANALYTICS_API_KEY;

    await seedArtist("art_a", "artist-a", null);
    await seedTrack({ artistIds: ["art_a"], trackId: "t1" });

    await db.execute({
      args: [],
      sql: `update tracks set demand_score = 42 where track_id = 't1'`,
    });

    const summary = await recordDemand({ fetchImpl: saFetch([]), now: NOW });

    expect(summary.configured).toBe(false);
    expect(summary.tracksScored).toBe(0);
    expect(await demandScore("t1")).toBe(42);
  });

  it("seeks demanded artist edges and adds every demanded artist credit", async () => {
    await seedArtist("art_a", "artist-a", null);
    await seedArtist("art_b", "artist-b", null);
    await seedTrack({ artistIds: ["art_a", "art_b"], trackId: "t1" });

    const issued: string[] = [];
    const real = db;

    holder.db = {
      ...real,
      batch: async (statements: { sql: string }[], mode?: string) => {
        issued.push(...statements.map((statement) => statement.sql));

        return real.batch(statements as never, mode as never);
      },
      execute: (statement: never) => real.execute(statement),
    } as unknown as Client;

    try {
      await recordDemand({
        fetchImpl: saFetch([
          { pageviews: 5, value: "/artist/artist-a" },
          { pageviews: 7, value: "/artist/artist-b" },
        ]),
        now: NOW,
      });
    } finally {
      holder.db = real;
    }

    expect(await demandScore("t1")).toBe(12);

    const bump = issued.find((sql) => /update tracks set demand_score = coalesce/.test(sql));

    expect(bump).toBeDefined();

    const plan = await real.execute({
      args: ["art_a", 5, "art_b", 7],
      sql: `explain query plan ${bump ?? ""}`,
    });
    const details = (plan.rows as unknown as { detail: string }[]).map((row) => row.detail);

    expect(details.some((detail) => /^SCAN tracks\b/.test(detail))).toBe(false);
    expect(details.some((detail) => /^SEARCH tracks\b/.test(detail))).toBe(true);
    expect(
      details.some((detail) =>
        /SEARCH track_artists USING INDEX track_artists_artist_id_idx/.test(detail),
      ),
    ).toBe(true);
  });
});

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
      { pageviews: 100, value: "google.com" },
      { pageviews: 0, value: "youtube.com" },
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
