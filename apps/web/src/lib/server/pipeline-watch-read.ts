import { isCatalogueCaptureOpen } from "./capture-budget";
import { getDb, typedRows } from "./db";
import { isTrackWorkDueCutoverEnabled } from "./due-work-cutover";
import { PENDING_TRACK_SOURCE_MARKERS_SQL } from "./due-work-source-repair";
import { countTrackWork } from "./track-work";

export type BoundedCount = { atLeast: boolean; count: number };

export type PipelineWatchRead = {
  anchors: BoundedCount;
  capture: BoundedCount | null;
  frontier: BoundedCount;
  storable: BoundedCount;
  unstorable: BoundedCount;
};

export const PIPELINE_WATCH_LIMITS = {
  anchors: 1_000,
  capture: 2_000,
  frontier: 1_000,
  storable: 1,
  unstorable: 5_000,
} as const;

const PHYSICAL_REPAIR_PROBE_LIMIT = 1_000;

export async function readPipelineWatch(): Promise<PipelineWatchRead> {
  const db = await getDb();
  const bounded = async (
    sql: string,
    limit: number,
    args: Array<number | string> = [],
  ): Promise<BoundedCount> => {
    const result = await db.execute({ args: [...args, limit], sql });
    const count = Number(typedRows<{ n: number }>(result.rows)[0]?.n ?? 0);
    return { atLeast: count === limit, count };
  };

  const capture = async (): Promise<BoundedCount | null> => {
    if (!(await isTrackWorkDueCutoverEnabled())) {
      return { atLeast: false, count: await countTrackWork({ kind: "capture", scope: "all" }) };
    }
    const kinds = (await isCatalogueCaptureOpen())
      ? ["capture-findings", "capture-catalogue"]
      : ["capture-findings"];
    const placeholders = kinds.map(() => "?").join(", ");
    const repair = await db.execute({
      args: [...kinds, PHYSICAL_REPAIR_PROBE_LIMIT],
      sql: `select count(*) as scanned,
          coalesce(sum(work_kind in (${placeholders})), 0) as capture_repairs
        from (
          select work_kind from due_work indexed by due_work_repair_idx
          where state = 'repair' and subject_type = 'track'
          limit ?)`,
    });
    const repairRow = typedRows<{ capture_repairs: number; scanned: number }>(repair.rows)[0];
    if (
      Number(repairRow?.scanned ?? 0) >= PHYSICAL_REPAIR_PROBE_LIMIT ||
      Number(repairRow?.capture_repairs ?? 0) > 0
    ) {
      return null;
    }
    const raw = await bounded(
      `select count(*) as n from (
        select 1 from due_work where work_kind in (${placeholders}) and state = 'ready'
        union all
        select 1 from due_work where work_kind in (${placeholders})
          and state = 'scheduled' and next_due_at <= ?
        limit ?)`,
      PIPELINE_WATCH_LIMITS.capture,
      [...kinds, ...kinds, new Date().toISOString()],
    );
    const sourceRepairs = await bounded(
      `select count(*) as n from (
        ${PENDING_TRACK_SOURCE_MARKERS_SQL}
        limit ?)`,
      PIPELINE_WATCH_LIMITS.capture,
    );
    if (sourceRepairs.atLeast) {
      return null;
    }
    const count = Math.max(0, raw.count - sourceRepairs.count);
    if (count === 0 && sourceRepairs.count > 0) {
      return null;
    }
    return { atLeast: raw.atLeast || sourceRepairs.count > 0, count };
  };

  const [frontier, anchors, storable, unstorable, captureCount] = await Promise.all([
    bounded(
      `select count(*) as n from (
        select 1 from crawl_frontier where state = 'pending' limit ?)`,
      PIPELINE_WATCH_LIMITS.frontier,
    ),
    bounded(
      `select count(*) as n from (
        select 1 from tracks indexed by tracks_anchor_queue_idx
        where isrc is not null and spotify_uri is null
          and not exists (select 1 from findings where findings.track_id = tracks.track_id)
        limit ?)`,
      PIPELINE_WATCH_LIMITS.anchors,
    ),
    bounded(
      `select count(*) as n from (
        select 1 from crawl_due_work indexed by crawl_due_work_release_ready_idx
        where state = 'ready' and node_kind = 'release' and storable_rank = 0
        limit ?)`,
      PIPELINE_WATCH_LIMITS.storable,
    ),
    bounded(
      `select count(*) as n from (
        select 1 from crawl_due_work indexed by crawl_due_work_release_ready_idx
        where state = 'ready' and node_kind = 'release' and storable_rank = 1
        limit ?)`,
      PIPELINE_WATCH_LIMITS.unstorable,
    ),
    capture(),
  ]);
  return { anchors, capture: captureCount, frontier, storable, unstorable };
}
