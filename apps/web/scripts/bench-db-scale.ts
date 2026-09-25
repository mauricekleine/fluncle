#!/usr/bin/env bun

import { createClient } from "@libsql/client/web";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { fileURLToPath } from "node:url";

import { ensureSearchIndex } from "../src/db/search-index";
import { compileFilters } from "../src/lib/server/search";
import { resolveScaleBenchTarget, type ScaleBenchTarget } from "./bench-db-scale-target";
import { SEED_NOW, seedScale } from "./lib/scale-seed";

function fail(message: string): never {
  console.error(`bench-db-scale: ${message}`);
  process.exit(1);
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];

  return raw ? Number.parseInt(raw, 10) : fallback;
}

function readScaleBenchTarget(): ScaleBenchTarget {
  try {
    return resolveScaleBenchTarget();
  } catch (error) {
    fail(error instanceof Error ? error.message : "scratch target confirmation failed");
  }
}

const target = readScaleBenchTarget();
const scale = envInt("BENCH_SCALE", 150_000);
const iterations = envInt("BENCH_ITERATIONS", 12);
const only = (process.env.BENCH_ONLY ?? "")
  .split(",")
  .map((piece) => Number.parseInt(piece.trim(), 10))
  .filter((value) => Number.isInteger(value));
const skipSeed = process.env.BENCH_SKIP_SEED === "1";

const client = createClient({
  authToken: target.authToken,
  concurrency: REMOTE_DB_CONCURRENCY,
  url: target.url,
});
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

const NOW_MS = Date.parse(SEED_NOW);
const DAY_MS = 24 * 60 * 60 * 1000;

const APPLE_COOLDOWN_CUTOFF = new Date(NOW_MS - 7 * DAY_MS).toISOString();

const REARM_CUTOFF = new Date(NOW_MS - 1 * DAY_MS).toISOString();

const LONG_FORM_MS = 15 * 60_000;
const WRONG_AUDIO_STATUS = "wrong-audio";
const MEGA_LABEL_ID = "label-0";

const CATALOGUE_SELECT = `ct.track_id, ct.title, ct.artists_json, ct.album_image_url, ct.spotify_url,
  ct.apple_music_url, ct.isrc, ct.preview_url, ct.bpm, ct.key, ct.label, ct.release_date,
  ct.nearest_finding_score, ct.nearest_finding_track_id, ct.capture_priority, ct.capture_status,
  ct.capture_verification, ct.catalogue_ranked_at, ct.duplicate_of_track_id, ct.dismissed_at,
  (ct.source_audio_key is not null) as has_captured_audio`;

const WORK_SELECT = `t.track_id, t.title, t.artists_json, t.isrc, t.label, t.duration_ms,
  t.source_audio_key, t.source_audio_rejected, t.capture_priority, t.bpm, t.analyzed_from, t.source_audio_failures,
  f.log_id as log_id,
  (f.track_id is not null) as certified`;

const WORK_ORDER = `order by (f.track_id is not null) desc,
  coalesce(t.capture_priority, 0) desc,
  coalesce(t.demand_score, 0) desc,
  coalesce(f.added_at, '') desc,
  t.track_id desc`;

type Query = { args: (null | number | string)[]; sql: string };

type IndexSpec = {
  ddl: string;

  baselineDdl?: string;
  expected?: "load-bearing" | "redundant";
  mode?: "create" | "drop";
  name: string;
};

type Proof = {
  after: Query[];

  baseline: Query[];

  index?: IndexSpec;
  item: number;

  rewrite: boolean;
  title: string;
};

const yearClauses = compileFilters({ yearMax: 2020, yearMin: 2015 });
const yearBaselineSql = `select count(*) as n from tracks where ${yearClauses
  .map((clause) => clause.sql)
  .join(" and ")}`;
const yearBaselineArgs = yearClauses.flatMap((clause) => clause.args);

