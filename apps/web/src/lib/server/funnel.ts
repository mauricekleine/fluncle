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
//   - the frontier counts come from `getFrontierCounts` (crawl.ts) — the crawler's own lean read;
//   - the capture-budget meter comes from `getCatalogueCaptureState` (capture-budget.ts) —
//     the same readout `/admin/catalogue` renders and the brake obeys.
//
// ── TWO OPS ────────────────────────────────────────────────────────────────────────────
//   - `recordCatalogueSnapshot` (AGENT tier) — compute the live counts and UPSERT one row per
//     UTC day (`on conflict(day) do update`), so a re-fired daily tick overwrites rather than
//     doubles a bar. The on-box `fluncle-funnel-snapshot` timer fires it once a day; the row it
//     writes is the day-point the growth SERIES reads back — nothing on the read path depends on it.
//   - `getFunnel` (admin tier) — the live stages + queues + meters computed NOW (one
//     `gatherLiveFunnel` pass, every read run exactly once), plus the bounded day-by-day series
//     read back from the ledger (cut in SQL, plain ASC index walk on `day`).
//
// ── SCALE NOTE ────────────────────────────────────────────────────────────────────────
// The stage scan + anchor split are single-pass conditional-aggregates over `tracks left join
// findings` (never `union all` over a CTE — trap #4, docs/local-database.md). No vector or feature
// blob crosses the wire — an `embedding_blob is not null` test reads the cell's null flag, not its
// bytes. They ARE full scans of a growing table, computed live on every load: sub-second COUNT
// scans this admin page (a single operator, low QPS) pays honestly rather than serving a snapshot
// up to a day stale. Every other read here is either bounded (the queue counts ride their partial
// indexes) or on the small `crawl_frontier` / `catalogue_snapshots` tables.

import { countIndexableAlbums } from "./albums";
import { countIndexableArtists } from "./artists";
import { type CatalogueCaptureState, getCatalogueCaptureState } from "./capture-budget";
import { getFrontierCounts } from "./crawl";
import { getDb, typedRow, typedRows } from "./db";
import { countIndexableLabels } from "./labels";
import { REC_ELIGIBLE_WHERE } from "./recommendations";
import { clampSnapshotWindow } from "./snapshot-window";
import { ANCHOR_REASK_AFTER_DAYS, countTrackWork, kindClause } from "./track-work";
import { tracksHubCountQuery } from "./tracks-hub";

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

/**
 * How much of the archive is LIVE ON THE PUBLIC WEB right now — each number read through the SAME
 * predicate its public surface already obeys, so the card can never disagree with what a visitor or
 * a crawler actually sees:
 *   - `tracks` is the `/tracks` hub's own total (`countTracksHub({})` — every publicly-rendered row,
 *     findings + catalogue), so it matches the hub's masthead by construction.
 *   - `artists`/`albums`/`labels` are the INDEXABLE sets — entities whose page clears the
 *     thin-content floor (`HUB_RENDERABLE >= ARTIST/ALBUM/LABEL_INDEX_MIN…`), the exact rows the
 *     sitemap exposes (`countIndexableHubEntities`, reusing each hub's own scan + floor).
 * Live-only, like the stages/queues: computed on every load, never persisted to the snapshot series.
 */
