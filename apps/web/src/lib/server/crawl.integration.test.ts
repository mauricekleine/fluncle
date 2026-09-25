import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mostRecentSeedRearmBoundary, setSeedRearmClockForTests } from "./crawl-rearm-schedule";
import { createIntegrationDb, seedTrack } from "./integration-db";
import { setMusicbrainzRateLimitForTests } from "./musicbrainz";

let db: Client;
let fixtureDirectory: string | undefined;

function drainedBeforeLastPass(): string {
  return new Date(mostRecentSeedRearmBoundary(new Date()).getTime() - 1000).toISOString();
}

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

const LABEL_MBID = "label-medschool";

const HOSPITAL_MBID = "label-hospital";
const LABEL_MBIDS: Record<string, string> = {
  "Hospital Records": HOSPITAL_MBID,
  "Med School": LABEL_MBID,
};
const ARTIST_MBID = "artist-etherwood";
const OTHER_ARTIST_MBID = "artist-hospital-guest";
const SEED_RELEASE = "release-seed";
const HOP2_RELEASE = "release-hop2";
const SEED_RELEASE_GROUP = "rg-medschool-sampler";
const HOP2_RELEASE_GROUP = "rg-hospital-sampler";

function release(
  id: string,
  label: string,
  releaseGroup: null | string,
  tracks: { id: string; isrc?: string; title: string }[],

  withDiscogs = true,
) {
  return {
    "artist-credit": [{ artist: { id: ARTIST_MBID, name: "Etherwood" } }],
    "cover-art-archive": { front: true },
    date: "2013-06-10",
    id,
    "label-info": [{ label: { id: LABEL_MBIDS[label] ?? LABEL_MBID, name: label } }],

    ...(releaseGroup ? { "release-group": { id: releaseGroup } } : {}),
    media: [
      {
        tracks: tracks.map((track) => ({
          recording: {
            "artist-credit": [
              { artist: { id: ARTIST_MBID, name: "Etherwood" } },

              { artist: { id: "89ad4ac3-39f7-470e-963a-56509c546377", name: "Various Artists" } },
            ],
            id: track.id,
            isrcs: track.isrc ? [track.isrc] : [],
            length: 261901,
            title: track.title,
          },
        })),
      },
    ],
    relations: withDiscogs
      ? [{ type: "discogs", url: { resource: "https://www.discogs.com/release/6414598" } }]
      : [],
    title: `${label} sampler`,
  };
}

function stubMusicbrainz(): void {
  vi.stubGlobal(
    "fetch",

    vi.fn((url: string) => {
      const json = (body: unknown) =>
        Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

      if (url.includes("/label?query=")) {
        return json({ labels: [{ id: LABEL_MBID, name: "Med School", score: 100 }] });
      }

      if (url.includes(`/release?label=${LABEL_MBID}`)) {
        return json({ "release-count": 1, releases: [{ id: SEED_RELEASE }] });
      }

      if (url.includes(`/release?artist=${ARTIST_MBID}`)) {
        return json({
          "release-count": 2,
          releases: [{ id: SEED_RELEASE }, { id: HOP2_RELEASE }],
        });
      }

      if (url.includes(`/release?artist=${OTHER_ARTIST_MBID}`)) {
        return json({ "release-count": 0, releases: [] });
      }

      if (url.includes(`/release/${SEED_RELEASE}`)) {
        return json(
          release(SEED_RELEASE, "Med School", SEED_RELEASE_GROUP, [
            { id: "rec-1", isrc: "GBCJY1300173", title: "Weightless" },
            { id: "rec-2", title: "Begin by Letting Go" },
          ]),
        );
      }

      if (url.includes(`/release/${HOP2_RELEASE}`)) {
        return json(
          release(
            HOP2_RELEASE,
            "Hospital Records",
            HOP2_RELEASE_GROUP,
            [{ id: "rec-3", title: "A Hop-2 Track" }],
            false,
          ),
        );
      }

      return json({});
    }),
  );
}

function stubMusicbrainzWithUnidentifiedHop2Label(): void {
  stubMusicbrainz();
  const inner = globalThis.fetch as unknown as (url: string) => Promise<Response>;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const response = await inner(url);

      if (!url.includes(`/release/${HOP2_RELEASE}`)) {
        return response;
      }

      const body = (await response.json()) as { "label-info"?: { label?: { name?: string } }[] };
      body["label-info"] = [{ label: { name: "Hospital Records" } }];

      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

async function drain(maxHop = 2): Promise<{
  labelsDiscovered: string[];
  tracksSkipped: number;
  tracksWritten: number;
}> {
  const { crawlCatalogue } = await import("./crawl");
  const totals = { labelsDiscovered: [] as string[], tracksSkipped: 0, tracksWritten: 0 };

  for (let pass = 0; pass < 20; pass += 1) {
    const result = await crawlCatalogue({ limit: 10, maxHop });
    totals.tracksWritten += result.tracksWritten;
    totals.tracksSkipped += result.tracksSkipped;
    totals.labelsDiscovered.push(...result.labelsDiscovered);

    if (result.expanded === 0) {
      break;
    }
  }

  return totals;
}

const NOW = "2026-07-11T00:00:00.000Z";

const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const text = (value: unknown): string => (typeof value === "string" ? value : "");

async function seedLabel(name: string, slug: string, seedState: string): Promise<void> {
  await db.execute({
    args: [`lbl_${slug}`, name, slug, seedState, NOW, NOW],
    sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?)`,
  });
}

async function seedArtistRule(rule: {
  artistMbid: string;
  labelId?: null | string;
  rearmedAt?: null | string;
  verdict: "allow" | "block" | "unlisted";
}): Promise<void> {
  const labelKey = rule.labelId ?? "global";
  await db.execute({
    args: [
      `arl_${labelKey}_${rule.artistMbid}`,
      rule.artistMbid,
      `Artist ${rule.artistMbid}`,
      rule.verdict,
      rule.labelId ?? null,
      "operator",
      rule.rearmedAt ?? null,
      NOW,
      NOW,
    ],
    sql: `insert into artist_rules
            (id, artist_mbid, artist_name, verdict, label_id, source, rearmed_at, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  });
}

type RuleTestCredit = { id?: string; name: string };
type RuleTestTrack = { credits: RuleTestCredit[]; id: string; isrc?: string; title: string };

function ruleTestRelease(input: {
  id: string;
  labelMbid: string;
  labelName: string;
  tracks: RuleTestTrack[];
}): object {
  return {
    "cover-art-archive": { front: true },
    date: "2026-07-11",
    id: input.id,
    "label-info": [{ label: { id: input.labelMbid, name: input.labelName } }],
    media: [
      {
        tracks: input.tracks.map((track) => ({
          recording: {
            "artist-credit": track.credits.map((credit) => ({
              artist: credit.id ? { id: credit.id, name: credit.name } : { name: credit.name },
              name: credit.name,
            })),
            id: track.id,
            isrcs: track.isrc ? [track.isrc] : [],
            length: 180_000,
            title: track.title,
          },
        })),
      },
    ],
    relations: [],
    "release-group": { id: `rg-${input.id}` },
    title: `Album ${input.id}`,
  };
}

async function prepareRuleRelease(input: {
  labelId: string;
  labelMbid: string;
  labelName: string;
  labelSlug: string;
  releaseId: string;
  seedState: "disabled" | "enabled" | "undecided";
  tracks: RuleTestTrack[];
}): Promise<void> {
  await db.execute("update labels set seed_state = 'disabled'");
  await db.execute({
    args: [
      input.labelId,
      input.labelName,
      input.labelSlug,
      input.seedState,
      input.labelMbid,
      NOW,
      NOW,
    ],
    sql: `insert into labels
            (id, name, slug, seed_state, mb_label_id, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?)`,
  });
  await seedFrontierNode({
    createdAt: NOW,
    externalId: input.releaseId,
    hop: 0,
    id: `musicbrainz:release:${input.releaseId}`,
    kind: "release",
    labelSlug: input.labelSlug,
  });

  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const body = url.includes(`/release/${input.releaseId}`)
        ? ruleTestRelease({
            id: input.releaseId,
            labelMbid: input.labelMbid,
            labelName: input.labelName,
            tracks: input.tracks,
          })
        : {};
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }),
  );
}

async function seedFrontierNode(node: {
  createdAt: string;
  externalId: string;
  hop: number;
  id: string;
  kind: "artist" | "label" | "release";
  labelSlug: null | string;
  source?: "fluncle" | "musicbrainz";
  state?: "done" | "failed" | "pending" | "skipped";
}): Promise<void> {
  await db.execute({
    args: [
      node.id,
      node.kind,
      node.source ?? "musicbrainz",
      node.externalId,
      node.hop,
      node.labelSlug,
      node.state ?? "pending",
      node.createdAt,
      node.createdAt,
    ],
    sql: `insert into crawl_frontier
            (id, kind, source, external_id, hop, parent_id, label_slug, state, created_at, updated_at)
          values (?, ?, ?, ?, ?, null, ?, ?, ?, ?)`,
  });
}

beforeEach(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "fluncle-crawl-"));
  db = await createIntegrationDb({ url: `file:${join(fixtureDirectory, "fixture.db")}` });
  setMusicbrainzRateLimitForTests(0);
  stubMusicbrainz();

  await seedLabel("Medschool", "medschool", "enabled");
  await seedLabel("Anjunabeats", "anjunabeats", "disabled");
});

afterEach(async () => {
  db.close();

  if (fixtureDirectory) {
    await rm(fixtureDirectory, { force: true, recursive: true });
    fixtureDirectory = undefined;
  }
});

