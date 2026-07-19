// THE CATALOGUE FUNNEL — the catalogue pipeline (crawl → anchor → capture → analyze/embed →
// rec-eligible → certified) as numbers on one page (docs/rfcs/catalogue-funnel-rfc.md, U1).
//
// ── ONE SOURCE OF TRUTH FOR THE COUNTS ───────────────────────────────────────────────
// This module records nothing new. Every number it computes is READ THROUGH THE SAME
// PREDICATE THE PRODUCT ALREADY RUNS, so the funnel can never tell the operator a different
// story than the machine obeys:
//
//   - the queue depths reuse `countTrackWork` / `kindClause` (track-work.ts) — the exact
//     worklists the capture/analyze/embed/anchor sweeps drain, brake and all;
//   - the rec-eligibility count folds in `REC_ELIGIBLE_WHERE` (recommendations.ts) — the
//     exact gate `listRecommendations` scans by, extracted to a shared fragment so the two
//     can never drift (the eligibility-agreement test proves it on shared fixtures);
//   - the frontier counts come from `getCrawlStatus` (crawl.ts) — the crawler's own read;
//   - the capture-budget meter comes from `getCatalogueCaptureState` (capture-budget.ts) —
//     the same readout `/admin/catalogue` renders and the brake obeys.
//
// ── TWO OPS ──────────────────────────────────────────────────────────────────────────
//   - `recordCatalogueSnapshot` (AGENT tier) — compute the live counts and UPSERT one row per
//     UTC day (`on conflict(day) do update`), so a re-fired daily tick overwrites rather than
//     doubles a bar. The on-box `fluncle-funnel-snapshot` timer fires it once a day.
//   - `getFunnel` (admin tier) — the live counts + meters computed NOW, plus the bounded
//     day-by-day series read back from the ledger (cut in SQL, plain ASC index walk on `day`).
//
// ── SCALE NOTE ────────────────────────────────────────────────────────────────────────
// The stage scan is a single-pass conditional-aggregate over `tracks left join findings`
// (never `union all` over a CTE — trap #4, docs/local-database.md). No vector or feature blob
// crosses the wire — an `embedding_blob is not null` test reads the cell's null flag, not its
// bytes. It IS a full scan of a growing table, run ONCE A DAY off the hot path — the honest
// cost of a snapshot. Every other read here is either bounded (the queue counts ride their
// partial indexes) or on the small `crawl_frontier` / `catalogue_snapshots` tables.

import { getCatalogueCaptureState } from "./capture-budget";
import { getCrawlStatus } from "./crawl";
import { getDb, typedRow, typedRows } from "./db";
import { REC_ELIGIBLE_WHERE } from "./recommendations";
import { clampSnapshotWindow } from "./snapshot-window";
import { ANCHOR_REASK_AFTER_DAYS, countTrackWork, kindClause } from "./track-work";

/** The funnel's stage totals — cumulative counts of rows that have reached each stage. */
export type FunnelStages = {
  /** Uncertified catalogue rows carrying full-song analysis (bpm/key from the captured audio). */
  analyzed: number;
  /** Uncertified catalogue rows that have gained a Spotify anchor (`spotify_uri`). */
  anchored: number;
  /** Uncertified catalogue rows whose full-song audio has been captured. */
  captured: number;
  /** CERTIFIED tracks (a `findings` row exists) — the funnel's right edge, the archive exit. */
  certified: number;
  /** CRAWLED / uncertified: every catalogue track (a `tracks` row with no `findings` row). */
  crawled: number;
  /** Uncertified catalogue rows carrying a MuQ embedding vector. */
  embedded: number;
  /** The rec-eligibility pool — rows clearing the exact `REC_ELIGIBLE_WHERE` gate. */
  recEligible: number;
};

/** The funnel's queue depths — how much is waiting behind each stage. */
export type FunnelQueues = {
  /** The `analyze` worklist backlog (catalogue half). */
  analyzeQueue: number;
  /** The anchor re-ask BENCH: rows attempted inside the 14-day window, sitting out (not re-billed). */
  anchorBackoff: number;
  /** Anchor worklist rows WITH an ISRC (the exact-ISRC anchor path). */
  anchorQueueIsrc: number;
  /** Anchor worklist rows with NO ISRC (the search-triple anchor path). */
  anchorQueueNoIsrc: number;
  /** The `capture` worklist backlog (catalogue half). Reflects the capture brake (shut ⇒ 0). */
  captureQueue: number;
  /** The `embed` worklist backlog (catalogue half). */
  embedQueue: number;
};