const PROOFS: Proof[] = [
  {
    after: [{ args: [], sql: `select count(*) as n from crawl_frontier where demand_rank = 0` }],
    baseline: [
      { args: [], sql: `select count(*) as n from crawl_frontier where demand_rank <> 1` },
    ],
    index: {
      ddl: `create index if not exists crawl_frontier_demand_rank0_idx on crawl_frontier(state) where demand_rank = 0`,
      name: "crawl_frontier_demand_rank0_idx",
    },
    item: 6,
    rewrite: false,
    title: "demand clear: <>1 full-scan → =0 partial-index count",
  },
  {
    after: [
      { args: ["no-such-track"], sql: `select track_id from tracks where track_id = ? limit 1` },
      {
        args: ["0001.7.1A"],
        sql: `select track_id, log_id from findings where log_id = ? limit 1`,
      },
    ],
    baseline: [
      {
        args: ["no-such-track", "0001.7.1A"],
        sql: `select tracks.track_id, findings.log_id
              from tracks left join findings on findings.track_id = tracks.track_id
              where tracks.track_id = ? or findings.log_id = ? limit 1`,
      },
    ],
    item: 8,
    rewrite: true,
    title: "findSeedTrack: cross-table OR scan → two indexed seeks",
  },
  {
    after: [
      {
        args: [],
        sql: `select (select count(*) from tracks) - (select count(*) from findings) as n`,
      },
    ],
    baseline: [
      {
        args: [],
        sql: `select count(*) as n from tracks
              where not exists (select 1 from findings where findings.track_id = tracks.track_id)`,
      },
    ],
    item: 9,
    rewrite: true,
    title: "crawl status: anti-join count → count(tracks) − count(findings)",
  },
  {
    after: [
      {
        args: [],
        sql: `select count(*) as n from tracks
              where tracks.release_date >= '2015' and tracks.release_date < '2021'`,
      },
    ],
    baseline: [{ args: yearBaselineArgs, sql: yearBaselineSql }],
    item: 10,
    rewrite: true,
    title: "year range: substr() scan → sargable release_date range (existing idx)",
  },
  {
    after: [{ args: [MEGA_LABEL_ID], sql: labelCatalogueFoldSql() }],
    baseline: [{ args: [MEGA_LABEL_ID], sql: labelCatalogueFoldSql() }],
    index: {
      ddl: `create index if not exists artists_name_nocase_idx on artists (name collate nocase, slug)`,
      name: "artists_name_nocase_idx",
    },
    item: 11,
    rewrite: false,
    title: "label render: automatic NOCASE index → artists_name_nocase_idx (covering, +slug)",
  },
  {
    after: [{ args: [50], sql: analyzeWorklistSql() }],
    baseline: [{ args: [50], sql: analyzeWorklistSql() }],
    index: {
      ddl: `create index if not exists tracks_analyze_queue_idx on tracks(track_id)
            where source_audio_key is not null and (analyzed_at is null or analyzed_from is null or analyzed_from <> 'full')`,
      name: "tracks_analyze_queue_idx",
    },
    item: 12,
    rewrite: false,
    title: "analyze worklist: captured-row scan → tracks_analyze_queue_idx seek",
  },
  {
    after: [{ args: [APPLE_COOLDOWN_CUTOFF, 100], sql: appleWorklistSql() }],
    baseline: [{ args: [APPLE_COOLDOWN_CUTOFF, 100], sql: appleWorklistSql() }],
    index: {
      baselineDdl: `create index if not exists tracks_capture_priority_idx on tracks(capture_priority)`,
      ddl: `drop index if exists tracks_capture_priority_idx`,
      expected: "redundant",
      mode: "drop",
      name: "tracks_capture_priority_idx",
    },
    item: 13,
    rewrite: false,
    title: "catalogue Apple worklist: capture-priority singleton → vendor composite",
  },
  {
    after: [{ args: [WRONG_AUDIO_STATUS, 50], sql: captureLensSql() }],
    baseline: [{ args: [WRONG_AUDIO_STATUS, 50], sql: captureLensSql() }],
    index: {
      ddl: `create index if not exists tracks_capture_terminal_idx on tracks(capture_status, catalogue_ranked_at)
            where capture_status in ('wrong-audio', 'unmatched', 'failed')`,
      name: "tracks_capture_terminal_idx",
    },
    item: 14,
    rewrite: false,
    title: "capture terminal lens: status scan → tracks_capture_terminal_idx seek",
  },
  {
    after: [{ args: [MEGA_LABEL_ID], sql: labelCoverSql() }],
    baseline: [{ args: [MEGA_LABEL_ID], sql: labelCoverSql() }],
    index: {
      ddl: `create index if not exists tracks_label_id_release_date_idx on tracks(label_id, release_date, track_id)`,
      name: "tracks_label_id_release_date_idx",
    },
    item: 15,
    rewrite: false,
    title: "label cover subquery: seek+filesort → tracks(label_id, release_date) composite",
  },
  {
    after: [{ args: [REARM_CUTOFF, 50], sql: rearmPickSql() }],
    baseline: [{ args: [REARM_CUTOFF, 50], sql: rearmPickSql() }],
    index: {
      ddl: `create index if not exists crawl_frontier_label_node_idx on crawl_frontier(state, done_at)
            where kind = 'label' and source = 'musicbrainz'`,
      name: "crawl_frontier_label_node_idx",
    },
    item: 16,
    rewrite: false,
    title: "rearm seed labels: done-partition scan → label-node partial index",
  },
  {
    after: [{ args: [25], sql: artistReviewSql() }],
    baseline: [{ args: [25], sql: artistReviewSql() }],
    index: {
      ddl: `create index if not exists artist_socials_reviewed_created_idx on artist_socials(reviewed_at, created_at)`,
      name: "artist_socials_reviewed_created_idx",
    },
    item: 17,
    rewrite: false,
    title: "artist review queue: unreviewed group-by scan → (reviewed_at, created_at) index",
  },
  {
    after: [{ args: [100], sql: candidateQueueSql() }],
    baseline: [{ args: [100], sql: candidateQueueSql() }],
    index: {
      ddl: `create index if not exists artist_socials_candidate_idx on artist_socials(artist_id) where status = 'candidate'`,
      name: "artist_socials_candidate_idx",
    },
    item: 18,
    rewrite: false,
    title: "candidate queue: status='candidate' scan → partial index seek",
  },
  {
    after: [{ args: [175], sql: earLensSql() }],
    baseline: [{ args: [175], sql: earLensSql() }],
    index: {
      ddl: `create index if not exists tracks_catalogue_ear_idx
            on tracks(is_catalogue, dismissed_at, nearest_finding_score, track_id)`,
      name: "tracks_catalogue_ear_idx",
    },
    item: 19,
    rewrite: false,
    title: "Ear lens: residual prefix walk → active-catalogue composite seek",
  },
  {
    after: searchFilterReads(true),
    baseline: searchFilterReads(false),
    item: 20,
    rewrite: true,
    title:
      "search name filters: JSON LIKE + lower() scans → track_artists / label_id / album_id / key seeks",
  },
  {
    after: [{ args: [3, 100], sql: deezerCatalogueWorklistSql() }],
    baseline: [{ args: [3, 100], sql: deezerCatalogueWorklistSql() }],
    index: {
      baselineDdl: `create index if not exists tracks_capture_priority_idx on tracks(capture_priority)`,
      ddl: `drop index if exists tracks_capture_priority_idx`,
      expected: "redundant",
      mode: "drop",
      name: "tracks_capture_priority_idx",
    },
    item: 21,
    rewrite: false,
    title: "catalogue Deezer worklist: capture-priority singleton → vendor composite",
  },
  {
    after: artistSocialReads(),
    baseline: artistSocialReads(),
    index: {
      baselineDdl: `create index if not exists artist_socials_artist_id_idx on artist_socials(artist_id)`,
      ddl: `drop index if exists artist_socials_artist_id_idx`,
      expected: "redundant",
      mode: "drop",
      name: "artist_socials_artist_id_idx",
    },
    item: 22,
    rewrite: false,
    title: "artist socials: single-column artist_id index → unique composite prefix",
  },
  {
    after: anchorResidualReads(),
    baseline: anchorResidualReads(),
    index: {
      baselineDdl: `create index if not exists tracks_anchor_fill_queue_idx on tracks(nearest_finding_score)
                    where spotify_uri is null`,
      ddl: `drop index if exists tracks_anchor_fill_queue_idx`,
      expected: "redundant",
      mode: "drop",
      name: "tracks_anchor_fill_queue_idx",
    },
    item: 23,
    rewrite: false,
    title: "residual anchor reads: score-only fill index drop proof",
  },
];

