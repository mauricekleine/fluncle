#!/usr/bin/env bun
/**
 * THROWAWAY HOSTED-SCALE PROOF ENGINE — the per-item gate for the DB-scale backlog
 * (docs/db-scale-backlog.md, Wave 1 items 6 + 8–19). NOT a test, NOT wired into CI. Modelled 1:1 on
 * `bench-tracks-hub.ts` (same client/migrate/guard/`percentile`/`timeIt`/`explain` machinery).
 *
 * ── WHO RUNS THIS, AND WHY ────────────────────────────────────────────────────
 * THE OPERATOR runs it by hand against a SCRATCH hosted Turso Cloud DB, to PROVE — hosted, never
 * local — whether each candidate index / query-rewrite in the backlog actually helps at 150k rows.
 * It CANNOT run in CI or an agent's Bash session (Turso Cloud creds are operator-only), and
 * `turso dev` is not evidence: docs/local-database.md "Local is not production" — the exact
 * behaviours that decide scan-vs-seek diverge between sqld and hosted, misleadingly.
 *
 * ── WHAT IT MEASURES ──────────────────────────────────────────────────────────
 * It seeds the 150k regime (`seedScale`, ./lib/scale-seed.ts) and then, for EACH backlog item:
 *   1. Runs the CURRENT (baseline) query — the REAL production shape (the year clause is the actual
 *      `compileFilters` builder from `../src/lib/server/search`; every other shape is replicated
 *      verbatim from its server module, cited per item), captures p50 + `EXPLAIN QUERY PLAN`.
 *   2. Applies the fix — either a runtime `create index` (timed, so we see it does not wedge at 150k)
 *      or, for the pure REWRITE items (8 split-OR, 9 count−count, 10 sargable year-range), the
 *      rewritten SQL — then captures p50 + EXPLAIN again.
 *   3. Emits a verdict row (speedup, plan scan→seek, whether the named index was picked up).
 *
 * The index items create PLAIN-ASC btree indexes at runtime (never `libsql_vector_idx`, which wedges
 * a populated hosted table — docs/local-database.md); each candidate index was verified absent from
 * schema.ts. Every named index is dropped before its baseline and (re-)created for its after read, so
 * a re-run over an already-indexed DB still measures a clean before/after.
 *
 * ── USAGE ─────────────────────────────────────────────────────────────────────
 *   SCRATCH_TURSO_DATABASE_URL=libsql://<scratch>.turso.io \
 *   SCRATCH_TURSO_AUTH_TOKEN=<token> \
 *   bun run apps/web/scripts/bench-db-scale.ts
 *
 * Optional env:
 *   BENCH_SCALE=150000       total tracks to seed (the seeder's per-table knobs live in scale-seed.ts)
 *   BENCH_ITERATIONS=12      samples per shape for the p50
 *   BENCH_ONLY=12,15,19      run only these item numbers (default: all)
 *   BENCH_SKIP_SEED=1        skip the seed phase and bench an already-seeded DB (iterate on benches)
 *
 * The operator CREATES the scratch DB before and DESTROYS it after — this only measures. It NEVER
 * points at `fluncle`/`fluncle-dev`/local (it refuses a URL containing either name, `127.0.0.1`, or
 * `file:`, exactly like the tracks-hub bench).
 */
import { createClient } from "@libsql/client/web";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { fileURLToPath } from "node:url";

import { ensureSearchIndex } from "../src/db/search-index";
import { compileFilters } from "../src/lib/server/search";
import { SEED_NOW, seedScale } from "./lib/scale-seed";

function fail(message: string): never {
  console.error(`bench-db-scale: ${message}`);
  process.exit(1);
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];

  return raw ? Number.parseInt(raw, 10) : fallback;
}

const url = process.env.SCRATCH_TURSO_DATABASE_URL;
const authToken = process.env.SCRATCH_TURSO_AUTH_TOKEN;

if (!url || !authToken) {
  fail("set SCRATCH_TURSO_DATABASE_URL and SCRATCH_TURSO_AUTH_TOKEN (a THROWAWAY hosted DB)");
}

if (/fluncle(-dev)?\b/.test(url) || url.includes("127.0.0.1") || url.startsWith("file:")) {
  fail(`refusing to run against ${url} — use a SCRATCH hosted Turso DB, never prod/dev/local`);
}

const scale = envInt("BENCH_SCALE", 150_000);
const iterations = envInt("BENCH_ITERATIONS", 12);
const only = (process.env.BENCH_ONLY ?? "")
  .split(",")
  .map((piece) => Number.parseInt(piece.trim(), 10))
  .filter((value) => Number.isInteger(value));