describe("the catalogue crawler", () => {
  it("walks label → release → artist → release and stores the ENABLED-label tracks, never findings", async () => {
    const totals = await drain();

    expect(totals.tracksWritten).toBe(2);

    const tracks = await db.execute("select track_id, title, label, isrc from tracks");
    expect(tracks.rows.map((row) => text(row.title)).sort(compare)).toEqual([
      "Begin by Letting Go",
      "Weightless",
    ]);

    expect(tracks.rows.map((row) => text(row.title))).not.toContain("A Hop-2 Track");

    const findings = await db.execute("select count(*) as n from findings");
    expect(Number(findings.rows[0]?.n)).toBe(0);

    expect(tracks.rows.map((row) => text(row.track_id)).sort(compare)).toEqual([
      "mb_rec-1",
      "mb_rec-2",
    ]);

    const mbids = await db.execute(
      "select track_id, mb_recording_id from tracks where track_id like 'mb\\_%' escape '\\'",
    );
    expect(
      mbids.rows.map((row) => `${text(row.track_id)}=${text(row.mb_recording_id)}`).sort(compare),
    ).toEqual(["mb_rec-1=rec-1", "mb_rec-2=rec-2"]);
  });

  it("leaves every agent queue's state at its DDL default — a crawled row is nobody's work item", async () => {
    await drain();

    const rows = await db.execute(
      `select t.capture_status, t.source_audio_key, emb.embedding_blob
       from tracks t
       left join track_embeddings emb on emb.track_id = t.track_id`,
    );

    for (const row of rows.rows) {
      expect(row.capture_status).toBe("pending");
      expect(row.source_audio_key).toBeNull();
      expect(row.embedding_blob).toBeNull();
    }
  });

  it("stamps the ISRC + Discogs ATTEMPT record on every row it writes (RFC identity-graph, Unit 1)", async () => {
    await drain();

    const rows = await db.execute(
      `select track_id, isrc, isrc_attempted_at, in_release_id,
              backfill_discogs_attempted_at, backfill_discogs_attempts,
              backfill_discogs_done_at, backfill_discogs_failures
       from tracks order by track_id`,
    );

    expect(rows.rows).toHaveLength(2);

    for (const row of rows.rows) {
      expect(row.isrc_attempted_at).not.toBeNull();
      expect(row.backfill_discogs_attempted_at).not.toBeNull();
      expect(Number(row.backfill_discogs_attempts)).toBe(1);
      expect(Number(row.backfill_discogs_failures)).toBe(0);

      expect(row.in_release_id).toBe(6414598);
      expect(row.backfill_discogs_done_at).not.toBeNull();
    }

    const isrcless = rows.rows.find((row) => row.track_id === "mb_rec-2");
    expect(isrcless?.isrc).toBeNull();
    expect(isrcless?.isrc_attempted_at).not.toBeNull();
  });

  it("records a Discogs look that found NOTHING as attempted-but-not-done", async () => {
    await seedLabel("Hospital Records", "hospital-records", "enabled");

    await drain();

    const row = await db.execute(
      `select in_release_id, in_master_id, backfill_discogs_attempted_at,
              backfill_discogs_attempts, backfill_discogs_done_at
       from tracks where track_id = 'mb_rec-3'`,
    );

    expect(row.rows[0]?.in_release_id).toBeNull();
    expect(row.rows[0]?.in_master_id).toBeNull();

    expect(row.rows[0]?.backfill_discogs_attempted_at).not.toBeNull();
    expect(Number(row.rows[0]?.backfill_discogs_attempts)).toBe(1);
    expect(row.rows[0]?.backfill_discogs_done_at).toBeNull();
  });

  it("is IDEMPOTENT — a second crawl of the same graph writes zero new rows", async () => {
    const first = await drain();
    expect(first.tracksWritten).toBe(2);

    await db.execute("update crawl_frontier set state = 'pending', cursor = 0");

    const second = await drain();

    expect(second.tracksWritten).toBe(0);

    expect(second.tracksSkipped).toBe(3);

    const count = await db.execute("select count(*) as n from tracks");
    expect(Number(count.rows[0]?.n)).toBe(2);
  });

  it("never mints a second row for a track Fluncle already CERTIFIED (the ISRC dedupe)", async () => {
    await seedTrack(db, {
      logId: "004.7.2I",
      title: "Weightless",
      trackId: "spotifyid2222222222222",
    });
    await db.execute(
      "update tracks set isrc = 'GBCJY1300173' where track_id = 'spotifyid2222222222222'",
    );

    await drain();

    const shadow = await db.execute("select track_id from tracks where isrc = 'GBCJY1300173'");
    expect(shadow.rows.map((row) => row.track_id)).toEqual(["spotifyid2222222222222"]);

    const findings = await db.execute("select count(*) as n from findings");
    expect(Number(findings.rows[0]?.n)).toBe(1);
  });

  it("STOPS at the hop limit — maxHop 0 never leaves the seed label's own releases", async () => {
    const totals = await drain(0);

    expect(totals.tracksWritten).toBe(2);
    const titles = await db.execute("select title from tracks");
    expect(titles.rows.map((row) => row.title)).not.toContain("A Hop-2 Track");

    const artists = await db.execute(
      "select count(*) as n from crawl_frontier where kind = 'artist'",
    );
    expect(Number(artists.rows[0]?.n)).toBe(0);
  });

  it("mints a DISCOVERED label as `undecided` and does NOT crawl it", async () => {
    const totals = await drain();

    expect(totals.labelsDiscovered).toEqual(["Hospital Records"]);

    const label = await db.execute(
      "select seed_state, ruled_at, mb_label_id from labels where slug = 'hospital-records'",
    );
    expect(label.rows[0]?.seed_state).toBe("undecided");

    expect(label.rows[0]?.ruled_at).toBeNull();

    expect(label.rows[0]?.mb_label_id).toBe(HOSPITAL_MBID);

    const seeds = await db.execute(
      "select count(*) as n from crawl_frontier where source = 'fluncle'",
    );
    expect(Number(seeds.rows[0]?.n)).toBe(1);
  });

  it("ADOPTS the release's label MBID onto a label the archive already knows without one", async () => {
    await seedLabel("Hospital Records", "hospital-records", "undecided");

    const totals = await drain();

    const label = await db.execute(
      "select mb_label_id, seed_state from labels where slug = 'hospital-records'",
    );
    expect(label.rows[0]?.mb_label_id).toBe(HOSPITAL_MBID);

    expect(totals.labelsDiscovered).toEqual([]);

    expect(label.rows[0]?.seed_state).toBe("undecided");
  });

  it("never rewrites an identity the label already carries — adoption is fill-empty-only", async () => {
    await db.execute({
      args: ["lbl_hospital-records", "Hospital Records", "hospital-records", "enabled", NOW, NOW],
      sql: `insert into labels (id, name, slug, seed_state, mb_label_id, created_at, updated_at)
            values (?, ?, ?, ?, 'label-hospital-impostor', ?, ?)`,
    });

    await drain();

    const label = await db.execute(
      "select mb_label_id from labels where slug = 'hospital-records'",
    );
    expect(label.rows[0]?.mb_label_id).toBe("label-hospital-impostor");
  });

  it("REFUSES to discover a label the release names but does not identify", async () => {
    stubMusicbrainzWithUnidentifiedHop2Label();

    const totals = await drain();

    expect(totals.labelsDiscovered).toEqual([]);
    const rows = await db.execute("select slug from labels order by slug");
    expect(rows.rows.map((row) => text(row.slug))).toEqual(["anjunabeats", "medschool"]);
  });

  it("does not re-ask the operator to rule on a label he has already ruled on, under MB's spelling", async () => {
    await drain();

    const rows = await db.execute("select slug from labels where slug like '%med%'");
    expect(rows.rows.map((row) => row.slug)).toEqual(["medschool"]);
  });

  it("writes the ARCHIVE's label spelling, so The Ear's capture ladder can actually fire", async () => {
    await drain();

    const rows = await db.execute("select distinct label from tracks where label is not null");
    const labels = rows.rows.map((row) => text(row.label)).sort(compare);

    expect(labels).toContain("Medschool");
    expect(labels).not.toContain("Med School");

    const { labelSlug } = await import("./labels");
    const known = await db.execute("select slug from labels");
    const slugs = new Set(known.rows.map((row) => text(row.slug)));

    for (const label of labels) {
      expect(slugs.has(labelSlug(label) ?? "")).toBe(true);
    }
  });

  it("never seeds from a label the operator disabled or has not ruled on", async () => {
    await seedLabel("UKF", "ukf", "undecided");
    await drain();

    const seeds = await db.execute(
      "select external_id from crawl_frontier where source = 'fluncle'",
    );
    expect(seeds.rows.map((row) => row.external_id)).toEqual(["medschool"]);
  });

  it("is RESUMABLE — a pass that dies leaves the frontier where the next one picks up", async () => {
    const { crawlCatalogue, getCrawlPipelineSummary, getCrawlStatus } = await import("./crawl");

    await crawlCatalogue({ limit: 1, maxHop: 2 });
    const mid = await getCrawlStatus();

    expect(mid.frontier.done).toBe(1);
    expect(mid.frontier.pending).toBe(1);
    expect(mid.catalogueTracks).toBe(0);
    expect(await getCrawlPipelineSummary()).toEqual({
      anchorsPending: mid.anchorsPending,
      frontier: { pending: mid.frontier.pending },
      storablePending: mid.storablePending,
      unstorablePending: mid.unstorablePending,
    });

    await drain();
    const end = await getCrawlStatus();

    expect(end.catalogueTracks).toBe(2);
    expect(end.frontier.pending).toBe(0);
    expect((await getCrawlPipelineSummary()).frontier.pending).toBe(0);
  });

  it("skips a seed label MusicBrainz does not know, with a reason, instead of retrying forever", async () => {
    await seedLabel("A Label MB Never Heard Of", "unknown-label", "enabled");
    await drain();

    const row = await db.execute(
      "select state, note from crawl_frontier where external_id = 'unknown-label'",
    );
    expect(row.rows[0]?.state).toBe("skipped");
    expect(row.rows[0]?.note).toBe("no exact MusicBrainz label match");
  });

  it("stops the pass on the MusicBrainz circuit breaker instead of storming it", async () => {
    const { crawlCatalogue } = await import("./crawl");

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("", { status: 503 }))),
    );

    const result = await crawlCatalogue({ limit: 10, maxHop: 2 });

    expect(result.rateLimited).toBe(true);
    expect(result.failed).toBe(1);

    const row = await db.execute(
      "select state, failures, note from crawl_frontier where id = 'fluncle:label:medschool'",
    );
    expect(row.rows[0]?.state).toBe("pending");
    expect(Number(row.rows[0]?.failures)).toBe(0);
    expect(row.rows[0]?.note).toBe("musicbrainz rate-limited");
  });

  it("stamps `label_id` so a crawled track lands on the public /label/<slug> page", async () => {
    await drain();

    const rows = await db.execute(`
      select tracks.track_id, labels.slug
      from tracks join labels on labels.id = tracks.label_id
      where tracks.track_id like 'mb_%'
    `);

    expect(rows.rows.length).toBe(2);
    expect(new Set(rows.rows.map((row) => text(row.slug)))).toEqual(new Set(["medschool"]));
  });

  it("links the artist edge by IDENTITY, refusing a same-named row that is somebody else", async () => {
    const now = new Date().toISOString();
    await db.execute({
      args: ["art-impostor", "Etherwood", "etherwood", OTHER_ARTIST_MBID, now, now],
      sql: `insert into artists (id, name, slug, mbid, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?)`,
    });

    await drain();

    const edges = await db.execute(
      `select count(*) as n from track_artists where artist_id = 'art-impostor'`,
    );
    expect(Number(edges.rows[0]?.n)).toBe(0);
  });

  it("links the artist edge when the credit's mbid IS that row's identity", async () => {
    const now = new Date().toISOString();
    await db.execute({
      args: ["art-etherwood", "Etherwood", "etherwood", ARTIST_MBID, now, now],
      sql: `insert into artists (id, name, slug, mbid, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?)`,
    });

    await drain();

    const edges = await db.execute(
      `select count(*) as n from track_artists where artist_id = 'art-etherwood'`,
    );

    expect(Number(edges.rows[0]?.n)).toBe(2);
  });

  it("mints + links the ALBUM inline, folded on the release-group MBID", async () => {
    await drain();

    const albums = await db.execute("select slug, release_group_mbid from albums order by slug");
    expect(albums.rows.map((row) => text(row.slug))).toEqual(["med-school-sampler"]);

    expect(new Set(albums.rows.map((row) => text(row.release_group_mbid)))).toEqual(
      new Set([SEED_RELEASE_GROUP]),
    );

    const linked = await db.execute(`
      select tracks.track_id, albums.slug
      from tracks join albums on albums.id = tracks.album_id
      where tracks.track_id like 'mb_%'
    `);
    expect(linked.rows.length).toBe(2);
    expect(new Set(linked.rows.map((row) => text(row.slug)))).toEqual(
      new Set(["med-school-sampler"]),
    );

    const titles = await db.execute("select album from tracks where track_id like 'mb_%'");
    expect(titles.rows.every((row) => text(row.album).length > 0)).toBe(true);
  });

  it("FALLBACK: a release with NO release group still links its album by the slug path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const json = (body: unknown) =>
          Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

        if (url.includes("/label?query=")) {
          return json({ labels: [{ id: LABEL_MBID, name: "Med School", score: 100 }] });
        }

        if (url.includes(`/release?label=${LABEL_MBID}`)) {
          return json({ "release-count": 1, releases: [{ id: SEED_RELEASE }] });
        }

        if (url.includes(`/release?artist=${ARTIST_MBID}`)) {
          return json({ "release-count": 1, releases: [{ id: SEED_RELEASE }] });
        }

        if (url.includes(`/release/${SEED_RELEASE}`)) {
          return json(
            release(SEED_RELEASE, "Med School", null, [{ id: "rec-1", title: "Weightless" }]),
          );
        }

        return json({});
      }),
    );

    await drain();

    const linked = await db.execute(`
      select albums.slug, albums.release_group_mbid
      from tracks join albums on albums.id = tracks.album_id
      where tracks.track_id = 'mb_rec-1'
    `);
    expect(text(linked.rows[0]?.slug)).toBe("med-school-sampler");

    expect(linked.rows[0]?.release_group_mbid).toBeNull();
  });
  it("reports the seed plan and writes NOTHING on a dry run", async () => {
    const { crawlCatalogue } = await import("./crawl");

    const result = await crawlCatalogue({ dryRun: true, limit: 10 });

    expect(result.dryRun).toBe(true);
    expect(result.seeded).toBe(1);

    const frontier = await db.execute("select count(*) as n from crawl_frontier");
    const tracks = await db.execute("select count(*) as n from tracks");
    expect(Number(frontier.rows[0]?.n)).toBe(0);
    expect(Number(tracks.rows[0]?.n)).toBe(0);
  });
});

describe("the STORAGE GATE — a track is stored only when its release's label is ENABLED", () => {
  it("stores ZERO tracks for a release on a non-enabled label, but STILL surfaces that label for ruling", async () => {
    await drain();

    const hop2 = await db.execute("select track_id from tracks where title = 'A Hop-2 Track'");
    expect(hop2.rows).toHaveLength(0);

    const label = await db.execute(
      "select seed_state, ruled_at from labels where slug = 'hospital-records'",
    );
    expect(label.rows[0]?.seed_state).toBe("undecided");
    expect(label.rows[0]?.ruled_at).toBeNull();

    const album = await db.execute(
      "select slug from albums where slug = 'hospital-records-sampler'",
    );
    expect(album.rows).toHaveLength(0);
  });

  it("stores a release's tracks once its label is ENABLED — the gate keys on the LABEL, not the hop", async () => {
    await seedLabel("Hospital Records", "hospital-records", "enabled");

    await drain();

    const hop2 = await db.execute("select track_id from tracks where title = 'A Hop-2 Track'");
    expect(hop2.rows.map((row) => text(row.track_id))).toEqual(["mb_rec-3"]);

    const all = await db.execute("select count(*) as n from tracks");
    expect(Number(all.rows[0]?.n)).toBe(3);
  });
});