function searchFilterReads(resolved: boolean): Query[] {
  const ids = resolved ? { albumId: "album-0", artistId: "artist-0", labelId: MEGA_LABEL_ID } : {};
  const filters = [
    { artist: "Artist 0" },
    { label: "Hospital Records" },
    { album: "Album 0" },
    { key: "A minor" },
  ];

  return filters.map((filter) => {
    const clauses = compileFilters(filter, ids);

    return {
      args: [...clauses.flatMap((clause) => clause.args), 12],
      sql: `select tracks.track_id, tracks.title, tracks.bpm, tracks.key, tracks.label, findings.log_id
            from tracks left join findings on findings.track_id = tracks.track_id
            where ${clauses.map((clause) => clause.sql).join(" and ")}
            order by case when findings.track_id is null then 1 else 0 end asc,
                     tracks.release_date desc, tracks.track_id asc
            limit ?`,
    };
  });
}

function labelCatalogueFoldSql(): string {
  return `with label_credits as (
            select distinct credit.value as name
            from tracks
            join json_each(tracks.artists_json) credit
            where tracks.label_id = ?
          )
          select lc.name as name, min(a.slug) as slug
          from label_credits lc
          join artists a on a.name = lc.name collate nocase
          group by lc.name collate nocase`;
}

function analyzeWorklistSql(): string {
  return `select ${WORK_SELECT}
          from tracks t
          left join findings f on f.track_id = t.track_id
          where 1 = 1 and (t.source_audio_key is not null
            and t.capture_status <> 'wrong-audio'
            and (t.analyzed_at is null or t.analyzed_from is null or t.analyzed_from <> 'full'))
          ${WORK_ORDER}
          limit ?`;
}

