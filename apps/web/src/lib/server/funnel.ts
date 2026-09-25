import { countIndexableAlbums } from "./albums";
import { countIndexableArtists } from "./artists";
import { REC_ELIGIBLE_WHERE } from "../catalogue-eligibility";
import { type CatalogueCaptureState, getCatalogueCaptureState } from "./capture-budget";
import { getFrontierCounts } from "./crawl";
import { getDb, typedRow, typedRows } from "./db";
import { countIndexableLabels } from "./labels";
import { clampSnapshotWindow } from "./snapshot-window";
import { ANCHOR_REASK_AFTER_DAYS, countTrackWork, kindClause, workHalfClause } from "./track-work";
import { readDefaultTracksHubTotal } from "./tracks-hub";

export type FunnelStages = {
  analyzed: number;

  anchored: number;

  captured: number;

  certified: number;

  crawled: number;

  embedded: number;

  recEligible: number;
};

export type FunnelQueues = {
  analyzeQueue: number;

  anchorBackoff: number;

  anchorQueueIsrc: number;

  anchorQueueNoIsrc: number;

  captureQueue: number;

  embedQueue: number;
};

export type FunnelLiveQueues = FunnelQueues & {
  anchorQueueAwaitingAudio: number;
  anchorQueueReady: number;
};

export type CaptureBacklogTier = {
  anchored: number;

  tier: number;

  unanchored: number;
};

export type CaptureBacklog = {
  authorized: number;

  authorizedAnchored: number;

  budgetOpen: boolean;

  tiers: CaptureBacklogTier[];
};

export type CatalogueSnapshotCounts = FunnelStages &
  FunnelQueues & { frontierDone: number; frontierPending: number };

export type CatalogueSnapshotRow = CatalogueSnapshotCounts & {
  createdAt: string;
  day: string;
};

export type PublicSurfaceCounts = {
  albums: number;
  artists: number;
  labels: number;
  tracks: number;
};

export type FunnelMeters = {
  anchorBackoff: number;

  captureBudget: {
    dailyBytes: number;
    dailyTracks: number;
    open: boolean;
    paused: boolean;
    remainingBytes: number;
    remainingTracks: number;
    windowHours: number;
  };

  frontierPending: number;
};