describe("the artist exception gate", () => {
  it("a blocklist drops on the FIRST credit and keeps the guest feature", async () => {
    await prepareRuleRelease({
      labelId: "lbl_scope",
      labelMbid: "label-scope",
      labelName: "Scope Records",
      labelSlug: "scope-records",
      releaseId: "release-first-block",
      seedState: "enabled",
      tracks: [
        {
          credits: [
            { name: "Unresolved join phrase" },
            { id: "artist-blocked", name: "Blocked" },
            { id: "artist-keeper", name: "Keeper" },
          ],
          id: "rec-first-blocked",
          title: "Blocked billing",
        },
        {
          credits: [
            { id: "artist-keeper", name: "Keeper" },
            { id: "artist-blocked", name: "Blocked" },
          ],
          id: "rec-blocked-guest",
          title: "Blocked guest",
        },
      ],
    });
    await seedArtistRule({ artistMbid: "artist-blocked", verdict: "block" });

    const { crawlCatalogue } = await import("./crawl");
    const pass = await crawlCatalogue({ limit: 1, maxHop: 0 });

    expect(pass.tracksSkippedArtistRule).toBe(1);
    expect(pass.tracksWritten).toBe(1);
    const tracks = await db.execute("select title from tracks");
    expect(tracks.rows.map((row) => text(row.title))).toEqual(["Blocked guest"]);
  });

  it("a blocklist keeps a candidate whose credits carry no MBID", async () => {
    await prepareRuleRelease({
      labelId: "lbl_scope",
      labelMbid: "label-scope",
      labelName: "Scope Records",
      labelSlug: "scope-records",
      releaseId: "release-null-credit",
      seedState: "enabled",
      tracks: [
        {
          credits: [{ name: "Unknown billing" }],
          id: "rec-null-credit",
          title: "No identity",
        },
      ],
    });
    await seedArtistRule({ artistMbid: "artist-blocked", verdict: "block" });

    const { crawlCatalogue } = await import("./crawl");
    const pass = await crawlCatalogue({ limit: 1, maxHop: 0 });

    expect(pass.tracksSkippedArtistRule).toBe(0);
    expect(pass.tracksWritten).toBe(1);
  });

  it("an allow stores a billed record from a disabled label and skips the same artist's guest credit", async () => {
    await prepareRuleRelease({
      labelId: "lbl_scope",
      labelMbid: "label-scope",
      labelName: "Scope Records",
      labelSlug: "scope-records",
      releaseId: "release-first-allow",
      seedState: "disabled",
      tracks: [
        {
          credits: [
            { id: "artist-allowed", name: "Allowed" },
            { id: "artist-guest", name: "Guest" },
          ],
          id: "rec-first-allowed",
          title: "Allowed billing",
        },
        {
          credits: [
            { id: "artist-other", name: "Other" },
            { id: "artist-allowed", name: "Allowed" },
          ],
          id: "rec-allowed-guest",
          title: "Allowed guest",
        },
      ],
    });
    await seedArtistRule({ artistMbid: "artist-allowed", verdict: "allow" });

    const { crawlCatalogue } = await import("./crawl");
    const pass = await crawlCatalogue({ limit: 1, maxHop: 0 });

    expect(pass.tracksAllowedIn).toBe(1);
    expect(pass.tracksSkippedLabelGate).toBe(1);
    expect(pass.tracksWritten).toBe(1);
    const tracks = await db.execute("select title from tracks");
    expect(tracks.rows.map((row) => text(row.title))).toEqual(["Allowed billing"]);
  });

  it("a per-label rule beats a global rule", async () => {
    await prepareRuleRelease({
      labelId: "lbl_scope",
      labelMbid: "label-scope",
      labelName: "Scope Records",
      labelSlug: "scope-records",
      releaseId: "release-precedence",
      seedState: "disabled",
      tracks: [
        {
          credits: [{ id: "artist-precedence", name: "Precedence" }],
          id: "rec-precedence",
          title: "Specific wins",
        },
      ],
    });
    await seedArtistRule({ artistMbid: "artist-precedence", verdict: "block" });
    await seedArtistRule({
      artistMbid: "artist-precedence",
      labelId: "lbl_scope",
      verdict: "allow",
    });

    const { crawlCatalogue } = await import("./crawl");
    const pass = await crawlCatalogue({ limit: 1, maxHop: 0 });

    expect(pass.tracksAllowedIn).toBe(1);
    expect(pass.tracksWritten).toBe(1);
  });

  it("two enabled labels that fold together never share a scope", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await prepareRuleRelease({
      labelId: "lbl_radar_two",

      labelMbid: "label-radar-unknown",
      labelName: "Radar-Records",
      labelSlug: "radar-records-two",
      releaseId: "release-radar-two",
      seedState: "enabled",
      tracks: [
        {
          credits: [{ id: "artist-radar", name: "Radar Artist" }],
          id: "rec-radar-two",
          title: "The other Radar",
        },
      ],
    });
    await db.execute(
      "update labels set mb_label_id = 'label-radar-two' where id = 'lbl_radar_two'",
    );
    await db.execute({
      args: ["lbl_radar_one", "Radar Records", "radar-records-one", "label-radar-one", NOW, NOW],
      sql: `insert into labels (id, name, slug, seed_state, mb_label_id, created_at, updated_at)
            values (?, ?, ?, 'enabled', ?, ?, ?)`,
    });
    await seedArtistRule({
      artistMbid: "artist-radar",
      labelId: "lbl_radar_one",
      verdict: "block",
    });

    const { crawlCatalogue } = await import("./crawl");
    const pass = await crawlCatalogue({ limit: 1, maxHop: 0 });

    expect(pass.tracksSkippedArtistRule).toBe(0);
    expect(pass.tracksWritten).toBe(1);
    expect(
      warn.mock.calls.some(([line]) =>
        typeof line === "string" ? line.includes('"event":"crawl.scope-ambiguous"') : false,
      ),
    ).toBe(true);
    warn.mockRestore();
  });

  it("an ambiguous label fold never applies a global rule", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await prepareRuleRelease({
      labelId: "lbl_echo_two",
      labelMbid: "label-echo-unknown",
      labelName: "Echo-Records",
      labelSlug: "echo-records-two",
      releaseId: "release-echo-two",
      seedState: "enabled",
      tracks: [
        {
          credits: [{ id: "artist-echo", name: "Echo Artist" }],
          id: "rec-echo-two",
          title: "Global must not leak",
        },
      ],
    });
    await db.execute("update labels set mb_label_id = 'label-echo-two' where id = 'lbl_echo_two'");
    await db.execute({
      args: ["lbl_echo_one", "Echo Records", "echo-records-one", "label-echo-one", NOW, NOW],
      sql: `insert into labels (id, name, slug, seed_state, mb_label_id, created_at, updated_at)
            values (?, ?, ?, 'enabled', ?, ?, ?)`,
    });
    await seedArtistRule({ artistMbid: "artist-echo", verdict: "block" });

    const { crawlCatalogue } = await import("./crawl");
    const pass = await crawlCatalogue({ limit: 1, maxHop: 0 });

    expect(pass.tracksSkippedArtistRule).toBe(0);
    expect(pass.tracksWritten).toBe(1);
    expect(
      warn.mock.calls.some(([line]) =>
        typeof line === "string" ? line.includes('"event":"crawl.scope-ambiguous"') : false,
      ),
    ).toBe(true);
    warn.mockRestore();
  });

  it("a fully-excluded release mints no albums row", async () => {
    await prepareRuleRelease({
      labelId: "lbl_scope",
      labelMbid: "label-scope",
      labelName: "Scope Records",
      labelSlug: "scope-records",
      releaseId: "release-no-album",
      seedState: "enabled",
      tracks: [
        {
          credits: [{ id: "artist-blocked", name: "Blocked" }],
          id: "rec-no-album",
          title: "Nothing kept",
        },
      ],
    });
    await seedArtistRule({ artistMbid: "artist-blocked", verdict: "block" });

    const { crawlCatalogue } = await import("./crawl");
    await crawlCatalogue({ limit: 1, maxHop: 0 });

    const albums = await db.execute("select id from albums");
    expect(albums.rows).toHaveLength(0);
  });

  it("the artist-hop leg still enqueues from excluded credits", async () => {
    await prepareRuleRelease({
      labelId: "lbl_scope",
      labelMbid: "label-scope",
      labelName: "Scope Records",
      labelSlug: "scope-records",
      releaseId: "release-excluded-hop",
      seedState: "enabled",
      tracks: [
        {
          credits: [
            { id: "artist-blocked", name: "Blocked" },
            { id: "artist-discovery", name: "Discovery" },
          ],
          id: "rec-excluded-hop",
          title: "Excluded but walked",
        },
      ],
    });
    await seedArtistRule({ artistMbid: "artist-blocked", verdict: "block" });

    const { crawlCatalogue } = await import("./crawl");
    await crawlCatalogue({ limit: 1, maxHop: 1 });

    const artists = await db.execute(
      "select external_id from crawl_frontier where kind = 'artist' order by external_id",
    );
    expect(artists.rows.map((row) => text(row.external_id))).toEqual([
      "artist-blocked",
      "artist-discovery",
    ]);
  });

  it("split counters remain exact and tracksSkipped is their sum", async () => {
    await db.execute("update labels set seed_state = 'disabled'");
    await db.execute({
      args: ["lbl_counter_in", "Counter In", "counter-in", "label-counter-in", NOW, NOW],
      sql: `insert into labels (id, name, slug, seed_state, mb_label_id, created_at, updated_at)
            values (?, ?, ?, 'enabled', ?, ?, ?)`,
    });
    await db.execute({
      args: ["lbl_counter_out", "Counter Out", "counter-out", "label-counter-out", NOW, NOW],
      sql: `insert into labels (id, name, slug, seed_state, mb_label_id, created_at, updated_at)
            values (?, ?, ?, 'disabled', ?, ?, ?)`,
    });
    await db.execute(
      `insert into tracks (track_id, title, artists_json, duration_ms)
       values ('mb_rec-counter-held', 'Already held', '["Held"]', 180000)`,
    );
    await seedArtistRule({ artistMbid: "artist-counter-block", verdict: "block" });
    await seedArtistRule({ artistMbid: "artist-counter-allow", verdict: "allow" });

    const counterReleases: [string, string][] = [
      ["release-counter-in", "counter-in"],
      ["release-counter-out", "counter-out"],
    ];

    for (const [releaseId, labelSlug] of counterReleases) {
      await seedFrontierNode({
        createdAt: NOW,
        externalId: releaseId,
        hop: 0,
        id: `musicbrainz:release:${releaseId}`,
        kind: "release",
        labelSlug,
      });
    }

    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        let body: object = {};

        if (url.includes("/release/release-counter-in")) {
          body = ruleTestRelease({
            id: "release-counter-in",
            labelMbid: "label-counter-in",
            labelName: "Counter In",
            tracks: [
              {
                credits: [{ id: "artist-held", name: "Held" }],
                id: "rec-counter-held",
                title: "Already held",
              },
              {
                credits: [{ id: "artist-counter-block", name: "Blocked" }],
                id: "rec-counter-block",
                title: "Blocked",
              },
            ],
          });
        } else if (url.includes("/release/release-counter-out")) {
          body = ruleTestRelease({
            id: "release-counter-out",
            labelMbid: "label-counter-out",
            labelName: "Counter Out",
            tracks: [
              {
                credits: [{ id: "artist-counter-allow", name: "Allowed" }],
                id: "rec-counter-allow",
                title: "Allowed",
              },
              {
                credits: [{ id: "artist-counter-other", name: "Other" }],
                id: "rec-counter-label",
                title: "Label gated",
              },
            ],
          });
        }

        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }),
    );

    const { crawlCatalogue } = await import("./crawl");
    const pass = await crawlCatalogue({ limit: 4, maxHop: 0 });

    expect(pass.tracksFound).toBe(4);
    expect(pass.tracksAllowedIn).toBe(1);
    expect(pass.tracksSkippedHeld).toBe(1);
    expect(pass.tracksSkippedLabelGate).toBe(1);
    expect(pass.tracksSkippedArtistRule).toBe(1);
    expect(pass.tracksSkipped).toBe(
      pass.tracksSkippedHeld + pass.tracksSkippedLabelGate + pass.tracksSkippedArtistRule,
    );
    expect(pass.tracksWritten).toBe(1);

    const notes = await db.execute(
      `select external_id, note from crawl_frontier
       where external_id in ('release-counter-in', 'release-counter-out')
       order by external_id`,
    );
    expect(notes.rows.map((row) => `${text(row.external_id)}:${text(row.note)}`)).toEqual([
      "release-counter-in:stored=0 skipped_held=1 skipped_label=0 skipped_rule=1",
      "release-counter-out:stored=1 skipped_held=0 skipped_label=1 skipped_rule=0",
    ]);
  });

  it("an unlisted first credit stores from an ENABLED label exactly as an unruled one does", async () => {
    await prepareRuleRelease({
      labelId: "lbl_scope",
      labelMbid: "label-scope",
      labelName: "Scope Records",
      labelSlug: "scope-records",
      releaseId: "release-unlisted-enabled",
      seedState: "enabled",
      tracks: [
        {
          credits: [
            { id: "artist-unlisted", name: "Unlisted Original" },
            { id: "artist-keeper", name: "Keeper" },
          ],
          id: "rec-unlisted-remix",
          title: "Remix billed to the original",
        },
      ],
    });
    await seedArtistRule({ artistMbid: "artist-unlisted", verdict: "unlisted" });

    const { crawlCatalogue } = await import("./crawl");
    const pass = await crawlCatalogue({ limit: 1, maxHop: 0 });

    expect(pass.tracksSkippedArtistRule).toBe(0);
    expect(pass.tracksWritten).toBe(1);
    const tracks = await db.execute("select title from tracks");
    expect(tracks.rows.map((row) => text(row.title))).toEqual(["Remix billed to the original"]);
  });

  it("a global unlisted and a PER-LABEL allow coexist: the record stores, the page is another axis", async () => {
    await prepareRuleRelease({
      labelId: "lbl_scope",
      labelMbid: "label-scope",
      labelName: "Scope Records",
      labelSlug: "scope-records",
      releaseId: "release-unlisted-allowed",
      seedState: "disabled",
      tracks: [
        {
          credits: [{ id: "artist-unlisted", name: "Unlisted Original" }],
          id: "rec-unlisted-allowed",
          title: "Allowed off a disabled label",
        },
      ],
    });
    await seedArtistRule({ artistMbid: "artist-unlisted", verdict: "unlisted" });
    await seedArtistRule({
      artistMbid: "artist-unlisted",
      labelId: "lbl_scope",
      verdict: "allow",
    });

    const { crawlCatalogue } = await import("./crawl");
    const pass = await crawlCatalogue({ limit: 1, maxHop: 0 });

    expect(pass.tracksSkippedArtistRule).toBe(0);
    expect(pass.tracksAllowedIn).toBe(1);
    expect(pass.tracksWritten).toBe(1);
  });

  it("an unlisted first credit is skipped by a DISABLED label exactly as an unruled one is", async () => {
    await prepareRuleRelease({
      labelId: "lbl_scope",
      labelMbid: "label-scope",
      labelName: "Scope Records",
      labelSlug: "scope-records",
      releaseId: "release-unlisted-disabled",
      seedState: "disabled",
      tracks: [
        {
          credits: [{ id: "artist-unlisted", name: "Unlisted Original" }],
          id: "rec-unlisted-refused",
          title: "Refused by the label default",
        },
      ],
    });
    await seedArtistRule({ artistMbid: "artist-unlisted", verdict: "unlisted" });

    const { crawlCatalogue } = await import("./crawl");
    const pass = await crawlCatalogue({ limit: 1, maxHop: 0 });

    expect(pass.tracksSkippedArtistRule).toBe(0);
    expect(pass.tracksSkippedLabelGate).toBe(1);
    expect(pass.tracksWritten).toBe(0);
    const tracks = await db.execute("select count(*) as n from tracks");
    expect(Number(tracks.rows[0]?.n)).toBe(0);
  });
});