export type PublicSurfaceCounts = {
  albums: number;
  artists: number;
  labels: number;
  tracks: number;
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
    publicSurfaces: PublicSurfaceCounts;
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

type AnchorSplitRow = {
  isrc_awaiting: number | null;
  isrc_ready: number | null;
  no_isrc_awaiting: number | null;
  no_isrc_ready: number | null;
};

/**
 * The drainable anchor worklist, partitioned BOTH ways from ONE pass: by ISRC (the two verification
 * paths — feeds the persisted `anchorQueueIsrc/NoIsrc`) and by embedding (ready vs awaiting audio —
 * the live-only refinement). The two partitions total the same whole queue by construction.
 */
type AnchorSplit = {
  awaitingAudio: number;
  ready: number;
  withIsrc: number;
  withoutIsrc: number;
};

/**
 * The drainable anchor worklist, partitioned ISRC × embedding in ONE pass. Reuses
 * `kindClause("anchor")` verbatim so the counts ARE the sweep's own worklist
 * (docs/catalogue-crawler.md § the anchor) — never a `union all` over a CTE (trap #4); four
 * conditional sums over one scan. `isrc is not null` gives the two verification paths (the persisted
 * `anchorQueueIsrc/NoIsrc`); `embedding_blob is not null` gives the ready/awaiting split (the live-only
 * refinement). Both partitions total the same whole queue by construction. `embedding_blob is not
 * null` reads the cell's null flag, not its bytes — no vector crosses the wire.
 */
async function countAnchorQueueSplit(): Promise<AnchorSplit> {
  const anchor = kindClause("anchor");
  const db = await getDb();
  const result = await db.execute({
    args: anchor.args,
    sql: `select
            sum(case when t.isrc is not null and t.embedding_blob is not null then 1 else 0 end) as isrc_ready,
            sum(case when t.isrc is not null and t.embedding_blob is null then 1 else 0 end) as isrc_awaiting,
            sum(case when t.isrc is null and t.embedding_blob is not null then 1 else 0 end) as no_isrc_ready,
            sum(case when t.isrc is null and t.embedding_blob is null then 1 else 0 end) as no_isrc_awaiting
          from tracks t
          left join findings f on f.track_id = t.track_id
          where ${anchor.sql}`,
  });
  const row = typedRow<AnchorSplitRow>(result.rows);
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

/**
 * The count of every publicly-rendered `/tracks` row — findings + catalogue — computed LIVE through
 * the `/tracks` hub's OWN count SQL (`tracksHubCountQuery({})`, no filter). Reusing the hub's exact
 * query builder means the card reports the same set the hub's masthead pages by, and — like the rest
 * of the funnel's live block — it is recomputed on every load rather than served from the hub's TTL
 * memo, so it never lags. `{}` compiles to a bare `select count(*) from tracks` (no join, no blob).
 */
async function countPublicTracks(): Promise<number> {
  const db = await getDb();
  const result = await db.execute(tracksHubCountQuery({}));

  return Number(typedRows<{ total: number }>(result.rows)[0]?.total ?? 0);
}

/** The full live computation, and the two live-only extras the persisted `counts` cannot carry. */
type LiveFunnelData = {
  /** The anchor worklist's embedding split (live-only; never persisted on the snapshot row). */
  anchorAwaitingAudio: number;
  anchorReady: number;
  /** The capture budget state, read ONCE here and threaded into the capture count + the meters. */
  captureState: CatalogueCaptureState;
  counts: CatalogueSnapshotCounts;
  /** How much is live on the public web now — live-only, never persisted to the snapshot series. */
  publicSurfaces: PublicSurfaceCounts;
};

/**
 * ONE full live computation — every read run exactly once: the stage scan, the anchor split (one
 * pass, both partitions), the re-ask bench, the three audio-queue counts, and the frontier group-bys.
 * The capture budget state is read once up front and threaded into the capture count (so
 * `getCatalogueCaptureState` is never read twice per request) and returned for the meters.
 *
 * Both `getFunnel` (the page read, live on every load) and `recordCatalogueSnapshot` (the daily cron)
 * call it; `computeCatalogueSnapshotCounts` returns its persisted subset for the cron's row.
 */
async function gatherLiveFunnel(captureState?: CatalogueCaptureState): Promise<LiveFunnelData> {
  const db = await getDb();
  const state = captureState ?? (await getCatalogueCaptureState());

  const [
    stages,
    anchorSplit,
    anchorBackoff,
    captureQueue,
    analyzeQueue,
    embedQueue,
    frontier,
    publicTracks,
    publicArtists,
    publicAlbums,
    publicLabels,
  ] = await Promise.all([
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
    // THE ANCHOR QUEUE — the sweep's OWN worklist predicate (`kindClause("anchor")`), partitioned
    // ISRC × embedding in one pass; the ISRC split persists, the embedding split rides live only.
    countAnchorQueueSplit(),
    // THE ANCHOR BENCH — rows benched by the 14-day re-ask window: the COMPLEMENT of the
    // `kindClause("anchor")` window guard (attempted, and inside the window). Its base guards
    // mirror that worklist; the window itself is the SHARED `ANCHOR_REASK_AFTER_DAYS` constant,
    // so the two can only ever disagree on the ISRC/duration edges, never on the window.
    countAnchorBackoff(),
    // The audio worklist backlogs — the product's OWN count function, brake and all. The capture
    // count reuses the state already read above so the brake is not read a second time (fix #4).
    countTrackWork({ captureState: state, kind: "capture", scope: "catalogue" }),
    countTrackWork({ kind: "analyze", scope: "catalogue" }),
    countTrackWork({ kind: "embed", scope: "catalogue" }),
    // The crawler's own frontier read — the lean two-group-by variant (no growing-table scans).
    getFrontierCounts(),
    // PUBLIC SURFACES — how much of the archive is live on the public web now, each through the
    // SAME predicate its surface already obeys. `tracks` is the `/tracks` hub's own count (`{}` =
    // no filter = every publicly-rendered row); the three entity counts are the sitemap's INDEXABLE
    // sets (`renderable >= floor`, reusing each hub's scan + floor). Cheap grouped COUNT scans over
    // the indexed join keys — same cost class as the stage/queue counts, no vector, no blob.
    countPublicTracks(),
    countIndexableArtists(),
    countIndexableAlbums(),
    countIndexableLabels(),
  ]);

  const stageRow = typedRow<StageRow>(stages.rows);

  return {
    anchorAwaitingAudio: anchorSplit.awaitingAudio,
    anchorReady: anchorSplit.ready,
    captureState: state,
    counts: {
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
      frontierDone: frontier.frontier.done,
      frontierPending: frontier.frontier.pending,
      recEligible: Number(stageRow?.rec_eligible ?? 0),
    },
    publicSurfaces: {
      albums: publicAlbums,
      artists: publicArtists,
      labels: publicLabels,
      tracks: publicTracks,
    },
  };
}

/**
 * The whole set of catalogue counts, each through the product's own predicate. The result is
 * exactly the row `recordCatalogueSnapshot` persists — the persisted subset of one live gather.
 */
export async function computeCatalogueSnapshotCounts(): Promise<CatalogueSnapshotCounts> {
  return (await gatherLiveFunnel()).counts;
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

/** One DB row → the typed snapshot row. Shared by the series walk and the latest-row read. */
function mapSnapshotRow(row: SnapshotDbRow): CatalogueSnapshotRow {
  return {
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
  };
}

const SNAPSHOT_COLUMNS = `day, crawled, anchored, captured, analyzed, embedded, rec_eligible, certified,
  anchor_queue_isrc, anchor_queue_no_isrc, anchor_backoff,
  capture_queue, analyze_queue, embed_queue, frontier_done, frontier_pending, created_at`;

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
    sql: `select ${SNAPSHOT_COLUMNS}
          from catalogue_snapshots
          where day >= ?
          order by day asc`,
  });

  return typedRows<SnapshotDbRow>(result.rows).map(mapSnapshotRow);
}