export type FunnelView = {
  live: {
    captureBacklog: CaptureBacklog;
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

type AnchorSplit = {
  awaitingAudio: number;
  ready: number;
  withIsrc: number;
  withoutIsrc: number;
};

type StageScanCounts = {
  analyzed: number;
  anchored: number;
  captured: number;
  certified: number;
  crawled: number;
  embedded: number;
  recEligible: number;
};

type FoldedFunnelScan = {
  anchorBackoff: number;
  anchorSplit: AnchorSplit;
  stages: StageScanCounts;
};

const MIRROR_REWRITES = [
  "f.track_id is not null => t.is_catalogue = 0",
  "f.track_id is null => t.is_catalogue = 1",
  "emb.track_id is not null => t.has_embedding = 1",
  "emb.track_id is null => t.has_embedding = 0",
] as const;

function onMirrors(fragment: string): string {
  let rewritten = fragment;

  for (const rule of MIRROR_REWRITES) {
    const [canonical, mirrored] = rule.split(" => ");

    if (canonical === undefined || mirrored === undefined) {
      throw new Error(`funnel: malformed mirror rewrite rule "${rule}"`);
    }

    rewritten = rewritten.replaceAll(canonical, mirrored);
  }

  if (rewritten.includes("f.") || rewritten.includes("emb.")) {
    throw new Error(
      "funnel: a shared predicate no longer reduces to the stored `is_catalogue` / `has_embedding` mirrors, so the covering stage scan cannot be built from it",
    );
  }

  return rewritten;
}

const STAGE_SCAN_SELECT = `sum(case when f.track_id is null then 1 else 0 end) as crawled,
            sum(case when f.track_id is null and t.spotify_uri is not null then 1 else 0 end) as anchored,
            sum(case when f.track_id is null and t.source_audio_key is not null then 1 else 0 end) as captured,
            sum(case when f.track_id is null and t.analyzed_from = 'full' then 1 else 0 end) as analyzed,
            sum(case when f.track_id is null and emb.track_id is not null then 1 else 0 end) as embedded,
            sum(case when ${REC_ELIGIBLE_WHERE} then 1 else 0 end) as rec_eligible,
            sum(case when f.track_id is not null then 1 else 0 end) as certified`;

const ANCHOR_BACKOFF_WHERE = `f.track_id is null
            and t.spotify_uri is null
            and t.duration_ms > 0
            and t.dismissed_at is null
            and t.duplicate_of_track_id is null
            and t.spotify_anchor_attempted_at is not null
            and t.spotify_anchor_attempted_at >= ?`;

function anchorBackoffCutoff(): string {
  return new Date(Date.now() - ANCHOR_REASK_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function mapStageRow(row: StageRow | undefined): StageScanCounts {
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

function anchorSplitFromRow(row: AnchorSplitRow | undefined): AnchorSplit {
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

export function foldedFunnelScanStatement(): { args: string[]; sql: string } {
  const anchor = kindClause("anchor");
  const selectList = `${STAGE_SCAN_SELECT},
            sum(case when (${anchor.sql}) and t.isrc is not null and emb.track_id is not null then 1 else 0 end) as isrc_ready,
            sum(case when (${anchor.sql}) and t.isrc is not null and emb.track_id is null then 1 else 0 end) as isrc_awaiting,
            sum(case when (${anchor.sql}) and t.isrc is null and emb.track_id is not null then 1 else 0 end) as no_isrc_ready,
            sum(case when (${anchor.sql}) and t.isrc is null and emb.track_id is null then 1 else 0 end) as no_isrc_awaiting,
            sum(case when (${ANCHOR_BACKOFF_WHERE}) then 1 else 0 end) as anchor_backoff`;

  return {
    args: [...anchor.args, ...anchor.args, ...anchor.args, ...anchor.args, anchorBackoffCutoff()],
    sql: `select ${onMirrors(selectList)}
          from tracks t`,
  };
}

export async function runFoldedFunnelScan(): Promise<FoldedFunnelScan> {
  const db = await getDb();
  const result = await db.execute(foldedFunnelScanStatement());
  const row = typedRow<AnchorSplitRow & StageRow & { anchor_backoff: number | null }>(result.rows);

  return {
    anchorBackoff: Number(row?.anchor_backoff ?? 0),
    anchorSplit: anchorSplitFromRow(row),
    stages: mapStageRow(row),
  };
}

export function catalogueCaptureBacklogStatement(): { args: string[]; sql: string } {
  const capture = kindClause("capture");

  return {
    args: capture.args,
    sql: `select t.capture_priority as tier,
            sum(case when t.spotify_uri is not null then 1 else 0 end) as anchored,
            sum(case when t.spotify_uri is null then 1 else 0 end) as unanchored
          from tracks t
          left join findings f on f.track_id = t.track_id
          where ${workHalfClause("capture", "catalogue")} and ${capture.sql}
          group by t.capture_priority`,
  };
}

type CaptureBacklogDbRow = {
  anchored: number | null;
  tier: number | null;
  unanchored: number | null;
};

export async function readCatalogueCaptureBacklog(
  captureState: CatalogueCaptureState,
): Promise<CaptureBacklog> {
  const db = await getDb();
  const result = await db.execute(catalogueCaptureBacklogStatement());
  const tiers = typedRows<CaptureBacklogDbRow>(result.rows)
    .map((row) => ({
      anchored: Number(row.anchored ?? 0),
      tier: Number(row.tier ?? 0),
      unanchored: Number(row.unanchored ?? 0),
    }))
    .sort((left, right) => right.tier - left.tier);

  return {
    authorized: tiers.reduce((total, row) => total + row.anchored + row.unanchored, 0),
    authorizedAnchored: tiers.reduce((total, row) => total + row.anchored, 0),
    budgetOpen: captureState.open,
    tiers,
  };
}

async function countPublicTracks(): Promise<number> {
  const db = await getDb();
  return readDefaultTracksHubTotal(db);
}

type LiveFunnelData = {
  anchorAwaitingAudio: number;
  anchorReady: number;

  captureBacklog: CaptureBacklog;

  captureState: CatalogueCaptureState;
  counts: CatalogueSnapshotCounts;

  publicSurfaces: PublicSurfaceCounts;
};

async function gatherSnapshotReads(captureState?: CatalogueCaptureState): Promise<{
  anchorSplit: AnchorSplit;
  counts: CatalogueSnapshotCounts;
}> {
  const [scan, captureQueue, analyzeQueue, embedQueue, frontier] = await Promise.all([
    runFoldedFunnelScan(),
    countTrackWork({ captureState, kind: "capture", scope: "catalogue" }),
    countTrackWork({ kind: "analyze", scope: "catalogue" }),
    countTrackWork({ kind: "embed", scope: "catalogue" }),

    getFrontierCounts(),
  ]);

  const { anchorSplit, stages } = scan;

  return {
    anchorSplit,
    counts: {
      analyzeQueue,
      analyzed: stages.analyzed,
      anchorBackoff: scan.anchorBackoff,
      anchorQueueIsrc: anchorSplit.withIsrc,
      anchorQueueNoIsrc: anchorSplit.withoutIsrc,
      anchored: stages.anchored,
      captureQueue,
      captured: stages.captured,
      certified: stages.certified,
      crawled: stages.crawled,
      embedQueue,
      embedded: stages.embedded,
      frontierDone: frontier.frontier.done,
      frontierPending: frontier.frontier.pending,
      recEligible: stages.recEligible,
    },
  };
}

async function gatherLiveFunnel(): Promise<LiveFunnelData> {
  const state = await getCatalogueCaptureState();

  const [snapshot, captureBacklog, publicTracks, publicArtists, publicAlbums, publicLabels] =
    await Promise.all([
      gatherSnapshotReads(state),

      readCatalogueCaptureBacklog(state),

      countPublicTracks(),
      countIndexableArtists(),
      countIndexableAlbums(),
      countIndexableLabels(),
    ]);

  return {
    anchorAwaitingAudio: snapshot.anchorSplit.awaitingAudio,
    anchorReady: snapshot.anchorSplit.ready,
    captureBacklog,
    captureState: state,
    counts: snapshot.counts,
    publicSurfaces: {
      albums: publicAlbums,
      artists: publicArtists,
      labels: publicLabels,
      tracks: publicTracks,
    },
  };
}

export async function computeCatalogueSnapshotCounts(): Promise<CatalogueSnapshotCounts> {
  return (await gatherSnapshotReads()).counts;
}

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

const SNAPSHOT_CATCHUP_GRACE_HOURS = 6;

function previousDay(day: string): string {
  const midnight = new Date(`${day}T00:00:00.000Z`).valueOf();

  if (!Number.isFinite(midnight)) {
    return day;
  }

  return new Date(midnight - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export type CatalogueSnapshotWrite = {
  backfilledDays: string[];
  snapshot: CatalogueSnapshotRow;
};

async function upsertSnapshot(row: CatalogueSnapshotRow): Promise<void> {
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
}

async function snapshotExists(day: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({
    args: [day],
    sql: `select 1 as n from catalogue_snapshots where day = ?`,
  });

  return typedRows<{ n: number }>(result.rows).length > 0;
}

export async function recordCatalogueSnapshot(
  options: { day?: string; now?: Date } = {},
): Promise<CatalogueSnapshotWrite> {
  const now = options.now ?? new Date();
  const day = options.day ?? now.toISOString().slice(0, 10);
  const counts = await computeCatalogueSnapshotCounts();
  const createdAt = now.toISOString();
  const row: CatalogueSnapshotRow = { ...counts, createdAt, day };

  await upsertSnapshot(row);

  const backfilledDays: string[] = [];
  const hoursIntoDay = (now.valueOf() - new Date(`${day}T00:00:00.000Z`).valueOf()) / 3_600_000;
  const gap = previousDay(day);

  if (
    options.day === undefined &&
    hoursIntoDay >= 0 &&
    hoursIntoDay < SNAPSHOT_CATCHUP_GRACE_HOURS &&
    gap !== day &&
    !(await snapshotExists(gap))
  ) {
    const db = await getDb();

    await db.execute({
      args: snapshotArgs({ ...counts, createdAt, day: gap }),
      sql: `insert into catalogue_snapshots
              (day, crawled, anchored, captured, analyzed, embedded, rec_eligible, certified,
               anchor_queue_isrc, anchor_queue_no_isrc, anchor_backoff,
               capture_queue, analyze_queue, embed_queue, frontier_done, frontier_pending, created_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(day) do nothing`,
    });
    backfilledDays.push(gap);
  }

  return { backfilledDays, snapshot: row };
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

function buildLiveBlock(data: LiveFunnelData): FunnelView["live"] {
  const { counts } = data;

  return {
    captureBacklog: data.captureBacklog,
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

export async function getFunnel(windowDays?: number): Promise<FunnelView> {
  const window = clampSnapshotWindow(windowDays);
  const [data, series] = await Promise.all([gatherLiveFunnel(), readSnapshotSeries(window)]);

  return { live: buildLiveBlock(data), series };
}