/**
 * The LIVE queue depths — the persisted `FunnelQueues` plus the anchor worklist split by whether the
 * row already carries a MuQ embedding. This split is a live-read refinement only (never persisted),
 * so it lives here and not on `FunnelQueues` / the snapshot row: `anchorQueueReady` is the embedded
 * head the hourly anchor sweep actually works (the actionable number); `anchorQueueAwaitingAudio` is
 * crawler metadata still waiting on capture/embed (it costs nothing until the audio pipeline reaches
 * it). Both derive from the SAME anchor worklist predicate, so they sum to `anchorQueueIsrc +
 * anchorQueueNoIsrc`.
 */
export type FunnelLiveQueues = FunnelQueues & {
  anchorQueueAwaitingAudio: number;
  anchorQueueReady: number;
};

/** Every integer the daily snapshot persists — the stages, the queues, and the frontier. */
export type CatalogueSnapshotCounts = FunnelStages &
  FunnelQueues & { frontierDone: number; frontierPending: number };

/** One persisted snapshot row (the counts + its day + when it was written). */
export type CatalogueSnapshotRow = CatalogueSnapshotCounts & {
  createdAt: string;
  day: string;
};

/** The operator's spend levers, surfaced as gauges (docs/rfcs/catalogue-funnel-rfc.md § meters). */
export type FunnelMeters = {
  /** The anchor re-ask bench size (mirrors `queues.anchorBackoff` — a lever, called out here). */
  anchorBackoff: number;
  /** The capture budget's live readout — the metered-spend gauge. */
  captureBudget: {
    dailyBytes: number;
    dailyTracks: number;
    open: boolean;
    paused: boolean;
    remainingBytes: number;
    remainingTracks: number;
    windowHours: number;
  };
  /** Crawl frontier still to drain — how much metadata acquisition is left in flight. */
  frontierPending: number;
};

/** The one-call read behind `/admin/funnel`: everything live now, plus the history. */
export type FunnelView = {
  live: {
    meters: FunnelMeters;
    queues: FunnelLiveQueues;
    stages: FunnelStages;
  };
  series: CatalogueSnapshotRow[];
};

type StageRow = {
  analyzed: number | null;
  anchored: number | null;
  captured: number | null;
  certified: number | null;
  crawled: number | null;
  embedded: number | null;
  rec_eligible: number | null;
};

type AnchorSplitRow = { with_isrc: number | null; without_isrc: number | null };

/** The drainable anchor worklist split by the two verification paths. */
type AnchorSplit = { withIsrc: number; withoutIsrc: number };

type AnchorEmbeddingSplitRow = { awaiting_audio: number | null; ready: number | null };

/** The drainable anchor worklist split by whether the row already carries a MuQ embedding. */
type AnchorEmbeddingSplit = { awaitingAudio: number; ready: number };

/**
 * The whole set of catalogue counts, each through the product's own predicate. Independent
 * reads run concurrently; the result is exactly the row `recordCatalogueSnapshot` persists.
 */