describe("the allowed-artist re-arm", () => {
  it("roots an already-pending allowed artist at hop 0", async () => {
    await db.execute("update labels set seed_state = 'disabled'");
    await seedFrontierNode({
      createdAt: NOW,
      externalId: "artist-pending-allow",
      hop: 2,
      id: "musicbrainz:artist:artist-pending-allow",
      kind: "artist",
      labelSlug: "old-provenance",
    });
    await seedArtistRule({ artistMbid: "artist-pending-allow", verdict: "allow" });

    const { crawlCatalogue } = await import("./crawl");
    const pass = await crawlCatalogue({ limit: 0, maxHop: 2 });
    expect(pass.artistsRearmed).toBe(1);

    const node = await db.execute(
      `select cursor, hop, label_slug, parent_id, state from crawl_frontier
       where id = 'musicbrainz:artist:artist-pending-allow'`,
    );
    expect(node.rows[0]?.state).toBe("pending");
    expect(Number(node.rows[0]?.cursor)).toBe(0);
    expect(Number(node.rows[0]?.hop)).toBe(0);
    expect(node.rows[0]?.label_slug).toBeNull();
    expect(node.rows[0]?.parent_id).toBeNull();
  });

  it("roots a failed allowed artist without bypassing its backoff", async () => {
    await db.execute("update labels set seed_state = 'disabled'");
    await seedFrontierNode({
      createdAt: NOW,
      externalId: "artist-failed-allow",
      hop: 2,
      id: "musicbrainz:artist:artist-failed-allow",
      kind: "artist",
      labelSlug: "old-provenance",
      state: "failed",
    });
    await db.execute({
      args: [NOW],
      sql: `update crawl_frontier
            set cursor = 73, failures = 2, attempted_at = ?,
                parent_id = 'musicbrainz:artist:old-parent'
            where id = 'musicbrainz:artist:artist-failed-allow'`,
    });
    await seedArtistRule({ artistMbid: "artist-failed-allow", verdict: "allow" });

    const { crawlCatalogue } = await import("./crawl");
    const pass = await crawlCatalogue({ limit: 0, maxHop: 2 });
    expect(pass.artistsRearmed).toBe(1);

    const node = await db.execute(
      `select attempted_at, cursor, failures, hop, label_slug, parent_id, state
       from crawl_frontier where id = 'musicbrainz:artist:artist-failed-allow'`,
    );
    expect(node.rows[0]?.state).toBe("failed");
    expect(Number(node.rows[0]?.cursor)).toBe(0);
    expect(Number(node.rows[0]?.failures)).toBe(2);
    expect(Number(node.rows[0]?.hop)).toBe(0);
    expect(node.rows[0]?.attempted_at).toBe(NOW);
    expect(node.rows[0]?.label_slug).toBeNull();
    expect(node.rows[0]?.parent_id).toBeNull();
  });

  it("an allowed artist's node is minted at hop 0 and its billed releases store from a disabled label", async () => {
    await db.execute("update labels set seed_state = 'disabled'");
    await seedLabel("Allowed Label", "allowed-label", "disabled");
    await db.execute(
      "update labels set mb_label_id = 'label-allowed' where id = 'lbl_allowed-label'",
    );
    await seedArtistRule({ artistMbid: "artist-allowed", verdict: "allow" });

    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const json = (body: unknown) =>
          Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

        if (url.includes("/release?artist=artist-allowed")) {
          return json({ "release-count": 1, releases: [{ id: "release-allowed-backcat" }] });
        }
        if (url.includes("/release/release-allowed-backcat")) {
          return json(
            ruleTestRelease({
              id: "release-allowed-backcat",
              labelMbid: "label-allowed",
              labelName: "Allowed Label",
              tracks: [
                {
                  credits: [{ id: "artist-allowed", name: "Allowed Artist" }],
                  id: "rec-allowed-backcat",
                  title: "Allowed back catalogue",
                },
              ],
            }),
          );
        }

        return json({});
      }),
    );

    const { crawlCatalogue } = await import("./crawl");
    const browse = await crawlCatalogue({ limit: 1, maxHop: 2 });
    expect(browse.artistsRearmed).toBe(1);

    const artistNode = await db.execute(
      "select hop from crawl_frontier where id = 'musicbrainz:artist:artist-allowed'",
    );
    expect(Number(artistNode.rows[0]?.hop)).toBe(0);

    const release = await crawlCatalogue({ limit: 1, maxHop: 2 });
    expect(release.tracksAllowedIn).toBe(1);
    expect(release.tracksWritten).toBe(1);
  });

  it("a second allowed-artist re-arm pass is a no-op", async () => {
    await db.execute("update labels set seed_state = 'disabled'");
    await seedArtistRule({ artistMbid: "artist-allowed", verdict: "allow" });

    const { crawlCatalogue } = await import("./crawl");
    expect((await crawlCatalogue({ limit: 0 })).artistsRearmed).toBe(1);
    expect((await crawlCatalogue({ limit: 0 })).artistsRearmed).toBe(0);

    const stamped = await db.execute(
      "select rearmed_at from artist_rules where artist_mbid = 'artist-allowed'",
    );
    expect(stamped.rows[0]?.rearmed_at).not.toBeNull();
  });

  it("an owed forward allow replay cannot be consumed by the daily batch", async () => {
    const before = "2026-07-01T00:00:00.000Z";
    await db.execute("update labels set seed_state = 'disabled'");

    for (let index = 0; index <= 10; index += 1) {
      const artistMbid = `artist-batch-${String(index).padStart(2, "0")}`;
      await seedArtistRule({ artistMbid, verdict: "allow" });
      await seedFrontierNode({
        createdAt: before,
        externalId: artistMbid,
        hop: 0,
        id: `musicbrainz:artist:${artistMbid}`,
        kind: "artist",
        labelSlug: null,
        state: "done",
      });
    }
    await db.execute({
      args: [before],
      sql: "update crawl_frontier set done_at = ? where state = 'done'",
    });

    const { crawlCatalogue } = await import("./crawl");
    const first = await crawlCatalogue({ limit: 0, maxHop: 2 });
    expect(first.artistsRearmed).toBe(10);

    const overflow = await db.execute(
      `select node.state, rules.rearmed_at
       from crawl_frontier as node
       join artist_rules as rules on rules.artist_mbid = node.external_id
       where node.id = 'musicbrainz:artist:artist-batch-10'`,
    );
    expect(overflow.rows[0]?.state).toBe("done");
    expect(overflow.rows[0]?.rearmed_at).toBeNull();

    const second = await crawlCatalogue({ limit: 0, maxHop: 2 });
    expect(second.artistsRearmed).toBe(1);
    const rearmed = await db.execute(
      "select state from crawl_frontier where id = 'musicbrainz:artist:artist-batch-10'",
    );
    expect(rearmed.rows[0]?.state).toBe("pending");
  });

  it("daily allowed-artist re-arm reads tail-first and only mints new releases", async () => {
    const before = "2026-07-01T00:00:00.000Z";
    await db.execute("update labels set seed_state = 'disabled'");
    await seedArtistRule({
      artistMbid: "artist-daily",
      rearmedAt: NOW,
      verdict: "allow",
    });
    await seedFrontierNode({
      createdAt: before,
      externalId: "artist-daily",
      hop: 0,
      id: "musicbrainz:artist:artist-daily",
      kind: "artist",
      labelSlug: null,
      state: "done",
    });
    await seedFrontierNode({
      createdAt: before,
      externalId: "release-daily-known",
      hop: 1,
      id: "musicbrainz:release:release-daily-known",
      kind: "release",
      labelSlug: null,
      state: "done",
    });
    await db.execute({
      args: [before],
      sql: "update crawl_frontier set done_at = ? where state = 'done'",
    });
    const browseUrls: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        browseUrls.push(url);
        const parsed = new URL(url);
        const offset = Number(parsed.searchParams.get("offset") ?? "0");
        const limit = Number(parsed.searchParams.get("limit") ?? "100");
        const releases = [{ id: "release-daily-known" }, { id: "release-daily-new" }];
        return Promise.resolve(
          new Response(
            JSON.stringify({
              "release-count": releases.length,
              releases: releases.slice(offset, offset + limit),
            }),
            { status: 200 },
          ),
        );
      }),
    );

    const { crawlCatalogue } = await import("./crawl");
    const pass = await crawlCatalogue({ limit: 1, maxHop: 2 });

    expect(pass.artistsRearmed).toBe(1);
    expect(browseUrls).toHaveLength(2);
    expect(new URL(browseUrls[0] ?? "http://invalid").searchParams.get("limit")).toBe("1");
    const releases = await db.execute(
      "select external_id, state from crawl_frontier where kind = 'release' order by external_id",
    );
    expect(releases.rows.map((row) => `${text(row.external_id)}:${text(row.state)}`)).toEqual([
      "release-daily-known:done",
      "release-daily-new:pending",
    ]);
  });

  it("an allowed-artist forward watermark revives DONE releases once and then terminates", async () => {
    const before = "2026-07-01T00:00:00.000Z";
    await db.execute("update labels set seed_state = 'disabled'");
    await seedArtistRule({ artistMbid: "artist-watermark", verdict: "allow" });
    await seedFrontierNode({
      createdAt: before,
      externalId: "artist-watermark",
      hop: 2,
      id: "musicbrainz:artist:artist-watermark",
      kind: "artist",
      labelSlug: "old-provenance",
      state: "done",
    });
    await seedFrontierNode({
      createdAt: before,
      externalId: "release-watermark",
      hop: 2,
      id: "musicbrainz:release:release-watermark",
      kind: "release",
      labelSlug: "old-provenance",
      state: "done",
    });
    await db.execute({
      args: [before],
      sql: "update crawl_frontier set done_at = ? where state = 'done'",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              "release-count": 1,
              releases: [{ id: "release-watermark" }],
            }),
            { status: 200 },
          ),
        ),
      ),
    );

    const { crawlCatalogue } = await import("./crawl");
    const replay = await crawlCatalogue({ limit: 1, maxHop: 2 });
    expect(replay.artistsRearmed).toBe(1);
    expect(replay.nodesEnqueued).toBe(1);

    const revived = await db.execute(
      `select hop, parent_id, state from crawl_frontier
       where id = 'musicbrainz:release:release-watermark'`,
    );
    expect(revived.rows[0]?.state).toBe("pending");
    expect(Number(revived.rows[0]?.hop)).toBe(0);
    expect(revived.rows[0]?.parent_id).toBe("musicbrainz:artist:artist-watermark");

    const second = await crawlCatalogue({ limit: 0, maxHop: 2 });
    expect(second.artistsRearmed).toBe(0);
    const artist = await db.execute(
      "select done_at, state from crawl_frontier where id = 'musicbrainz:artist:artist-watermark'",
    );
    expect(artist.rows[0]?.state).toBe("done");
    expect(artist.rows[0]?.done_at).not.toBe(before);
  });

  it("an allowed-artist replay promotes a skipped terminal release to hop zero", async () => {
    const before = "2026-07-01T00:00:00.000Z";
    await seedArtistRule({
      artistMbid: "artist-skipped-replay",
      labelId: "lbl_medschool",
      verdict: "allow",
    });
    await seedFrontierNode({
      createdAt: before,
      externalId: "artist-skipped-replay",
      hop: 2,
      id: "musicbrainz:artist:artist-skipped-replay",
      kind: "artist",
      labelSlug: "medschool",
      state: "done",
    });
    await db.execute({
      args: [before],
      sql: `update crawl_frontier set done_at = ?
        where id = 'musicbrainz:artist:artist-skipped-replay'`,
    });
    await seedFrontierNode({
      createdAt: before,
      externalId: "release-skipped-replay",
      hop: 2,
      id: "musicbrainz:release:release-skipped-replay",
      kind: "release",
      labelSlug: "medschool",
      state: "skipped",
    });
    await db.execute(`update crawl_frontier
      set release_label_slug = 'anjunabeats', note = 'disabled own label at terminal hop'
      where id = 'musicbrainz:release:release-skipped-replay'`);
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              "release-count": 1,
              releases: [{ id: "release-skipped-replay" }],
            }),
            { status: 200 },
          ),
        ),
      ),
    );

    const { crawlCatalogue } = await import("./crawl");
    const replay = await crawlCatalogue({ limit: 1, maxHop: 2 });
    expect(replay.artistsRearmed).toBe(1);
    expect(replay.nodesEnqueued).toBe(1);
    const revived = await db.execute(`select hop, note, parent_id, state from crawl_frontier
      where id = 'musicbrainz:release:release-skipped-replay'`);
    expect(revived.rows[0]).toMatchObject({
      hop: 0,
      note: null,
      parent_id: "musicbrainz:artist:artist-skipped-replay",
      state: "pending",
    });
  });

  it("an allow-artist browse promotes an already-pending release into storable provenance", async () => {
    await db.execute("update labels set seed_state = 'disabled'");
    await db.execute("update labels set seed_state = 'enabled' where slug = 'medschool'");
    await seedArtistRule({
      artistMbid: "artist-promote",
      rearmedAt: NOW,
      verdict: "allow",
    });
    await seedFrontierNode({
      createdAt: NOW,
      externalId: "artist-promote",
      hop: 0,
      id: "musicbrainz:artist:artist-promote",
      kind: "artist",
      labelSlug: null,
    });
    await seedFrontierNode({
      createdAt: "2026-07-10T00:00:00.000Z",
      externalId: "release-promote-target",
      hop: 2,
      id: "musicbrainz:release:release-promote-target",
      kind: "release",
      labelSlug: "anjunabeats",
    });
    await seedFrontierNode({
      createdAt: "2026-07-12T00:00:00.000Z",
      externalId: "release-promote-priority",
      hop: 0,
      id: "musicbrainz:release:release-promote-priority",
      kind: "release",
      labelSlug: "medschool",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const json = (body: unknown) =>
          Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

        if (url.includes("/release?artist=artist-promote")) {
          return json({ "release-count": 1, releases: [{ id: "release-promote-target" }] });
        }
        if (url.includes("/release/release-promote-priority")) {
          return json(
            ruleTestRelease({
              id: "release-promote-priority",
              labelMbid: "label-promote-priority",
              labelName: "Medschool",
              tracks: [
                {
                  credits: [{ id: "artist-priority", name: "Priority" }],
                  id: "rec-promote-priority",
                  title: "Priority release",
                },
              ],
            }),
          );
        }

        return json({});
      }),
    );

    const { crawlCatalogue } = await import("./crawl");
    await crawlCatalogue({ limit: 2, maxHop: 2 });

    const promoted = await db.execute(
      `select hop, label_slug, parent_id, state from crawl_frontier
       where id = 'musicbrainz:release:release-promote-target'`,
    );
    expect(promoted.rows[0]?.state).toBe("pending");
    expect(Number(promoted.rows[0]?.hop)).toBe(0);
    expect(promoted.rows[0]?.label_slug).toBeNull();
    expect(promoted.rows[0]?.parent_id).toBe("musicbrainz:artist:artist-promote");
  });
});