function appleWorklistSql(): string {
  return `select t.track_id, t.isrc, t.album_id,
                 t.backfill_apple_music_attempted_at as attempted_at,
                 t.backfill_apple_music_failures as failures
          from tracks t
          where t.is_catalogue = 1
            and t.apple_music_url is null
            and t.isrc is not null and trim(t.isrc) <> ''
            and t.backfill_apple_music_done_at is null
            and (t.backfill_apple_music_attempted_at is null
                 or t.backfill_apple_music_attempted_at < ?)
          order by t.capture_priority desc, t.track_id
          limit ?`;
}

function deezerCatalogueWorklistSql(): string {
  return `select t.track_id, t.isrc, t.duration_ms
          from tracks t
          where t.is_catalogue = 1
            and t.deezer_track_id is null
            and t.backfill_deezer_attempted_at is null
            and t.backfill_deezer_failures < ?
            and t.isrc is not null and trim(t.isrc) <> ''
            and t.duration_ms > 0
          order by t.capture_priority desc, t.track_id
          limit ?`;
}

function artistSocialReads(): Query[] {
  const artistIds = ["artist-0", "artist-1", "artist-2", "artist-3"];
  const placeholders = artistIds.map(() => "?").join(", ");

  return [
    {
      args: [artistIds[0] ?? "artist-0"],
      sql: `select platform, url, status from artist_socials where artist_id = ?`,
    },
    {
      args: artistIds,
      sql: `select artist_id, id, platform, url, source, status, created_at, reviewed_at
            from artist_socials
            where artist_id in (${placeholders})`,
    },
  ];
}

function anchorResidualReads(): Query[] {
  return [
    {
      args: [SEED_NOW],
      sql: `update tracks
            set spotify_anchor_attempted_at = null,
                spotify_anchor_attempts = max(coalesce(spotify_anchor_attempts, 0) - 1, 0)
            where spotify_uri is null
              and spotify_anchor_attempted_at >= ?
              and has_isrc = 1`,
    },
    {
      args: [25],
      sql: `select track_id, title, artists_json, album_image_url, duration_ms,
                   mb_recording_id, anchor_review_json
            from tracks
            where anchor_review_json is not null
              and spotify_uri is null
              and dismissed_at is null
            order by track_id asc
            limit ?`,
    },
    {
      args: [],
      sql: `select count(*) as n from tracks
            where isrc is not null and spotify_uri is null
              and not exists (select 1 from findings where findings.track_id = tracks.track_id)`,
    },
  ];
}