const skipSeed = process.env.BENCH_SKIP_SEED === "1";

const client = createClient({ authToken, url });
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

// ── The stamps the seeder wrote are relative to SEED_NOW, so the bench's cutoffs are too ──────────
const NOW_MS = Date.parse(SEED_NOW);
const DAY_MS = 24 * 60 * 60 * 1000;
/** Item 13's Apple cooldown floor (a row attempted more recently than this is not yet eligible). */
const APPLE_COOLDOWN_CUTOFF = new Date(NOW_MS - 7 * DAY_MS).toISOString();
/** Item 16's re-arm floor (a label drained more recently than a day ago is not re-walked yet). */
const REARM_CUTOFF = new Date(NOW_MS - 1 * DAY_MS).toISOString();

// ── Replicated production constants (schema.ts / catalogue.ts) ────────────────────────────────────
const LONG_FORM_MS = 15 * 60_000;
const WRONG_AUDIO_STATUS = "wrong-audio";
const MEGA_LABEL_ID = "label-0"; // the seeded mega-imprint (labelIdForIndex, ~20% of the catalogue)

/** `catalogue.ts` CATALOGUE_SELECT — replicated verbatim (a plain column list, no correlated subqueries). */
const CATALOGUE_SELECT = `ct.track_id, ct.title, ct.artists_json, ct.album_image_url, ct.spotify_url,
  ct.apple_music_url, ct.isrc, ct.preview_url, ct.bpm, ct.key, ct.label, ct.release_date,
  ct.nearest_finding_score, ct.nearest_finding_track_id, ct.capture_priority, ct.capture_status,
  ct.capture_verification, ct.catalogue_ranked_at, ct.duplicate_of_track_id, ct.dismissed_at,
  (ct.source_audio_key is not null) as has_captured_audio`;

/** `track-work.ts` WORK_SELECT — replicated verbatim (the analyze/embed worklist page columns). */
const WORK_SELECT = `t.track_id, t.title, t.artists_json, t.isrc, t.label, t.duration_ms,
  t.source_audio_key, t.source_audio_rejected, t.capture_priority, t.bpm, t.analyzed_from, t.source_audio_failures,
  f.log_id as log_id,
  (f.track_id is not null) as certified`;

/** `track-work.ts` WORK_ORDER — the capture-ladder ORDER BY (analyze rides it via WORK_ORDER). */
const WORK_ORDER = `order by (f.track_id is not null) desc,
  coalesce(t.capture_priority, 0) desc,
  coalesce(t.demand_score, 0) desc,
  coalesce(f.added_at, '') desc,
  t.track_id desc`;

type Query = { args: (null | number | string)[]; sql: string };

type IndexSpec = { ddl: string; name: string };

type Proof = {
  /** The read(s) after the fix — index items re-run the baseline; rewrite items run the new SQL. */
  after: Query[];
  /** The current production shape(s). Item 8's rewrite is two seeks, so a proof runs an array. */
  baseline: Query[];
  /** The runtime index to drop-then-create between baseline and after; omitted for pure rewrites. */
  index?: IndexSpec;
  item: number;
  /** Whether the fix is a query REWRITE (no new index) — shown in the verdict. */
  rewrite: boolean;
  title: string;
};

// ── Item 10's baseline year clauses come from the REAL builder, so the bench cannot drift from it ──
const yearClauses = compileFilters({ yearMax: 2020, yearMin: 2015 });
const yearBaselineSql = `select count(*) as n from tracks where ${yearClauses
  .map((clause) => clause.sql)
  .join(" and ")}`;
const yearBaselineArgs = yearClauses.flatMap((clause) => clause.args);

/**
 * The proofs. Order matters only in that each item's baseline is measured before ITS OWN index
 * exists (a later item's index cannot help an earlier item's baseline — the run is sequential and
 * every candidate index is on a different table/predicate). SQL is cited to its server module.
 */