describe("an artist browse records each release's own label", () => {
  it("stamps the credited label on new and still-waiting releases, keeping the seed as provenance", async () => {
    await seedLabel("Elsewhere Records", "elsewhere-records", "disabled");
    await db.execute(
      "update labels set mb_label_id = 'label-elsewhere' where slug = 'elsewhere-records'",
    );
    await seedLabel("Home Label", "home-label", "enabled");
    await seedFrontierNode({
      createdAt: "2026-07-10T00:00:00.000Z",
      externalId: "artist-own-label",
      hop: 0,
      id: "musicbrainz:artist:artist-own-label",
      kind: "artist",
      labelSlug: "medschool",
    });

    await seedFrontierNode({
      createdAt: "2026-07-09T00:00:00.000Z",
      externalId: "release-already-queued",
      hop: 2,
      id: "musicbrainz:release:release-already-queued",
      kind: "release",
      labelSlug: "medschool",
      state: "failed",
    });

    const browseUrls: string[] = [];
    const credit = (id: string, name: string) => [{ label: { id, name } }];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const json = (body: unknown) =>
          Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

        if (url.includes("/release?artist=artist-own-label")) {
          browseUrls.push(url);
          return json({
            "release-count": 4,
            releases: [
              {
                id: "release-elsewhere",
                "label-info": credit("label-elsewhere", "Elsewhere Records"),
              },
              { id: "release-home-fold", "label-info": credit("unrecorded-mbid", "Home Label") },
              { id: "release-unknown", "label-info": credit("label-nobody", "Nobody Knows") },
              {
                id: "release-already-queued",
                "label-info": credit("label-elsewhere", "Elsewhere Records"),
              },
            ],
          });
        }

        return json({});
      }),
    );

    const { crawlCatalogue } = await import("./crawl");
    await crawlCatalogue({ limit: 4, maxHop: 2 });

    expect(browseUrls).toHaveLength(1);
    expect(new URL(browseUrls[0] ?? "").searchParams.get("inc")).toBe("labels");
    const releases = await db.execute(
      `select external_id, label_slug, release_label_slug from crawl_frontier
       where kind = 'release' order by external_id`,
    );
    expect(releases.rows.map((row) => ({ ...row }))).toEqual([
      {
        external_id: "release-already-queued",
        label_slug: "medschool",
        release_label_slug: "elsewhere-records",
      },
      {
        external_id: "release-elsewhere",
        label_slug: "medschool",
        release_label_slug: "elsewhere-records",
      },
      {
        external_id: "release-home-fold",
        label_slug: "medschool",
        release_label_slug: "home-label",
      },
      { external_id: "release-unknown", label_slug: "medschool", release_label_slug: null },
    ]);
  });
});