export async function computeCatalogueSnapshotCounts(): Promise<CatalogueSnapshotCounts> {
  const db = await getDb();

  const [stages, anchorSplit, anchorBackoff, captureQueue, analyzeQueue, embedQueue, crawl] =
    await Promise.all([
      // THE STAGE SCAN — one single-pass conditional aggregate over the supertype/subtype join.
      // `rec_eligible` folds in the SHARED `REC_ELIGIBLE_WHERE` (recommendations.ts): the funnel's
      // eligibility count is, by construction, the same gate `listRecommendations` scans by.
      db.execute(`select
            sum(case when f.track_id is null then 1 else 0 end) as crawled,
            sum(case when f.track_id is null and t.spotify_uri is not null then 1 else 0 end) as anchored,
            sum(case when f.track_id is null and t.source_audio_key is not null then 1 else 0 end) as captured,
            sum(case when f.track_id is null and t.analyzed_from = 'full' then 1 else 0 end) as analyzed,
            sum(case when f.track_id is null and t.embedding_blob is not null then 1 else 0 end) as embedded,
            sum(case when ${REC_ELIGIBLE_WHERE} then 1 else 0 end) as rec_eligible,
            sum(case when f.track_id is not null then 1 else 0 end) as certified
          from tracks t
          left join findings f on f.track_id = t.track_id`),
      // THE ANCHOR QUEUE, split by ISRC — reuses the sweep's OWN worklist predicate
      // (`kindClause("anchor")`), so these two numbers ARE the drainable anchor worklist the box
      // sweep sees, split by the two verification paths. The join is present for `f.` in the clause.
      countAnchorQueueByIsrc(),
      // THE ANCHOR BENCH — rows benched by the 14-day re-ask window: the COMPLEMENT of the
      // `kindClause("anchor")` window guard (attempted, and inside the window). Its base guards
      // mirror that worklist; the window itself is the SHARED `ANCHOR_REASK_AFTER_DAYS` constant,
      // so the two can only ever disagree on the ISRC/duration edges, never on the window.
      countAnchorBackoff(),
      // The audio worklist backlogs — the product's OWN count function, brake and all.
      countTrackWork({ kind: "capture", scope: "catalogue" }),
      countTrackWork({ kind: "analyze", scope: "catalogue" }),
      countTrackWork({ kind: "embed", scope: "catalogue" }),
      // The crawler's own frontier read.
      getCrawlStatus(),
    ]);

  const stageRow = typedRow<StageRow>(stages.rows);

  return {
    analyzeQueue,
    analyzed: Number(stageRow?.analyzed ?? 0),
    anchorBackoff,
    anchorQueueIsrc: anchorSplit.withIsrc,
    anchorQueueNoIsrc: anchorSplit.withoutIsrc,
    anchored: Number(stageRow?.anchored ?? 0),
    captureQueue,
    captured: Number(stageRow?.captured ?? 0),
    certified: Number(stageRow?.certified ?? 0),
    crawled: Number(stageRow?.crawled ?? 0),
    embedQueue,
    embedded: Number(stageRow?.embedded ?? 0),
    frontierDone: crawl.frontier.done,
    frontierPending: crawl.frontier.pending,
    recEligible: Number(stageRow?.rec_eligible ?? 0),
  };
}

/**
 * The drainable anchor worklist, split by ISRC. Reuses `kindClause("anchor")` verbatim so the
 * count IS the sweep's own worklist (docs/catalogue-crawler.md § the anchor) — a `union all`
 * over a CTE is never used (trap #4); the ISRC split is a conditional aggregate in one pass.
 */
async function countAnchorQueueByIsrc(): Promise<AnchorSplit> {
  const anchor = kindClause("anchor");
  const db = await getDb();
  const result = await db.execute({
    args: anchor.args,
    sql: `select
            sum(case when t.isrc is not null then 1 else 0 end) as with_isrc,
            sum(case when t.isrc is null then 1 else 0 end) as without_isrc
          from tracks t
          left join findings f on f.track_id = t.track_id
          where ${anchor.sql}`,
  });
  const row = typedRow<AnchorSplitRow>(result.rows);

  return { withIsrc: Number(row?.with_isrc ?? 0), withoutIsrc: Number(row?.without_isrc ?? 0) };
}

/**
 * The drainable anchor worklist, split by whether the row already carries a MuQ embedding. Rides the
 * SAME `kindClause("anchor")` fragment `countAnchorQueueByIsrc` uses — one predicate, partitioned on
 * `embedding_blob is not null` — so the split can never disagree with the queue the sweep drains, and
 * the two halves sum to the whole anchor queue by construction:
 *   - `ready`        — embedded rows awaiting an anchor: the head the hourly anchor sweep actually
 *                      works, the actionable number.
 *   - `awaitingAudio`— the same worklist with no embedding yet: crawler metadata deep in the ladder,
 *                      costing nothing until capture/embed reach it.
 * `embedding_blob is not null` reads the cell's null flag, not its bytes (no vector crosses the wire —
 * the same `union all`-free single-pass shape the stage scan uses). Live-read only: never persisted.
 */