/** The capture-budget meter — the live readout the meters band renders. */
function captureBudgetMeter(state: CatalogueCaptureState): FunnelMeters["captureBudget"] {
  return {
    dailyBytes: state.budget.dailyBytes,
    dailyTracks: state.budget.dailyTracks,
    open: state.open,
    paused: state.paused,
    remainingBytes: state.remainingBytes,
    remainingTracks: state.remainingTracks,
    windowHours: state.windowHours,
  };
}

/** Project a stages-bearing row onto the bare `FunnelStages` shape (drops the queue/frontier cols). */
function stagesFrom(source: FunnelStages): FunnelStages {
  return {
    analyzed: source.analyzed,
    anchored: source.anchored,
    captured: source.captured,
    certified: source.certified,
    crawled: source.crawled,
    embedded: source.embedded,
    recEligible: source.recEligible,
  };
}

/** The live block — the freshly-computed counts, plus the live-only anchor embedding split. */
function buildLiveBlock(data: LiveFunnelData): FunnelView["live"] {
  const { counts } = data;

  return {
    meters: {
      anchorBackoff: counts.anchorBackoff,
      captureBudget: captureBudgetMeter(data.captureState),
      frontierPending: counts.frontierPending,
    },
    publicSurfaces: data.publicSurfaces,
    queues: {
      analyzeQueue: counts.analyzeQueue,
      anchorBackoff: counts.anchorBackoff,
      anchorQueueAwaitingAudio: data.anchorAwaitingAudio,
      anchorQueueIsrc: counts.anchorQueueIsrc,
      anchorQueueNoIsrc: counts.anchorQueueNoIsrc,
      anchorQueueReady: data.anchorReady,
      captureQueue: counts.captureQueue,
      embedQueue: counts.embedQueue,
    },
    stages: stagesFrom(counts),
  };
}

/**
 * The one-call read behind `/admin/funnel`: the live stages + queues + meters computed NOW (one
 * `gatherLiveFunnel` pass — every scan run exactly once), plus the bounded day-by-day series read
 * back from the ledger. The live block is always fresh: this is a single-operator admin page at low
 * QPS, and the block is a handful of sub-second COUNT scans, so it is computed on every load rather
 * than served from a stale daily snapshot. The series still comes from `catalogue_snapshots` (the
 * daily cron's row per UTC day) — that is the only thing the snapshot ledger backs. `get_funnel`
 * handler body.
 */
export async function getFunnel(windowDays?: number): Promise<FunnelView> {
  const window = clampSnapshotWindow(windowDays);
  const [data, series] = await Promise.all([gatherLiveFunnel(), readSnapshotSeries(window)]);

  return { live: buildLiveBlock(data), series };
}