describe("the scoped label re-arm — a widened ruling replays refused releases", () => {
  const SCOPED_LABEL_MBID = "label-scope-rearm";
  const SCOPED_LABEL_NAME = "Scope Re-arm Records";
  const SCOPED_LABEL_SLUG = "scope-re-arm-records";
  const SCOPED_RELEASE = "release-scope-rearm";
  const SCOPED_RELEASE_NODE = `musicbrainz:release:${SCOPED_RELEASE}`;
  const SCOPED_LABEL_NODE = `musicbrainz:label:${SCOPED_LABEL_MBID}`;
  const BEFORE_SCOPE = "2026-07-01T00:00:00.000Z";

  function scopedRelease(id = SCOPED_RELEASE): ReturnType<typeof release> {
    return {
      ...release(id, SCOPED_LABEL_NAME, `rg-${id}`, [
        { id: `recording-${id}`, title: `Track from ${id}` },
      ]),
      "label-info": [{ label: { id: SCOPED_LABEL_MBID, name: SCOPED_LABEL_NAME } }],
    };
  }

  function stubScopedLabel(releases: { id: string; status?: string }[]): void {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const json = (body: unknown) =>
          Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

        if (url.includes(`/release?label=${SCOPED_LABEL_MBID}`)) {
          return json({ "release-count": releases.length, releases });
        }

        const detail = url.match(/\/release\/([^?]+)/);

        return detail ? json(scopedRelease(detail[1] ?? SCOPED_RELEASE)) : json({});
      }),
    );
  }

  async function prepareRefusedRelease(): Promise<void> {
    const { crawlCatalogue } = await import("./crawl");

    await db.execute("update labels set seed_state = 'disabled'");
    await seedLabel(SCOPED_LABEL_NAME, SCOPED_LABEL_SLUG, "undecided");
    await seedFrontierNode({
      createdAt: BEFORE_SCOPE,
      externalId: SCOPED_LABEL_MBID,
      hop: 0,
      id: SCOPED_LABEL_NODE,
      kind: "label",
      labelSlug: SCOPED_LABEL_SLUG,
    });
    stubScopedLabel([{ id: SCOPED_RELEASE }]);

    await crawlCatalogue({ limit: 1, maxHop: 0 });
    await crawlCatalogue({ limit: 1, maxHop: 0 });

    const refused = await db.execute({
      args: [SCOPED_RELEASE_NODE],
      sql: "select state from crawl_frontier where id = ?",
    });
    expect(refused.rows[0]?.state).toBe("done");
    const tracks = await db.execute("select count(*) as n from tracks");
    expect(Number(tracks.rows[0]?.n)).toBe(0);

    await db.execute({
      args: [BEFORE_SCOPE, SCOPED_LABEL_NODE, SCOPED_RELEASE_NODE],
      sql: `update crawl_frontier set done_at = ? where id in (?, ?)`,
    });
  }

  async function enableScopedLabel(): Promise<void> {
    const { updateLabelSeedState } = await import("./labels");
    await updateLabelSeedState(`lbl_${SCOPED_LABEL_SLUG}`, "enabled");
  }

  it("stores a previously gate-refused release once its label is ENABLED — the back-catalogue re-arm", async () => {
    const { crawlCatalogue } = await import("./crawl");
    await prepareRefusedRelease();
    await enableScopedLabel();

    const rearm = await crawlCatalogue({ limit: 1, maxHop: 0 });
    expect(rearm.releasesRearmed).toBe(1);
    expect(rearm.nodesEnqueued).toBe(1);

    const revival = await db.execute({
      args: [SCOPED_RELEASE_NODE],
      sql: "select hop, label_slug, state from crawl_frontier where id = ?",
    });
    expect(revival.rows[0]?.state).toBe("pending");
    expect(Number(revival.rows[0]?.hop)).toBe(0);
    expect(revival.rows[0]?.label_slug).toBe(SCOPED_LABEL_SLUG);

    const stored = await crawlCatalogue({ limit: 1, maxHop: 0 });
    expect(stored.tracksWritten).toBe(1);
    const tracks = await db.execute("select title from tracks");
    expect(tracks.rows.map((row) => text(row.title))).toEqual([`Track from ${SCOPED_RELEASE}`]);
  });

  it("an already-stored ISRC-less row's anchor stamp SURVIVES the label-scope re-arm", async () => {
    const { crawlCatalogue } = await import("./crawl");
    await prepareRefusedRelease();

    await db.execute(
      `insert into tracks (track_id, title, artists_json, duration_ms, isrc, has_isrc,
         spotify_anchor_attempted_at, spotify_anchor_attempts)
       values ('mb_recording-${SCOPED_RELEASE}', 'Track from ${SCOPED_RELEASE}', '["Test Artist"]',
         270000, null, 0, '2026-07-26T12:00:00.000Z', 2)`,
    );
    await enableScopedLabel();

    const rearm = await crawlCatalogue({ limit: 1, maxHop: 0 });
    expect(rearm.releasesRearmed).toBe(1);

    await crawlCatalogue({ limit: 1, maxHop: 0 });
    const settled = await db.execute({
      args: [SCOPED_RELEASE_NODE],
      sql: "select state from crawl_frontier where id = ?",
    });
    expect(settled.rows[0]?.state).toBe("done");

    const row = await db.execute(
      `select spotify_anchor_attempted_at as at, spotify_anchor_attempts as n, has_isrc
       from tracks where track_id = 'mb_recording-${SCOPED_RELEASE}'`,
    );
    expect(row.rows[0]?.at).toBe("2026-07-26T12:00:00.000Z");
    expect(Number(row.rows[0]?.n)).toBe(2);
    expect(Number(row.rows[0]?.has_isrc)).toBe(0);
  });

  it("a second re-arm pass is a no-op — the watermark terminates it", async () => {
    const { crawlCatalogue } = await import("./crawl");
    await prepareRefusedRelease();
    await enableScopedLabel();

    expect((await crawlCatalogue({ limit: 1, maxHop: 0 })).releasesRearmed).toBe(1);
    await crawlCatalogue({ limit: 1, maxHop: 0 });

    const second = await crawlCatalogue({ limit: 0, maxHop: 0 });
    expect(second.releasesRearmed).toBe(0);
    expect(second.expanded).toBe(0);
  });

  it("the re-arm resets hop and label_slug so revived nodes are picked", async () => {
    const { crawlCatalogue } = await import("./crawl");
    await prepareRefusedRelease();
    await db.execute({
      args: [SCOPED_RELEASE_NODE],
      sql: `update crawl_frontier set hop = 2, label_slug = 'old-disabled-provenance' where id = ?`,
    });
    await enableScopedLabel();

    await crawlCatalogue({ limit: 1, maxHop: 0 });
    const revived = await db.execute({
      args: [SCOPED_RELEASE_NODE],
      sql: "select hop, label_slug, state from crawl_frontier where id = ?",
    });
    expect(Number(revived.rows[0]?.hop)).toBe(0);
    expect(revived.rows[0]?.label_slug).toBe(SCOPED_LABEL_SLUG);
    expect(revived.rows[0]?.state).toBe("pending");

    const picked = await crawlCatalogue({ limit: 1, maxHop: 0 });
    expect(picked.tracksWritten).toBe(1);
    const settled = await db.execute({
      args: [SCOPED_RELEASE_NODE],
      sql: "select state from crawl_frontier where id = ?",
    });
    expect(settled.rows[0]?.state).toBe("done");
  });

  it("the re-arm skips Bootleg and keeps status-absent releases", async () => {
    const { crawlCatalogue } = await import("./crawl");
    const releases = Array.from({ length: 101 }, (_, index) => ({
      id: `scoped-status-${String(index).padStart(3, "0")}`,
      ...(index === 0
        ? { status: "Bootleg" }
        : index === 1
          ? { status: "Pseudo-Release" }
          : index === 2 || index === 100
            ? {}
            : { status: "Official" }),
    }));
    const browseOffsets: number[] = [];
    const browseUrls: string[] = [];

    await db.execute("update labels set seed_state = 'disabled'");
    await seedLabel(SCOPED_LABEL_NAME, SCOPED_LABEL_SLUG, "undecided");
    await seedFrontierNode({
      createdAt: BEFORE_SCOPE,
      externalId: SCOPED_LABEL_MBID,
      hop: 0,
      id: SCOPED_LABEL_NODE,
      kind: "label",
      labelSlug: SCOPED_LABEL_SLUG,
      state: "done",
    });

    for (const item of releases) {
      await seedFrontierNode({
        createdAt: BEFORE_SCOPE,
        externalId: item.id,
        hop: 2,
        id: `musicbrainz:release:${item.id}`,
        kind: "release",
        labelSlug: "old-disabled-provenance",
        state: "done",
      });
    }
    await db.execute({
      args: [BEFORE_SCOPE],
      sql: "update crawl_frontier set done_at = ? where state = 'done'",
    });
    await enableScopedLabel();

    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const json = (body: unknown) =>
          Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

        if (url.includes(`/release?label=${SCOPED_LABEL_MBID}`)) {
          const parsed = new URL(url);
          const offset = Number(parsed.searchParams.get("offset") ?? "0");
          const limit = Number(parsed.searchParams.get("limit") ?? "100");
          browseOffsets.push(offset);
          browseUrls.push(url);
          return json({
            "release-count": releases.length,
            releases: releases.slice(offset, offset + limit),
          });
        }

        return json({});
      }),
    );

    const firstPage = await crawlCatalogue({ limit: 1, maxHop: 0 });
    expect(firstPage.releasesRearmed).toBe(1);
    expect(firstPage.nodesEnqueued).toBe(98);

    const afterFirstPage = await db.execute({
      args: [
        "musicbrainz:release:scoped-status-000",
        "musicbrainz:release:scoped-status-001",
        "musicbrainz:release:scoped-status-002",
      ],
      sql: `select id, state from crawl_frontier where id in (?, ?, ?) order by id`,
    });
    expect(afterFirstPage.rows.map((row) => `${text(row.id)}:${text(row.state)}`)).toEqual([
      "musicbrainz:release:scoped-status-000:done",
      "musicbrainz:release:scoped-status-001:done",
      "musicbrainz:release:scoped-status-002:pending",
    ]);

    const paginating = await db.execute({
      args: [SCOPED_LABEL_NODE],
      sql: "select cursor, done_at, state from crawl_frontier where id = ?",
    });
    expect(Number(paginating.rows[0]?.cursor)).toBe(100);
    expect(paginating.rows[0]?.done_at).toBe(BEFORE_SCOPE);
    expect(paginating.rows[0]?.state).toBe("pending");

    await db.execute({
      args: [BEFORE_SCOPE],
      sql: `update crawl_frontier
            set state = 'done', done_at = ?
            where kind = 'release' and state = 'pending'`,
    });

    const secondPage = await crawlCatalogue({ limit: 1, maxHop: 0 });
    expect(secondPage.nodesEnqueued).toBe(1);
    expect(browseOffsets).toEqual([0, 100]);
    expect(browseUrls.every((url) => !new URL(url).searchParams.has("status"))).toBe(true);

    const absentAtTail = await db.execute(
      "select state from crawl_frontier where id = 'musicbrainz:release:scoped-status-100'",
    );
    expect(absentAtTail.rows[0]?.state).toBe("pending");
  });
});

describe("the frontier drain — releases never starve behind a discovery wave", () => {
  it("picks enabled-provenance releases before disabled provenance at the same hop", async () => {
    const { crawlCatalogue } = await import("./crawl");

    await seedFrontierNode({
      createdAt: "2026-07-10T00:00:00.000Z",
      externalId: HOP2_RELEASE,
      hop: 2,
      id: "mb:release:disabled-provenance-first",
      kind: "release",
      labelSlug: "anjunabeats",
    });
    await seedFrontierNode({
      createdAt: "2026-07-12T00:00:00.000Z",
      externalId: SEED_RELEASE,
      hop: 2,
      id: "mb:release:enabled-provenance-second",
      kind: "release",
      labelSlug: "medschool",
    });

    await crawlCatalogue({ limit: 1, maxHop: 2 });

    const picked = await db.execute(
      `select id, state from crawl_frontier
       where id in ('mb:release:disabled-provenance-first', 'mb:release:enabled-provenance-second')
       order by id`,
    );
    expect(picked.rows.map((row) => `${text(row.id)}:${text(row.state)}`)).toEqual([
      "mb:release:disabled-provenance-first:pending",
      "mb:release:enabled-provenance-second:done",
    ]);
  });

  it("ranks an allow-artist subtree as storable release provenance", async () => {
    const { crawlCatalogue } = await import("./crawl");
    await seedArtistRule({
      artistMbid: "artist-allowed-order",
      rearmedAt: NOW,
      verdict: "allow",
    });
    await seedFrontierNode({
      createdAt: "2026-07-10T00:00:00.000Z",
      externalId: HOP2_RELEASE,
      hop: 2,
      id: "mb:release:ordinary-disabled-first",
      kind: "release",
      labelSlug: "anjunabeats",
    });
    await seedFrontierNode({
      createdAt: "2026-07-12T00:00:00.000Z",
      externalId: SEED_RELEASE,
      hop: 2,
      id: "mb:release:allowed-subtree-second",
      kind: "release",
      labelSlug: "anjunabeats",
    });
    await db.execute(
      `update crawl_frontier
       set parent_id = 'musicbrainz:artist:artist-allowed-order'
       where id = 'mb:release:allowed-subtree-second'`,
    );

    await crawlCatalogue({ limit: 1, maxHop: 2 });

    const picked = await db.execute(
      `select id, state from crawl_frontier
       where id in ('mb:release:ordinary-disabled-first', 'mb:release:allowed-subtree-second')
       order by id`,
    );
    expect(picked.rows.map((row) => `${text(row.id)}:${text(row.state)}`)).toEqual([
      "mb:release:allowed-subtree-second:done",
      "mb:release:ordinary-disabled-first:pending",
    ]);
  });

  it("still picks a disabled-provenance release when no storable release is pending", async () => {
    const { crawlCatalogue } = await import("./crawl");

    await seedFrontierNode({
      createdAt: "2026-07-10T00:00:00.000Z",
      externalId: HOP2_RELEASE,
      hop: 2,
      id: "mb:release:disabled-provenance-only",
      kind: "release",
      labelSlug: "anjunabeats",
    });

    await crawlCatalogue({ limit: 1, maxHop: 2 });

    const picked = await db.execute(
      "select state from crawl_frontier where id = 'mb:release:disabled-provenance-only'",
    );
    expect(picked.rows[0]?.state).toBe("done");
  });

  it.each([
    { labelSlug: null, provenance: "NULL provenance" },
    { labelSlug: "missing-label", provenance: "provenance with no labels row" },
  ])("orders $provenance last without pruning it", async ({ labelSlug }) => {
    const { crawlCatalogue } = await import("./crawl");
    const nonStorableId = `mb:release:${labelSlug ?? "null"}-provenance`;

    await seedFrontierNode({
      createdAt: "2026-07-10T00:00:00.000Z",
      externalId: HOP2_RELEASE,
      hop: 2,
      id: nonStorableId,
      kind: "release",
      labelSlug,
    });
    await seedFrontierNode({
      createdAt: "2026-07-12T00:00:00.000Z",
      externalId: SEED_RELEASE,
      hop: 2,
      id: "mb:release:enabled-before-unruled-provenance",
      kind: "release",
      labelSlug: "medschool",
    });

    await crawlCatalogue({ limit: 1, maxHop: 2 });

    const deferred = await db.execute({
      args: [nonStorableId],
      sql: "select state from crawl_frontier where id = ?",
    });
    expect(deferred.rows[0]?.state).toBe("pending");

    await crawlCatalogue({ limit: 1, maxHop: 2 });

    const eventuallyPicked = await db.execute({
      args: [nonStorableId],
      sql: "select state from crawl_frontier where id = ?",
    });
    expect(eventuallyPicked.rows[0]?.state).toBe("done");
  });

  it("leaves the discovery half ordered independently of release provenance", async () => {
    const { crawlCatalogue } = await import("./crawl");

    await seedFrontierNode({
      createdAt: "2026-07-09T00:00:00.000Z",
      externalId: "medschool",
      hop: 0,
      id: "fluncle:label:medschool",
      kind: "label",
      labelSlug: "medschool",
      source: "fluncle",
      state: "done",
    });
    await seedFrontierNode({
      createdAt: "2026-07-10T00:00:00.000Z",
      externalId: HOP2_RELEASE,
      hop: 2,
      id: "mb:release:discovery-disabled-provenance",
      kind: "release",
      labelSlug: "anjunabeats",
    });
    await seedFrontierNode({
      createdAt: "2026-07-12T00:00:00.000Z",
      externalId: SEED_RELEASE,
      hop: 2,
      id: "mb:release:discovery-enabled-provenance",
      kind: "release",
      labelSlug: "medschool",
    });
    await seedFrontierNode({
      createdAt: "2026-07-11T00:00:00.000Z",
      externalId: OTHER_ARTIST_MBID,
      hop: 1,
      id: "mb:artist:disabled-provenance-discovery",
      kind: "artist",
      labelSlug: "anjunabeats",
    });

    await crawlCatalogue({ limit: 2, maxHop: 2 });

    const picked = await db.execute(
      `select id, state from crawl_frontier
       where id in (
         'mb:release:discovery-disabled-provenance',
         'mb:release:discovery-enabled-provenance',
         'mb:artist:disabled-provenance-discovery'
       )
       order by id`,
    );
    expect(picked.rows.map((row) => `${text(row.id)}:${text(row.state)}`)).toEqual([
      "mb:artist:disabled-provenance-discovery:done",
      "mb:release:discovery-disabled-provenance:pending",
      "mb:release:discovery-enabled-provenance:done",
    ]);
  });

  it("guarantees release nodes half the batch even when older, lower-hop artist nodes crowd the head", async () => {
    const { crawlCatalogue } = await import("./crawl");

    await db.execute("update labels set seed_state = 'disabled' where slug != 'medschool'");

    const old = new Date(Date.now() - 60_000).toISOString();
    const newer = new Date().toISOString();

    for (let i = 0; i < 6; i += 1) {
      await db.execute({
        args: [`mb:artist:starver-${i}`, `starver-${i}`, old, old],
        sql: `insert into crawl_frontier (id, kind, source, external_id, hop, parent_id, label_slug, created_at, updated_at)
              values (?, 'artist', 'musicbrainz', ?, 1, null, 'medschool', ?, ?)`,
      });
    }
    await db.execute({
      args: [`mb:release:${SEED_RELEASE}`, SEED_RELEASE, newer, newer],
      sql: `insert into crawl_frontier (id, kind, source, external_id, hop, parent_id, label_slug, created_at, updated_at)
            values (?, 'release', 'musicbrainz', ?, 2, null, 'medschool', ?, ?)`,
    });

    const pass = await crawlCatalogue({ limit: 4, maxHop: 2 });

    expect(pass.tracksWritten).toBeGreaterThan(0);

    const releaseNode = await db.execute(
      `select state from crawl_frontier where id = 'mb:release:${SEED_RELEASE}'`,
    );
    expect(releaseNode.rows[0]?.state).toBe("done");
  });
});