async function countAnchorQueueByEmbedding(): Promise<AnchorEmbeddingSplit> {
  const anchor = kindClause("anchor");
  const db = await getDb();
  const result = await db.execute({
    args: anchor.args,
    sql: `select
            sum(case when t.embedding_blob is not null then 1 else 0 end) as ready,
            sum(case when t.embedding_blob is null then 1 else 0 end) as awaiting_audio
          from tracks t
          left join findings f on f.track_id = t.track_id
          where ${anchor.sql}`,
  });
  const row = typedRow<AnchorEmbeddingSplitRow>(result.rows);

  return { awaitingAudio: Number(row?.awaiting_audio ?? 0), ready: Number(row?.ready ?? 0) };
}

/**
 * The anchor RE-ASK BENCH — rows that WOULD be anchorable but were attempted inside the re-ask
 * window, so the sweep is sitting them out (not re-billing them) for now. This is the exact
 * COMPLEMENT of `kindClause("anchor")`'s window guard: same base guards (un-anchored, measurable
 * length, not dismissed, not a known duplicate), and attempted INSIDE the window rather than
 * before it. The window is the SHARED `ANCHOR_REASK_AFTER_DAYS`, so the bench and the queue move
 * on the same clock.
 */
async function countAnchorBackoff(): Promise<number> {
  const cutoff = new Date(Date.now() - ANCHOR_REASK_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const db = await getDb();
  const result = await db.execute({
    args: [cutoff],
    sql: `select count(*) as n
          from tracks t
          left join findings f on f.track_id = t.track_id
          where f.track_id is null
            and t.spotify_uri is null
            and t.duration_ms > 0
            and t.dismissed_at is null
            and t.duplicate_of_track_id is null
            and t.spotify_anchor_attempted_at is not null
            and t.spotify_anchor_attempted_at >= ?`,
  });

  return Number(typedRows<{ n: number }>(result.rows)[0]?.n ?? 0);
}

/** The full ordered arg list for one snapshot upsert — the counts in a fixed column order. */
function snapshotArgs(row: CatalogueSnapshotRow): (number | string)[] {
  return [
    row.day,
    row.crawled,
    row.anchored,
    row.captured,
    row.analyzed,
    row.embedded,
    row.recEligible,
    row.certified,
    row.anchorQueueIsrc,
    row.anchorQueueNoIsrc,
    row.anchorBackoff,
    row.captureQueue,
    row.analyzeQueue,
    row.embedQueue,
    row.frontierDone,
    row.frontierPending,
    row.createdAt,
  ];
}

/**
 * Compute the live counts and UPSERT one row for the UTC day. Idempotent per day: a second call
 * the same day OVERWRITES the row with fresh counts (the daily snapshot never doubles a bar).
 * Returns the row written. AGENT-tier op body.
 */
export async function recordCatalogueSnapshot(
  options: { day?: string; now?: Date } = {},
): Promise<CatalogueSnapshotRow> {
  const now = options.now ?? new Date();
  const day = options.day ?? now.toISOString().slice(0, 10);
  const counts = await computeCatalogueSnapshotCounts();
  const row: CatalogueSnapshotRow = { ...counts, createdAt: now.toISOString(), day };
  const db = await getDb();

  await db.execute({
    args: snapshotArgs(row),
    sql: `insert into catalogue_snapshots
            (day, crawled, anchored, captured, analyzed, embedded, rec_eligible, certified,
             anchor_queue_isrc, anchor_queue_no_isrc, anchor_backoff,
             capture_queue, analyze_queue, embed_queue, frontier_done, frontier_pending, created_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(day) do update set
            crawled = excluded.crawled,
            anchored = excluded.anchored,
            captured = excluded.captured,
            analyzed = excluded.analyzed,
            embedded = excluded.embedded,
            rec_eligible = excluded.rec_eligible,
            certified = excluded.certified,
            anchor_queue_isrc = excluded.anchor_queue_isrc,
            anchor_queue_no_isrc = excluded.anchor_queue_no_isrc,
            anchor_backoff = excluded.anchor_backoff,
            capture_queue = excluded.capture_queue,
            analyze_queue = excluded.analyze_queue,
            embed_queue = excluded.embed_queue,
            frontier_done = excluded.frontier_done,
            frontier_pending = excluded.frontier_pending,
            created_at = excluded.created_at`,
  });

  return row;
}

type SnapshotDbRow = {
  analyze_queue: number;
  analyzed: number;
  anchor_backoff: number;
  anchor_queue_isrc: number;
  anchor_queue_no_isrc: number;
  anchored: number;
  capture_queue: number;
  captured: number;
  certified: number;
  created_at: string;
  crawled: number;
  day: string;
  embed_queue: number;
  embedded: number;
  frontier_done: number;
  frontier_pending: number;
  rec_eligible: number;
};

/**
 * The bounded snapshot series, oldest-first. A plain ASC index walk on the `day` PK
 * (`where day >= ? order by day asc`) — `day` is lexicographic-equals-chronological, so the
 * range seek is the window and no `desc()` index is needed (the ratified trap). Cut in SQL.
 */
async function readSnapshotSeries(windowDays: number): Promise<CatalogueSnapshotRow[]> {
  const cutoff = new Date(Date.now() - (windowDays - 1) * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const db = await getDb();
  const result = await db.execute({
    args: [cutoff],
    sql: `select day, crawled, anchored, captured, analyzed, embedded, rec_eligible, certified,
            anchor_queue_isrc, anchor_queue_no_isrc, anchor_backoff,
            capture_queue, analyze_queue, embed_queue, frontier_done, frontier_pending, created_at
          from catalogue_snapshots
          where day >= ?
          order by day asc`,
  });

  return typedRows<SnapshotDbRow>(result.rows).map((row) => ({
    analyzeQueue: Number(row.analyze_queue),
    analyzed: Number(row.analyzed),
    anchorBackoff: Number(row.anchor_backoff),
    anchorQueueIsrc: Number(row.anchor_queue_isrc),
    anchorQueueNoIsrc: Number(row.anchor_queue_no_isrc),
    anchored: Number(row.anchored),
    captureQueue: Number(row.capture_queue),
    captured: Number(row.captured),
    certified: Number(row.certified),
    crawled: Number(row.crawled),
    createdAt: row.created_at,
    day: row.day,
    embedQueue: Number(row.embed_queue),
    embedded: Number(row.embedded),
    frontierDone: Number(row.frontier_done),
    frontierPending: Number(row.frontier_pending),
    recEligible: Number(row.rec_eligible),
  }));
}

/**
 * The one-call read behind `/admin/funnel`: the live stages + queues + meters computed NOW,
 * plus the bounded day-by-day series read back from the ledger. `get_funnel` handler body.
 */
export async function getFunnel(windowDays?: number): Promise<FunnelView> {
  const window = clampSnapshotWindow(windowDays);
  const [counts, anchorEmbeddingSplit, captureState, series] = await Promise.all([
    computeCatalogueSnapshotCounts(),
    countAnchorQueueByEmbedding(),
    getCatalogueCaptureState(),
    readSnapshotSeries(window),
  ]);

  return {
    live: {
      meters: {
        anchorBackoff: counts.anchorBackoff,
        captureBudget: {
          dailyBytes: captureState.budget.dailyBytes,
          dailyTracks: captureState.budget.dailyTracks,
          open: captureState.open,
          paused: captureState.paused,
          remainingBytes: captureState.remainingBytes,
          remainingTracks: captureState.remainingTracks,
          windowHours: captureState.windowHours,
        },
        frontierPending: counts.frontierPending,
      },
      queues: {
        analyzeQueue: counts.analyzeQueue,
        anchorBackoff: counts.anchorBackoff,
        anchorQueueAwaitingAudio: anchorEmbeddingSplit.awaitingAudio,
        anchorQueueIsrc: counts.anchorQueueIsrc,
        anchorQueueNoIsrc: counts.anchorQueueNoIsrc,
        anchorQueueReady: anchorEmbeddingSplit.ready,
        captureQueue: counts.captureQueue,
        embedQueue: counts.embedQueue,
      },
      stages: {
        analyzed: counts.analyzed,
        anchored: counts.anchored,
        captured: counts.captured,
        certified: counts.certified,
        crawled: counts.crawled,
        embedded: counts.embedded,
        recEligible: counts.recEligible,
      },
    },
    series,
  };
}