function captureLensSql(): string {
  return `select ${CATALOGUE_SELECT}
          from tracks ct
          left join findings cf on cf.track_id = ct.track_id
          where cf.track_id is null and ct.dismissed_at is null and ct.capture_status = ?
          order by ct.catalogue_ranked_at desc, ct.track_id asc
          limit ?`;
}

function labelCoverSql(): string {
  return `select (select json_object('u', t2.album_image_url, 'k', a2.image_key,
                                      's', a2.image_state, 'v', a2.image_updated_at)
                    from tracks t2
                    left join albums a2 on a2.id = t2.album_id
                   where t2.label_id = labels.id and t2.album_image_url is not null
                   order by t2.release_date is null asc, t2.release_date desc, t2.track_id asc
                   limit 1) as cover_json
          from labels where labels.id = ? limit 1`;
}

function rearmPickSql(): string {
  return `select id from crawl_frontier
          where kind = 'label'
            and source = 'musicbrainz'
            and state = 'done'
            and done_at is not null
            and done_at < ?
            and label_slug in (select slug from labels where seed_state = 'enabled')
          order by done_at asc, id asc
          limit ?`;
}

function artistReviewSql(): string {
  return `select a.id as artist_id, a.name,
                 count(*) as pending, min(s.created_at) as anchor_at
          from artists a
          join artist_socials s on s.artist_id = a.id
          where s.reviewed_at is null
          group by a.id, a.name
          order by anchor_at asc
          limit ?`;
}

function candidateQueueSql(): string {
  return `select distinct artist_id from artist_socials where status = 'candidate' limit ?`;
}

function earLensSql(): string {
  return `select ${CATALOGUE_SELECT}
          from tracks ct
          left join findings cf on cf.track_id = ct.track_id
          where cf.track_id is null
            and ct.dismissed_at is null
            and ct.nearest_finding_score is not null
            and ct.duplicate_of_track_id is null
            and ct.duration_ms < ${LONG_FORM_MS}
          order by ct.nearest_finding_score desc, ct.track_id asc
          limit ?`;
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));

  return sorted[index] ?? 0;
}

async function timeIt(run: () => Promise<unknown>): Promise<number> {
  const start = performance.now();

  await run();

  return performance.now() - start;
}

function cell(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
}

async function explain(queries: Query[]): Promise<string> {
  const plans: string[] = [];

  for (const query of queries) {
    const result = await client.execute({
      args: query.args,
      sql: `explain query plan ${query.sql}`,
    });

    plans.push(result.rows.map((row) => cell(row.detail)).join("\n      "));
  }

  return plans.join("\n      · ");
}

async function runGroup(queries: Query[]): Promise<void> {
  for (const query of queries) {
    await client.execute({ args: query.args, sql: query.sql });
  }
}

async function measure(queries: Query[]): Promise<number> {
  const samples: number[] = [];

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    samples.push(await timeIt(() => runGroup(queries)));
  }

  return percentile(samples, 50);
}

function hasFullScan(plan: string): boolean {
  return plan.split("\n").some((line) => /\bSCAN\b/.test(line) && !/USING/.test(line));
}

function planLabel(plan: string): string {
  return hasFullScan(plan) ? "scan" : "seek";
}

type Verdict = {
  afterP50: number;
  baselineP50: number;
  ddlMs: null | number;
  item: number;
  planAfter: string;
  planBefore: string;
  proofPassed: boolean;
  title: string;
};