describe("the seed re-arm (release freshness) — an enabled label is a subscription", () => {
  const NEW_RELEASE = "release-new";

  function stubMedschool(releaseIds: string[]): void {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const json = (body: unknown) =>
          Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

        if (url.includes("/label?query=")) {
          return json({ labels: [{ id: LABEL_MBID, name: "Med School", score: 100 }] });
        }

        if (url.includes(`/release?label=${LABEL_MBID}`)) {
          return json({
            "release-count": releaseIds.length,
            releases: releaseIds.map((id) => ({ id })),
          });
        }

        if (url.includes(`/release/${SEED_RELEASE}`)) {
          return json(
            release(SEED_RELEASE, "Med School", SEED_RELEASE_GROUP, [
              { id: "rec-1", isrc: "GBCJY1300173", title: "Weightless" },
              { id: "rec-2", title: "Begin by Letting Go" },
            ]),
          );
        }

        if (url.includes(`/release/${NEW_RELEASE}`)) {
          return json(
            release(NEW_RELEASE, "Med School", "rg-new-drop", [
              { id: "rec-new", title: "Fresh Drop" },
              { id: "rec-1", isrc: "GBCJY1300173", title: "Weightless" },
            ]),
          );
        }

        return json({});
      }),
    );
  }

  async function ageSeedLabelNodes(): Promise<void> {
    const old = drainedBeforeLastPass();

    await db.execute({
      args: [old],
      sql: `update crawl_frontier set done_at = ?
            where kind = 'label' and source = 'musicbrainz' and state = 'done'`,
    });
  }

  it("re-arms a stale enabled label, discovers its NEW release, and re-walks the known one for nothing", async () => {
    const { crawlCatalogue } = await import("./crawl");

    stubMedschool([SEED_RELEASE]);
    await drain(0);
    const before = await db.execute("select track_id from tracks");
    expect(before.rows.map((row) => text(row.track_id)).sort(compare)).toEqual([
      "mb_rec-1",
      "mb_rec-2",
    ]);

    stubMedschool([SEED_RELEASE, NEW_RELEASE]);
    await ageSeedLabelNodes();

    const rearmPass = await crawlCatalogue({ limit: 10, maxHop: 0 });
    expect(rearmPass.seedsRearmed).toBe(1);

    await drain(0);

    const after = await db.execute("select track_id from tracks");

    expect(after.rows.map((row) => text(row.track_id)).sort(compare)).toEqual([
      "mb_rec-1",
      "mb_rec-2",
      "mb_rec-new",
    ]);

    const findings = await db.execute("select count(*) as n from findings");
    expect(Number(findings.rows[0]?.n)).toBe(0);
  });

  it("does NOT re-arm a label drained since the last pass boundary", async () => {
    const { crawlCatalogue } = await import("./crawl");

    stubMedschool([SEED_RELEASE]);
    await drain(0);

    const pass = await crawlCatalogue({ limit: 10, maxHop: 0 });
    expect(pass.seedsRearmed).toBe(0);

    const node = await db.execute(
      "select state from crawl_frontier where kind = 'label' and source = 'musicbrainz'",
    );
    expect(node.rows[0]?.state).toBe("done");
  });

  it("never re-arms a DISABLED label's done node, nor a FAILED node", async () => {
    const { crawlCatalogue } = await import("./crawl");

    await db.execute("update labels set seed_state = 'disabled'");
    const old = drainedBeforeLastPass();

    await db.execute({
      args: ["musicbrainz:label:mb-anjuna", "mb-anjuna", old, old, old],
      sql: `insert into crawl_frontier
              (id, kind, source, external_id, hop, parent_id, label_slug, state, done_at, created_at, updated_at)
            values (?, 'label', 'musicbrainz', ?, 0, null, 'anjunabeats', 'done', ?, ?, ?)`,
    });

    await db.execute("update labels set seed_state = 'enabled' where slug = 'medschool'");
    await db.execute({
      args: ["musicbrainz:label:mb-failed", "mb-failed", old, old, old],
      sql: `insert into crawl_frontier
              (id, kind, source, external_id, hop, parent_id, label_slug, state, failures, done_at, created_at, updated_at)
            values (?, 'label', 'musicbrainz', ?, 0, null, 'medschool', 'failed', 2, ?, ?, ?)`,
    });

    const pass = await crawlCatalogue({ limit: 1, maxHop: 0 });
    expect(pass.seedsRearmed).toBe(0);

    const disabled = await db.execute(
      "select state from crawl_frontier where id = 'musicbrainz:label:mb-anjuna'",
    );
    expect(disabled.rows[0]?.state).toBe("done");

    const failed = await db.execute(
      "select state from crawl_frontier where id = 'musicbrainz:label:mb-failed'",
    );
    expect(failed.rows[0]?.state).toBe("failed");
  });

  it("re-arms at most REARM_BATCH per pass (oldest-done-first), spreading a mass re-arm over ticks", async () => {
    const { REARM_BATCH, crawlCatalogue } = await import("./crawl");

    await db.execute("update labels set seed_state = 'disabled'");
    const old = drainedBeforeLastPass();
    const cohort = REARM_BATCH + 2;

    for (let i = 0; i < cohort; i += 1) {
      const slug = `cohort-${String(i).padStart(2, "0")}`;

      await seedLabel(`Cohort ${i}`, slug, "enabled");
      await db.execute({
        args: [`musicbrainz:label:mb-${slug}`, `mb-${slug}`, slug, old, old, old],
        sql: `insert into crawl_frontier
                (id, kind, source, external_id, hop, parent_id, label_slug, state, done_at, created_at, updated_at)
              values (?, 'label', 'musicbrainz', ?, 0, null, ?, 'done', ?, ?, ?)`,
      });
    }

    const first = await crawlCatalogue({ limit: 1, maxHop: 0 });
    expect(first.seedsRearmed).toBe(REARM_BATCH);

    const second = await crawlCatalogue({ limit: 1, maxHop: 0 });
    expect(second.seedsRearmed).toBe(cohort - REARM_BATCH);
  });

  it("comes due ON a pass boundary and not again until the next one", async () => {
    const { crawlCatalogue } = await import("./crawl");

    const MB_NODE = `musicbrainz:label:${LABEL_MBID}`;

    async function drainedAt(doneAt: string): Promise<void> {
      await db.execute({
        args: [doneAt, doneAt, MB_NODE],
        sql: `update crawl_frontier set state = 'done', cursor = 0, done_at = ?, updated_at = ?
              where id = ?`,
      });
    }

    async function passAt(instant: string): Promise<number> {
      setSeedRearmClockForTests(new Date(instant));
      return (await crawlCatalogue({ limit: 1, maxHop: 0 })).seedsRearmed;
    }

    try {
      stubMedschool([SEED_RELEASE]);
      await drain(0);

      await drainedAt("2026-09-17T09:00:00.000Z");
      expect(await passAt("2026-09-18T11:59:00.000Z")).toBe(0);

      await drainedAt("2026-09-17T09:00:00.000Z");
      expect(await passAt("2026-09-18T12:00:00.000Z")).toBe(1);

      for (const instant of [
        "2026-09-18T12:05:01.000Z",
        "2026-09-18T23:59:59.000Z",
        "2026-09-19T15:00:00.000Z",
        "2026-09-19T23:59:59.999Z",
      ]) {
        await drainedAt("2026-09-18T12:05:00.000Z");
        expect(await passAt(instant)).toBe(0);
      }

      await drainedAt("2026-09-18T12:05:00.000Z");
      expect(await passAt("2026-09-20T00:00:00.000Z")).toBe(1);
    } finally {
      setSeedRearmClockForTests(null);
    }
  });
});

describe("the namesake seal — the ruled mb_label_id is the resolver's authority", () => {
  const RIGHT_MBID = "label-radar-dnb";
  const WRONG_MBID = "label-radar-punk";

  function stubNamesakes(candidates: { id: string; name: string; score: number }[]): {
    searchCalls: () => number;
  } {
    let searches = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const json = (body: unknown) =>
          Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

        if (url.includes("/label?query=")) {
          searches += 1;

          return json({ labels: candidates });
        }

        if (url.includes("/release?label=")) {
          return json({ "release-count": 0, releases: [] });
        }

        return json({});
      }),
    );

    return { searchCalls: () => searches };
  }

  async function seedRadar(mbLabelId: null | string): Promise<void> {
    await db.execute("update labels set seed_state = 'disabled'");
    await seedLabel("Radar Records", "radar-records", "enabled");

    if (mbLabelId) {
      await db.execute({
        args: [mbLabelId],
        sql: `update labels set mb_label_id = ? where slug = 'radar-records'`,
      });
    }
  }

  it("enqueues the RULED mbid and never asks MusicBrainz to guess from the name", async () => {
    const mb = stubNamesakes([
      { id: WRONG_MBID, name: "Radar Records", score: 100 },
      { id: RIGHT_MBID, name: "Radar Records", score: 85 },
    ]);

    await seedRadar(RIGHT_MBID);
    await drain(0);

    expect(mb.searchCalls()).toBe(0);

    const nodes = await db.execute(
      "select external_id from crawl_frontier where kind = 'label' and source = 'musicbrainz'",
    );
    expect(nodes.rows.map((row) => text(row.external_id))).toEqual([RIGHT_MBID]);

    const seed = await db.execute(
      "select state, note from crawl_frontier where id = 'fluncle:label:radar-records'",
    );
    expect(seed.rows[0]?.state).toBe("done");
    expect(seed.rows[0]?.note).toBeNull();
  });

  it("SKIPS an ambiguous name instead of picking one — the mbids ride the note for a human", async () => {
    const mb = stubNamesakes([
      { id: WRONG_MBID, name: "Radar Records", score: 100 },
      { id: RIGHT_MBID, name: "Radar Records", score: 85 },
    ]);

    await seedRadar(null);
    await drain(0);

    expect(mb.searchCalls()).toBe(1);

    const seed = await db.execute(
      "select state, note from crawl_frontier where id = 'fluncle:label:radar-records'",
    );
    expect(seed.rows[0]?.state).toBe("skipped");

    expect(text(seed.rows[0]?.note)).toContain(WRONG_MBID);
    expect(text(seed.rows[0]?.note)).toContain(RIGHT_MBID);

    const nodes = await db.execute(
      "select count(*) as n from crawl_frontier where source = 'musicbrainz'",
    );
    expect(Number(nodes.rows[0]?.n)).toBe(0);

    const label = await db.execute("select mb_label_id from labels where slug = 'radar-records'");
    expect(label.rows[0]?.mb_label_id).toBeNull();
  });

  it("still resolves a SINGLE exact match by name, and persists it as the ruling", async () => {
    const mb = stubNamesakes([
      { id: RIGHT_MBID, name: "Radar Records", score: 100 },
      { id: "label-radar-other", name: "Radar", score: 70 },
    ]);

    await seedRadar(null);
    await drain(0);

    expect(mb.searchCalls()).toBe(1);

    const nodes = await db.execute(
      "select external_id from crawl_frontier where kind = 'label' and source = 'musicbrainz'",
    );
    expect(nodes.rows.map((row) => text(row.external_id))).toEqual([RIGHT_MBID]);

    const label = await db.execute("select mb_label_id from labels where slug = 'radar-records'");
    expect(label.rows[0]?.mb_label_id).toBe(RIGHT_MBID);
  });

  it("re-arms a node that IS the ruled identity, never a namesake node wearing the right slug", async () => {
    const { crawlCatalogue } = await import("./crawl");
    await db.execute("update labels set seed_state = 'disabled'");

    const old = drainedBeforeLastPass();

    const plantNode = async (slug: string, mbid: string): Promise<void> => {
      await db.execute({
        args: [`musicbrainz:label:${mbid}`, mbid, slug, old, old, old],
        sql: `insert into crawl_frontier
                (id, kind, source, external_id, hop, parent_id, label_slug, state, done_at, created_at, updated_at)
              values (?, 'label', 'musicbrainz', ?, 0, null, ?, 'done', ?, ?, ?)`,
      });
    };

    const plantLabel = async (slug: string, mbLabelId: null | string): Promise<void> => {
      await seedLabel(slug, slug, "enabled");

      if (mbLabelId) {
        await db.execute({
          args: [mbLabelId, slug],
          sql: `update labels set mb_label_id = ? where slug = ?`,
        });
      }
    };

    await plantLabel("ruled-match", "mb-ruled-match");
    await plantNode("ruled-match", "mb-ruled-match");

    await plantLabel("ruled-namesake", "mb-the-real-one");
    await plantNode("ruled-namesake", "mb-the-namesake");

    await plantLabel("unruled", null);
    await plantNode("unruled", "mb-unruled");

    const pass = await crawlCatalogue({ limit: 0, maxHop: 0 });
    expect(pass.seedsRearmed).toBe(2);
    expect(pass.expanded).toBe(0);

    const states = await db.execute(
      "select external_id, state from crawl_frontier where source = 'musicbrainz'",
    );
    const byMbid = new Map(states.rows.map((row) => [text(row.external_id), text(row.state)]));
    expect(byMbid.get("mb-ruled-match")).toBe("pending");
    expect(byMbid.get("mb-the-namesake")).toBe("done");
    expect(byMbid.get("mb-unruled")).toBe("pending");
  });
});