const PROOFS: Proof[] = [
  {
    // demand.ts:310 — the nightly CLEAR (`update … where demand_rank <> 1`). Measured via a count-
    // proxy on the identical driving predicate (the UPDATE's row-FINDING scan is what the index
    // addresses) so the bench stays idempotent/re-runnable. The promotion half is a separate
    // PK-lookup rewrite (`where id = 'musicbrainz:artist:<mbid>'`), planner-independent, not benched.
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
    // recommendations.ts:250 findSeedTrack — the cross-table OR over a LEFT JOIN (neither index
    // drives it → full scan). Rewrite: a PK seek on tracks, then (on a miss) the log_id unique-index
    // seek. The seed value misses on track_id and hits on findings.log_id — the rewrite's worst case.
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
    // crawl.ts:1471 getCrawlStatus catalogueTracks — the anti-join count. Rewrite: findings is a
    // strict 1:1 subtype on the shared PK, so the catalogue count IS count(tracks) − count(findings).
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
    // search.ts:678-690 compileFilters year — `substr(release_date,1,4)` wraps the column and defeats
    // tracks_release_date_idx. Rewrite: a bare lexicographic range that rides the existing index.
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
    // catalogue-groups.ts:463-474 listLabelCatalogue artist_slugs — the NOCASE name fold. With only a
    // BINARY artists.name index, SQLite builds a per-request AUTOMATIC COVERING INDEX over ALL artists.
    after: [{ args: [MEGA_LABEL_ID], sql: labelCatalogueFoldSql() }],
    baseline: [{ args: [MEGA_LABEL_ID], sql: labelCatalogueFoldSql() }],
    index: {
      ddl: `create index if not exists artists_name_nocase_idx on artists (name collate nocase)`,
      name: "artists_name_nocase_idx",
    },
    item: 11,
    rewrite: false,
    title: "label render: automatic NOCASE index → artists_name_nocase_idx",
  },
  {
    // track-work.ts:385-392 analyze kindClause (scope=all page read). No covering index today → scans
    // captured rows every enrich tick. tracks_analyze_queue_idx mirrors tracks_embed_queue_idx.
    // CAVEAT the hosted run will confirm: the query WHERE carries an EXTRA `analyzed_at is null`
    // disjunct the index predicate does NOT, so the query is BROADER than the partial index and
    // SQLite cannot use it (a local EXPLAIN shows a bare `SCAN t`). Expect idx=N unless the fix ALSO
    // drops `analyzed_at is null` from the query (redundant when analysis always writes both) or adds
    // it to the index predicate — a real proof-engine finding, not a bench defect.
    after: [{ args: [50], sql: analyzeWorklistSql() }],
    baseline: [{ args: [50], sql: analyzeWorklistSql() }],
    index: {
      ddl: `create index if not exists tracks_analyze_queue_idx on tracks(track_id)
            where source_audio_key is not null and (analyzed_from is null or analyzed_from <> 'full')`,
      name: "tracks_analyze_queue_idx",
    },
    item: 12,
    rewrite: false,
    title: "analyze worklist: captured-row scan → tracks_analyze_queue_idx seek",
  },
  {
    // backfill.ts:1001 listCatalogueAppleWork — full tracks scan + findings anti-join + filesort on
    // coalesce(capture_priority,0). Fix: partial index + drop coalesce so the index serves the order.
    after: [{ args: [APPLE_COOLDOWN_CUTOFF, 100], sql: appleWorklistSql(false) }],
    baseline: [{ args: [APPLE_COOLDOWN_CUTOFF, 100], sql: appleWorklistSql(true) }],
    index: {
      ddl: `create index if not exists tracks_catalogue_apple_queue_idx on tracks(capture_priority, track_id)
            where apple_music_url is null and backfill_apple_music_done_at is null and isrc is not null`,
      name: "tracks_catalogue_apple_queue_idx",
    },
    item: 13,
    rewrite: false,
    title: "catalogue Apple worklist: scan+filesort → partial index (coalesce dropped)",
  },
  {
    // catalogue.ts:2401-2412 quarantine lens — `capture_status = ?` is unindexed → full anti-join scan
    // + sort on catalogue_ranked_at. Composite partial index serves both the seek and the ORDER BY.
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
    // labels.ts:492 LABEL_CATALOGUE_COVER_JSON (used :1283) — seeks label_id then SORTS by release_date
    // with no composite index; a mega-imprint sorts thousands of rows per cover tile. The composite
    // makes the label_id lookup a seek for sure; whether it ALSO retires the temp-sort depends on the
    // planner handling the `release_date is null asc` leading ORDER BY term — watch plan_after for
    // whether `USE TEMP B-TREE FOR ORDER BY` disappears at 150k.
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
    // crawl.ts:547-570 rearmSeedLabels — the row-selecting subquery (measured directly; the wrapping
    // UPDATE mutates). pick_idx seeks state='done' but residual-scans EVERY done row for kind/source.
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
    // artists.ts:1666 listArtistReviewRows — GROUP BY artist + min(created_at) over ALL unreviewed
    // socials before LIMIT. The composite is the named fix; the full fix also needs the bounded
    // head-walk rewrite (Wave-2 fallback), so this proves the index's effect on the current query.
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
    // artists.ts:1243 listArtistSocialsQueue default path — the inner `distinct artist_id where
    // status='candidate'` scans most of the table (status unindexed, candidates rare).
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
    // catalogue.ts:2384-2399 ear lens — walks tracks_nearest_finding_score_idx DESC but the near-1.0
    // duplicate prefix (dupes score ~1.0) is a residual, so the walk reads the whole dupe head first.
    after: [{ args: [175], sql: earLensSql() }],
    baseline: [{ args: [175], sql: earLensSql() }],
    index: {
      ddl: `create index if not exists tracks_ear_lens_idx on tracks(nearest_finding_score)
            where duplicate_of_track_id is null and nearest_finding_score is not null`,
      name: "tracks_ear_lens_idx",
    },
    item: 19,
    rewrite: false,
    title: "Ear lens: duplicate-prefix walk → partial index skipping the dupe head",
  },
];

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