async function proveItem(proof: Proof): Promise<Verdict> {
  if (proof.index) {
    if (proof.index.mode === "drop") {
      const baselineDdl = proof.index.baselineDdl;

      if (!baselineDdl) {
        fail(`item ${proof.item} drop proof is missing baselineDdl`);
      }

      await client.execute(baselineDdl);
    } else {
      await client.execute(`drop index if exists ${proof.index.name}`);
    }
  }

  const planBefore = await explain(proof.baseline);
  const baselineP50 = await measure(proof.baseline);

  let ddlMs: null | number = null;

  if (proof.index) {
    const ddl = proof.index.ddl;

    ddlMs = await timeIt(() => client.execute(ddl));
  }

  const planAfter = await explain(proof.after);
  const afterP50 = await measure(proof.after);

  const proofPassed = proof.index
    ? proof.index.mode === "drop"
      ? proof.index.expected === "load-bearing"
        ? planBefore.includes(proof.index.name) &&
          (hasFullScan(planAfter) || planAfter.includes("TEMP B-TREE FOR ORDER BY"))
        : !planAfter.includes(proof.index.name) && !hasFullScan(planAfter)
      : planAfter.includes(proof.index.name)
    : hasFullScan(planBefore) && !hasFullScan(planAfter);

  return {
    afterP50,
    baselineP50,
    ddlMs,
    item: proof.item,
    planAfter,
    planBefore,
    proofPassed,
    title: proof.title,
  };
}

function formatSpeedup(baseline: number, after: number): string {
  if (after <= 0) {
    return "n/a";
  }

  return `${(baseline / after).toFixed(1)}×`;
}

async function main(): Promise<void> {
  console.log("bench-db-scale — applying migrations to the scratch DB…");
  await migrate(drizzle(client), { migrationsFolder });
  await ensureSearchIndex(client);

  if (skipSeed) {
    console.log("BENCH_SKIP_SEED=1 — benching the already-seeded DB (no seed phase).");
  } else {
    console.log(`Seeding the ${scale}-track regime (this is the slow part)…`);
    await seedScale(client, { scale });
  }

  const selected = only.length > 0 ? PROOFS.filter((proof) => only.includes(proof.item)) : PROOFS;

  if (selected.length === 0) {
    fail(
      `BENCH_ONLY=${process.env.BENCH_ONLY ?? ""} matched no items (valid: ${PROOFS.map((p) => p.item).join(", ")})`,
    );
  }

  console.log(`\nProving ${selected.length} item(s), ${iterations} iterations each…\n`);

  const verdicts: Verdict[] = [];

  for (const proof of selected) {
    process.stdout.write(`  item ${proof.item} — ${proof.title}\n`);
    verdicts.push(await proveItem(proof));
  }

  const header = [
    "item".padEnd(4),
    "baseline_p50".padStart(13),
    "after_p50".padStart(11),
    "speedup".padStart(8),
    "before".padStart(6),
    "after".padStart(6),
    "gate".padStart(4),
    "ddl_ms".padStart(10),
  ].join("  ");

  console.log(`\n── verdict ${"─".repeat(Math.max(0, 78 - 11))}`);
  console.log(header);
  console.log("─".repeat(header.length));

  for (const verdict of verdicts) {
    console.log(
      [
        String(verdict.item).padEnd(4),
        `${verdict.baselineP50.toFixed(1)} ms`.padStart(13),
        `${verdict.afterP50.toFixed(1)} ms`.padStart(11),
        formatSpeedup(verdict.baselineP50, verdict.afterP50).padStart(8),
        planLabel(verdict.planBefore).padStart(6),
        planLabel(verdict.planAfter).padStart(6),
        (verdict.proofPassed ? "Y" : "N").padStart(4),
        (verdict.ddlMs === null ? "rewrite" : `${verdict.ddlMs.toFixed(0)} ms`).padStart(10),
      ].join("  "),
    );
  }

  console.log(`\n── EXPLAIN QUERY PLAN (before → after) ${"─".repeat(40)}`);
  for (const verdict of verdicts) {
    console.log(`\n  item ${verdict.item}: ${verdict.title}`);
    console.log(`    before: ${verdict.planBefore}`);
    console.log(`    after:  ${verdict.planAfter}`);
  }

  console.log(
    "\nProof engine complete. gate=Y means a created index was selected, a ruled drop stayed off " +
      "full scans, or a keep proof degraded when its named index was trial-dropped. Read every " +
      "before/after plan before promoting schema DDL.",
  );
  process.exit(0);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