async function seedAlbumRow(id: string, name: string, slug: string): Promise<void> {
  await db.execute({
    args: [id, name, slug, NOW, NOW],
    sql: `insert into albums (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
  });
}

async function seedTapRow(row: {
  albumId: string;
  isrc: null | string;
  title: string;
  trackId: string;
}): Promise<void> {
  await db.execute({
    args: [row.trackId, row.title, JSON.stringify(["Etherwood"]), 261901, row.isrc, row.albumId],
    sql: `insert into tracks (track_id, title, artists_json, duration_ms, isrc, album_id)
          values (?, ?, ?, ?, ?, ?)`,
  });
}

describe("the crawl converges onto a tap-first row instead of minting a twin", () => {
  it("folds a later MB walk to a skip when the ISRC matches (no mb_ twin)", async () => {
    await seedAlbumRow("alb_seed", "Med School sampler", "med-school-sampler");

    await seedTapRow({
      albumId: "alb_seed",
      isrc: "GBCJY1300173",
      title: "Weightless",
      trackId: "sp_weightless",
    });

    await drain();

    const weightless = await db.execute(
      "select track_id from tracks where title = 'Weightless' order by track_id",
    );
    expect(weightless.rows.map((row) => text(row.track_id))).toEqual(["sp_weightless"]);

    const all = await db.execute("select count(*) as n from tracks");
    expect(Number(all.rows[0]?.n)).toBe(2);
  });

  it("folds a later MB walk to a skip via same-album title fold when the ISRC is missing/divergent", async () => {
    await seedAlbumRow("alb_seed", "Med School sampler", "med-school-sampler");

    await seedTapRow({
      albumId: "alb_seed",
      isrc: "XXDIVERGENT01",
      title: "Weightless",
      trackId: "sp_weightless",
    });

    await seedTapRow({
      albumId: "alb_seed",
      isrc: null,
      title: "Begin by Letting Go",
      trackId: "sp_begin",
    });

    await drain();

    const twins = await db.execute(
      "select track_id from tracks where track_id like 'mb\\_rec-1' escape '\\' or track_id like 'mb\\_rec-2' escape '\\'",
    );
    expect(twins.rows).toHaveLength(0);

    const hop2 = await db.execute("select track_id from tracks where title = 'A Hop-2 Track'");
    expect(hop2.rows).toHaveLength(0);
  });

  it("does NOT merge a same-titled track on a DIFFERENT album (the fold is album-scoped)", async () => {
    await seedAlbumRow("alb_other", "Some Other Record", "some-other-record");
    await seedTapRow({
      albumId: "alb_other",
      isrc: null,
      title: "Weightless",
      trackId: "sp_unrelated",
    });

    await drain();

    const weightless = await db.execute(
      "select track_id from tracks where title = 'Weightless' order by track_id",
    );

    expect(weightless.rows.map((row) => text(row.track_id))).toEqual(["mb_rec-1", "sp_unrelated"]);
  });
});

describe("the tail-first re-arm — a subscription reads only the NEW end of the list", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MB_LABEL_NODE = `musicbrainz:label:${LABEL_MBID}`;
  const AGED = new Date(Date.now() - 5 * DAY_MS).toISOString();

  const releaseId = (index: number): string => `r${String(index).padStart(3, "0")}`;

  function recordBrowseOffsets(): string[] {
    return browseOffsets;
  }
  let browseOffsets: string[] = [];

  function stubPaginated(list: (limit: number) => { count: number; ids: string[] }): void {
    browseOffsets = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const json = (body: unknown) =>
          Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

        if (url.includes("/label?query=")) {
          return json({ labels: [{ id: LABEL_MBID, name: "Med School", score: 100 }] });
        }

        if (url.includes(`/release?label=${LABEL_MBID}`)) {
          const params = new URL(url).searchParams;
          const offset = Number(params.get("offset") ?? "0");
          const limit = Number(params.get("limit") ?? "100");
          browseOffsets.push(`${offset}:${limit}`);
          const { count, ids } = list(limit);

          return json({
            "release-count": count,
            releases: ids.slice(offset, offset + limit).map((id) => ({ id })),
          });
        }

        const detail = url.match(/\/release\/([^?]+)/);

        if (detail) {
          const id = detail[1] ?? "";

          return json(release(id, "Med School", `rg-${id}`, [{ id: `rec-${id}`, title: id }]));
        }

        return json({});
      }),
    );
  }

  async function planDrainedLabel(knownCount: number): Promise<void> {
    await db.execute({
      args: [MB_LABEL_NODE, LABEL_MBID, "medschool", AGED, AGED, AGED],
      sql: `insert into crawl_frontier
              (id, kind, source, external_id, hop, parent_id, label_slug, state, cursor, done_at, created_at, updated_at)
            values (?, 'label', 'musicbrainz', ?, 0, null, ?, 'done', 0, ?, ?, ?)`,
    });

    for (let i = 0; i < knownCount; i += 1) {
      const id = releaseId(i);
      await db.execute({
        args: [`musicbrainz:release:${id}`, id, "medschool", AGED, AGED, AGED],
        sql: `insert into crawl_frontier
                (id, kind, source, external_id, hop, parent_id, label_slug, state, cursor, done_at, created_at, updated_at)
              values (?, 'release', 'musicbrainz', ?, 2, null, ?, 'done', 0, ?, ?, ?)`,
      });
    }
  }

  it("pages the TAIL backward and EARLY-STOPS mid-list — the head pages are never re-read", async () => {
    const { crawlCatalogue } = await import("./crawl");

    const known = Array.from({ length: 250 }, (_, i) => releaseId(i));
    const fresh = [...known, "rNEW"];
    await planDrainedLabel(250);
    stubPaginated(() => ({ count: fresh.length, ids: fresh }));

    const rearm = await crawlCatalogue({ limit: 10, maxHop: 0 });
    expect(rearm.seedsRearmed).toBe(1);

    await drain(0);

    const pages = recordBrowseOffsets();
    expect(pages).toEqual(["0:1", "151:100", "51:100"]);
    expect(pages).not.toContain("0:100");

    const fresh_track = await db.execute(
      "select track_id from tracks where track_id = 'mb_rec-rNEW'",
    );
    expect(fresh_track.rows.length).toBe(1);
    const known_state = await db.execute(
      "select count(*) as n from crawl_frontier where kind = 'release' and attempts > 0",
    );

    expect(Number(known_state.rows[0]?.n)).toBe(1);
  });

  it("a label with < 100 releases has its tail at page 0 — one page, then done", async () => {
    const { crawlCatalogue } = await import("./crawl");

    const fresh = ["r000", "r001", "r002", "rNEW"];
    await planDrainedLabel(3);
    stubPaginated(() => ({ count: fresh.length, ids: fresh }));

    await crawlCatalogue({ limit: 10, maxHop: 0 });
    await drain(0);

    expect(recordBrowseOffsets()).toEqual(["0:1", "0:100"]);
    const node = await db.execute(
      `select state, cursor from crawl_frontier where id = '${MB_LABEL_NODE}'`,
    );
    expect(node.rows[0]?.state).toBe("done");
    expect(Number(node.rows[0]?.cursor)).toBe(0);

    const fresh_track = await db.execute(
      "select track_id from tracks where track_id = 'mb_rec-rNEW'",
    );
    expect(fresh_track.rows.length).toBe(1);
  });

  it("does NOT skip the newest rows when the count GREW between the probe and the tail read", async () => {
    const { crawlCatalogue } = await import("./crawl");

    const known = Array.from({ length: 150 }, (_, i) => releaseId(i));
    const grown = Array.from({ length: 155 }, (_, i) => releaseId(i));
    await planDrainedLabel(150);
    stubPaginated((limit) =>
      limit === 1 ? { count: 150, ids: known } : { count: 155, ids: grown },
    );

    await crawlCatalogue({ limit: 10, maxHop: 0 });
    await drain(0);

    const newest = await db.execute(
      "select track_id from tracks where track_id in ('mb_rec-r150','mb_rec-r151','mb_rec-r152','mb_rec-r153','mb_rec-r154') order by track_id",
    );
    expect(newest.rows.map((row) => text(row.track_id))).toEqual([
      "mb_rec-r150",
      "mb_rec-r151",
      "mb_rec-r152",
      "mb_rec-r153",
      "mb_rec-r154",
    ]);
  });

  it("a re-arm that finds NOTHING new stops in one tick — the cheap steady state", async () => {
    const { crawlCatalogue } = await import("./crawl");

    const known = Array.from({ length: 120 }, (_, i) => releaseId(i));
    await planDrainedLabel(120);
    stubPaginated(() => ({ count: known.length, ids: known }));

    await crawlCatalogue({ limit: 10, maxHop: 0 });
    await drain(0);

    expect(recordBrowseOffsets()).toEqual(["0:1", "20:100"]);
    const written = await db.execute("select count(*) as n from tracks");
    expect(Number(written.rows[0]?.n)).toBe(0);
    const node = await db.execute(`select state from crawl_frontier where id = '${MB_LABEL_NODE}'`);
    expect(node.rows[0]?.state).toBe("done");
  });

  it("a COLD (never-drained) label still full-walks FORWARD from the head", async () => {
    const { crawlCatalogue } = await import("./crawl");

    await db.execute("update labels set seed_state = 'disabled'");
    const all = Array.from({ length: 250 }, (_, i) => releaseId(i));
    stubPaginated(() => ({ count: all.length, ids: all }));
    await db.execute({
      args: [MB_LABEL_NODE, LABEL_MBID, "medschool", NOW, NOW],
      sql: `insert into crawl_frontier
              (id, kind, source, external_id, hop, parent_id, label_slug, state, cursor, created_at, updated_at)
            values (?, 'label', 'musicbrainz', ?, 0, null, ?, 'pending', 0, ?, ?)`,
    });

    await crawlCatalogue({ limit: 1, maxHop: 0 });

    expect(recordBrowseOffsets()).toEqual(["0:100"]);
    const node = await db.execute(
      `select state, cursor from crawl_frontier where id = '${MB_LABEL_NODE}'`,
    );
    expect(node.rows[0]?.state).toBe("pending");
    expect(Number(node.rows[0]?.cursor)).toBe(100);
  });

  it("keeps the allowed-artist tail on its own DAILY cadence, not the labels' schedule", async () => {
    const { ALLOWED_ARTIST_REARM_AFTER_DAYS } = await import("./crawl");
    expect(ALLOWED_ARTIST_REARM_AFTER_DAYS).toBe(1);
  });
});