function appleWorklistSql(coalesceOrder: boolean): string {
  const order = coalesceOrder
    ? `order by coalesce(t.capture_priority, 0) desc, t.track_id`
    : `order by t.capture_priority desc, t.track_id`;

  return `select t.track_id, t.isrc, t.album_id,
                 t.backfill_apple_music_attempted_at as attempted_at,
                 t.backfill_apple_music_failures as failures
          from tracks t
          left join findings f on f.track_id = t.track_id
          where f.track_id is null
            and t.apple_music_url is null
            and t.isrc is not null and trim(t.isrc) <> ''
            and t.backfill_apple_music_done_at is null
            and (t.backfill_apple_music_attempted_at is null
                 or t.backfill_apple_music_attempted_at < ?)
          ${order}
          limit ?`;
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

/** A libSQL cell → string (a raw `Value` may be an object), for the EXPLAIN dump. */
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

/** Run every query in the group in sequence (item 8's rewrite is two seeks timed as one read). */
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

/** A plan is a FULL SCAN if any line reads `SCAN <table>` with no `USING <INDEX>` on that line. */
function hasFullScan(plan: string): boolean {
  return plan.split("\n").some((line) => /\bSCAN\b/.test(line) && !/USING/.test(line));
}

function planLabel(plan: string): string {
  return hasFullScan(plan) ? "scan" : "seek";
}

type Verdict = {
  afterP50: number;
  baselineP50: number;
  createMs: null | number;
  indexUsed: boolean;
  item: number;
  planAfter: string;
  planBefore: string;
  title: string;
};

async function proveItem(proof: Proof): Promise<Verdict> {
  // An index item is dropped before its baseline so a re-run (BENCH_SKIP_SEED) still gets a clean
  // before/after; a rewrite item touches no index.
  if (proof.index) {
    await client.execute(`drop index if exists ${proof.index.name}`);
  }

  const planBefore = await explain(proof.baseline);
  const baselineP50 = await measure(proof.baseline);

  let createMs: null | number = null;

  if (proof.index) {
    const ddl = proof.index.ddl;

    createMs = await timeIt(() => client.execute(ddl));
  }

  const planAfter = await explain(proof.after);
  const afterP50 = await measure(proof.after);

  // For an index item, "used" = the named index appears in the after plan. For a rewrite, "used" =
  // the rewrite reached a seek (moved off the baseline's full scan).
  const indexUsed = proof.index
    ? planAfter.includes(proof.index.name)
    : hasFullScan(planBefore) && !hasFullScan(planAfter);

  return {
    afterP50,
    baselineP50,
    createMs,
    indexUsed,
    item: proof.item,
    planAfter,
    planBefore,
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

  // ── The verdict table ─────────────────────────────────────────────────────────
  const header = [
    "item".padEnd(4),
    "baseline_p50".padStart(13),
    "after_p50".padStart(11),
    "speedup".padStart(8),
    "before".padStart(6),
    "after".padStart(6),
    "idx".padStart(4),
    "create_ms".padStart(10),
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
        (verdict.indexUsed ? "Y" : "N").padStart(4),
        (verdict.createMs === null ? "rewrite" : `${verdict.createMs.toFixed(0)} ms`).padStart(10),
      ].join("  "),
    );
  }

  // ── The full before/after EXPLAIN dump ─────────────────────────────────────────
  console.log(`\n── EXPLAIN QUERY PLAN (before → after) ${"─".repeat(40)}`);
  for (const verdict of verdicts) {
    console.log(`\n  item ${verdict.item}: ${verdict.title}`);
    console.log(`    before: ${verdict.planBefore}`);
    console.log(`    after:  ${verdict.planAfter}`);
  }

  console.log(
    "\nProof engine complete. A row is a WIN when speedup > 1 AND before=scan → after=seek. Verify " +
      "each candidate index's plan_after actually names it (idx=Y) before promoting the fix.",
  );
  process.exit(0);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
