import { type Client, type InStatement, type ResultSet } from "@libsql/client";

import {
  fanOutCrawlProjectionRepairs,
  repairCrawlDueNodes,
  runCrawlDueRebuildChunk,
} from "./crawl-due-work";
import { CRAWL_DUE_CUTOVER_ENABLED_KEY } from "./crawl-cutover";
import { repairDueWorkChunk, runDueWorkRebuildChunk } from "./due-work";
import { DUE_WORK_BACKFILLS, dueWorkRepairDefinitions } from "./due-work-registry";
import { fanOutDueWorkSourceRepairs } from "./due-work-source-repair";
import { TRACK_WORK_DUE_CUTOVER_ENABLED_KEY } from "./due-work-cutover";
import {
  PUBLIC_ANCHOR_FORMAT_VERSION,
  readTrackAnchorSourcePage,
  repairPublicProjectionChunk,
  runPublicProjectionRebuildChunk,
  type PublicProjectionName,
} from "./public-projections";
import {
  advanceProjectionAudit,
  clearProjectionAuditEvidence,
  PROJECTION_AUDIT_SETTING_KEYS,
  readProjectionAuditEvidence,
  type ProjectionAuditEvidence,
  type ProjectionAuditTarget,
} from "./projection-audit";
import {
  PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY,
  readCurrentProjectedTrackHubAnchors,
} from "./public-projection-cutover";
import { type HubPageAnchor } from "./hub-page-anchors";
import { CRAWL_DUE_AUDIT_FENCE_KEY, TRACK_DUE_AUDIT_FENCE_KEY } from "./projection-fences";
import { TRACKS_HUB_ANCHOR_ADDRESS, TRACKS_HUB_PAGE_SIZE } from "./tracks-hub";

export type ProjectionTarget =
  | "artist_qualification"
  | "crawl_due_work"
  | "public_aggregates"
  | "track_due_work";
export type ProjectionCutover = "crawl_due_work" | "public_projections" | "track_due_work";
export type ProjectionStepAction = "audit" | "rebuild" | "repair";

type ProjectionClient = Pick<Client, "batch" | "execute">;
export const PROJECTION_STATUS_COUNT_LIMIT = 100;

export type BoundedCount = { count: number; truncated: boolean };

type RebuildStatus = {
  complete: boolean;
  completed: number;
  projected: number;
  running: number;
  scanned: number;
  total: number;
};

type FamilyStatus = {
  backlog: { leased: BoundedCount; ready: BoundedCount; scheduled: BoundedCount };
  convergence: {
    digestMatched: boolean | null;
    epochMatched: boolean | null;
    projectedDigest: null | string;
    projectedEpoch: null | number;
    sourceDigest: null | string;
    sourceEpoch: null | number;
  };
  ready: boolean;
  rebuild: RebuildStatus;
  repairs: { direct: BoundedCount; fanout: BoundedCount; total: BoundedCount };
};

export type ProjectionStatus = {
  cutovers: {
    crawlDueWork: boolean;
    publicProjections: boolean;
    trackDueWork: boolean;
  };
  projections: {
    artistQualification: FamilyStatus;
    crawlDueWork: FamilyStatus;
    publicAggregates: FamilyStatus & { anchorsReady: boolean };
    trackDueWork: FamilyStatus;
  };
  readyToOpen: {
    crawlDueWork: boolean;
    publicProjections: boolean;
    trackDueWork: boolean;
  };
};

function boundedCount(rows: readonly unknown[]): BoundedCount {
  return {
    count: Math.min(rows.length, PROJECTION_STATUS_COUNT_LIMIT),
    truncated: rows.length > PROJECTION_STATUS_COUNT_LIMIT,
  };
}

function addBoundedCounts(left: BoundedCount, right: BoundedCount): BoundedCount {
  const count = left.count + right.count;
  return {
    count: Math.min(count, PROJECTION_STATUS_COUNT_LIMIT),
    truncated: left.truncated || right.truncated || count > PROJECTION_STATUS_COUNT_LIMIT,
  };
}

function emptyBoundedCount(): BoundedCount {
  return { count: 0, truncated: false };
}

function emptyRebuild(total = 1): RebuildStatus {
  return { complete: false, completed: 0, projected: 0, running: 0, scanned: 0, total };
}

function digest(value: unknown): null | string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function boolSetting(rows: readonly unknown[], key: string): boolean {
  const row = (rows as { key: string; value: string }[]).find((candidate) => candidate.key === key);
  return row?.value === "true";
}

function integerSetting(rows: readonly unknown[], key: string): number {
  const row = (rows as { key: string; value: string }[]).find((candidate) => candidate.key === key);
  const value = Number(row?.value ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : -1;
}

function publicFamily(
  state: Record<string, unknown> | undefined,
  repairs: BoundedCount,
  epochColumn: "aggregate_epoch" | "projection_epoch",
  audit: ProjectionAuditEvidence | undefined,
): FamilyStatus {
  const sourceDigest = digest(audit?.sourceDigest);
  const projectedDigest = digest(audit?.projectedDigest);
  const sourceEpoch = state === undefined ? null : Number(state["source_epoch"] ?? 0);
  const projectedEpoch = state === undefined ? null : Number(state[epochColumn] ?? 0);
  const complete = state?.["state"] === "complete";
  const digestMatched =
    audit?.complete === true &&
    audit.matched &&
    sourceDigest !== null &&
    sourceDigest === projectedDigest &&
    audit.sourceEpoch === sourceEpoch &&
    audit.sourceFence === sourceEpoch &&
    (epochColumn !== "aggregate_epoch" ||
      (audit.anchorGeneration === state?.["generation"] &&
        audit.anchorOrderEpoch === Number(state?.["release_hub_order_epoch"] ?? -1)));
  const epochMatched =
    sourceEpoch === null || projectedEpoch === null ? false : sourceEpoch === projectedEpoch;
  const rebuild = state
    ? {
        complete,
        completed: complete ? 1 : 0,
        projected: Number(state["projected_count"] ?? 0),
        running: state["state"] === "running" ? 1 : 0,
        scanned: Number(state["scanned_count"] ?? 0),
        total: 1,
      }
    : emptyRebuild();
  return {
    backlog: {
      leased: emptyBoundedCount(),
      ready: emptyBoundedCount(),
      scheduled: emptyBoundedCount(),
    },
    convergence: {
      digestMatched,
      epochMatched,
      projectedDigest,
      projectedEpoch,
      sourceDigest,
      sourceEpoch,
    },
    ready: complete && digestMatched && epochMatched && repairs.count === 0,
    rebuild,
    repairs: { direct: repairs, fanout: emptyBoundedCount(), total: repairs },
  };
}

async function anchorsReady(client: ProjectionClient): Promise<boolean> {
  return (
    (await readCurrentProjectedTrackHubAnchors(
      client,
      TRACKS_HUB_ANCHOR_ADDRESS,
      TRACKS_HUB_PAGE_SIZE,
    )) !== undefined
  );
}

async function hasPublicProjectionRepairDebt(
  client: ProjectionClient,
  projection: PublicProjectionName,
): Promise<boolean> {
  const result = await client.execute({
    args: [projection],
    sql: `select 1 from projection_repairs indexed by projection_repairs_order_idx
      where projection = ?
      order by projection, source_epoch, subject_type, subject_id limit 1`,
  });
  return result.rows.length > 0;
}

async function publicProjectionEpochMatched(
  client: ProjectionClient,
  projection: PublicProjectionName,
): Promise<boolean> {
  const result =
    projection === "public_aggregates"
      ? await client.execute(`select 1 from public_aggregate_state
          where scope = 'tracks' and state = 'complete' and aggregate_epoch = source_epoch limit 1`)
      : await client.execute(`select 1 from artist_qualification_state
          where scope = 'artists' and state = 'complete' and projection_epoch = source_epoch limit 1`);
  return result.rows.length > 0;
}

async function assertProjectionAuditReady(
  client: ProjectionClient,
  target: ProjectionTarget,
): Promise<void> {
  const cutoverKey =
    target === "track_due_work"
      ? TRACK_WORK_DUE_CUTOVER_ENABLED_KEY
      : target === "crawl_due_work"
        ? CRAWL_DUE_CUTOVER_ENABLED_KEY
        : PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY;
  const statements: InStatement[] = [
    {
      args: [cutoverKey],
      sql: `select value from settings where key = ? limit 1`,
    },
  ];
  if (target === "track_due_work") {
    statements.push(
      { args: [], sql: `select state from due_work_rebuilds` },
      {
        args: [],
        sql: `select 1 from due_work indexed by due_work_repair_idx
          where state = 'repair' limit 1`,
      },
    );
  } else if (target === "crawl_due_work") {
    statements.push(
      {
        args: [],
        sql: `select state from crawl_due_work_rebuilds where scope = 'frontier' limit 1`,
      },
      {
        args: [],
        sql: `select 1 from crawl_due_work indexed by crawl_due_work_repair_idx
          where state = 'repair' limit 1`,
      },
      {
        args: [],
        sql: `select 1 from crawl_projection_repairs indexed by crawl_projection_repairs_order_idx
          order by source_epoch, source_type, source_id limit 1`,
      },
    );
  } else {
    const stateTable =
      target === "public_aggregates" ? "public_aggregate_state" : "artist_qualification_state";
    const scope = target === "public_aggregates" ? "tracks" : "artists";
    statements.push(
      {
        args: [],
        sql: `select state from ${stateTable} where scope = '${scope}' limit 1`,
      },
      {
        args: [target],
        sql: `select 1 from projection_repairs indexed by projection_repairs_order_idx
          where projection = ? order by projection, source_epoch, subject_type, subject_id limit 1`,
      },
    );
  }
  const results = await client.batch(statements);
  const cutoverOpen = results[0]?.rows[0]?.value === "true";
  const rebuildRows = results[1]?.rows ?? [];
  const rebuildComplete =
    target === "track_due_work"
      ? rebuildRows.length === DUE_WORK_BACKFILLS.length &&
        rebuildRows.every((row) => row.state === "complete")
      : rebuildRows[0]?.state === "complete";
  const repairDebt = results.slice(2).some((result) => result.rows.length > 0);
  if (cutoverOpen || !rebuildComplete || repairDebt) {
    throw new Error("projection audit requires a dark, rebuilt target with no repair debt");
  }
}

function trackFamilyStatus(
  results: readonly ResultSet[],
  audit: ProjectionAuditEvidence | undefined,
  sourceFence: number,
): FamilyStatus {
  const rows = results[12]?.rows as unknown as
    | { projected_count: number; scanned_count: number; state: string }[]
    | undefined;
  const completed = rows?.filter((row) => row.state === "complete").length ?? 0;
  const running = rows?.filter((row) => row.state === "running").length ?? 0;
  const repairRows = results[4]?.rows ?? [];
  const repairTruncated = repairRows.length > PROJECTION_STATUS_COUNT_LIMIT;
  const visibleRepairRows = repairRows.slice(0, PROJECTION_STATUS_COUNT_LIMIT) as unknown as {
    work_kind: string;
  }[];
  const direct: BoundedCount = {
    count: visibleRepairRows.filter((row) => row.work_kind !== "source-repair").length,
    truncated: repairTruncated,
  };
  const fanout: BoundedCount = {
    count: visibleRepairRows.filter((row) => row.work_kind === "source-repair").length,
    truncated: repairTruncated,
  };
  const total = boundedCount(repairRows);
  const rebuild: RebuildStatus = {
    complete: completed === DUE_WORK_BACKFILLS.length,
    completed,
    projected: (rows ?? []).reduce((sum, row) => sum + Number(row.projected_count), 0),
    running,
    scanned: (rows ?? []).reduce((sum, row) => sum + Number(row.scanned_count), 0),
    total: DUE_WORK_BACKFILLS.length,
  };
  const sourceDigest = digest(audit?.sourceDigest);
  const projectedDigest = digest(audit?.projectedDigest);
  const digestMatched =
    audit?.complete === true &&
    audit.matched &&
    sourceDigest !== null &&
    sourceDigest === projectedDigest &&
    audit.sourceFence === sourceFence;
  return {
    backlog: {
      leased: boundedCount(results[3]?.rows ?? []),
      ready: boundedCount(results[1]?.rows ?? []),
      scheduled: boundedCount(results[2]?.rows ?? []),
    },
    convergence: {
      digestMatched,
      epochMatched: null,
      projectedDigest,
      projectedEpoch: null,
      sourceDigest,
      sourceEpoch: null,
    },
    ready: rebuild.complete && total.count === 0 && digestMatched,
    rebuild,
    repairs: { direct, fanout, total },
  };
}

function crawlFamilyStatus(
  results: readonly ResultSet[],
  audit: ProjectionAuditEvidence | undefined,
  sourceFence: number,
): FamilyStatus {
  const row = results[13]?.rows[0] as Record<string, unknown> | undefined;
  const direct = boundedCount(results[8]?.rows ?? []);
  const fanout = boundedCount(results[9]?.rows ?? []);
  const total = addBoundedCounts(direct, fanout);
  const sourceDigest = digest(audit?.sourceDigest);
  const projectedDigest = digest(audit?.projectedDigest);
  const digestMatched =
    audit?.complete === true &&
    audit.matched &&
    sourceDigest !== null &&
    sourceDigest === projectedDigest &&
    audit.sourceFence === sourceFence;
  const complete = row?.["state"] === "complete";
  return {
    backlog: {
      leased: boundedCount(results[7]?.rows ?? []),
      ready: boundedCount(results[5]?.rows ?? []),
      scheduled: boundedCount(results[6]?.rows ?? []),
    },
    convergence: {
      digestMatched,
      epochMatched: null,
      projectedDigest,
      projectedEpoch: null,
      sourceDigest,
      sourceEpoch: null,
    },
    ready: complete && digestMatched && total.count === 0,
    rebuild: row
      ? {
          complete,
          completed: complete ? 1 : 0,
          projected: Number(row["projected_count"] ?? 0),
          running: row["state"] === "running" ? 1 : 0,
          scanned: Number(row["scanned_count"] ?? 0),
          total: 1,
        }
      : emptyRebuild(),
    repairs: { direct, fanout, total },
  };
}

/** Read aggregate operational metadata only; no source rows or identifiers leave this function. */
export async function getProjectionStatusFor(client: ProjectionClient): Promise<ProjectionStatus> {
  const [trackAudit, crawlAudit, aggregateAudit, artistAudit] = await Promise.all([
    readProjectionAuditEvidence(client, "track_due_work"),
    readProjectionAuditEvidence(client, "crawl_due_work"),
    readProjectionAuditEvidence(client, "public_aggregates"),
    readProjectionAuditEvidence(client, "artist_qualification"),
  ]);
  const results = await client.batch([
    {
      args: [
        CRAWL_DUE_CUTOVER_ENABLED_KEY,
        CRAWL_DUE_AUDIT_FENCE_KEY,
        PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY,
        TRACK_DUE_AUDIT_FENCE_KEY,
        TRACK_WORK_DUE_CUTOVER_ENABLED_KEY,
      ],
      sql: `select key, value from settings where key in (?, ?, ?, ?, ?)`,
    },
    {
      args: [PROJECTION_STATUS_COUNT_LIMIT + 1],
      sql: `select 1 from due_work indexed by due_work_ready_idx
        where state = 'ready' limit ?`,
    },
    {
      args: [PROJECTION_STATUS_COUNT_LIMIT + 1],
      sql: `select 1 from due_work indexed by due_work_scheduled_idx
        where state = 'scheduled' limit ?`,
    },
    {
      args: [PROJECTION_STATUS_COUNT_LIMIT + 1],
      sql: `select 1 from due_work indexed by due_work_lease_idx
        where state = 'leased' limit ?`,
    },
    {
      args: [PROJECTION_STATUS_COUNT_LIMIT + 1],
      sql: `select work_kind from due_work indexed by due_work_repair_idx
        where state = 'repair' limit ?`,
    },
    {
      args: [PROJECTION_STATUS_COUNT_LIMIT + 1],
      sql: `select 1 from crawl_due_work indexed by crawl_due_work_ready_idx
        where state = 'ready' limit ?`,
    },
    {
      args: [PROJECTION_STATUS_COUNT_LIMIT + 1],
      sql: `select 1 from crawl_due_work indexed by crawl_due_work_scheduled_idx
        where state = 'scheduled' limit ?`,
    },
    {
      args: [PROJECTION_STATUS_COUNT_LIMIT + 1],
      sql: `select 1 from crawl_due_work indexed by crawl_due_work_lease_idx
        where state = 'leased' limit ?`,
    },
    {
      args: [PROJECTION_STATUS_COUNT_LIMIT + 1],
      sql: `select 1 from crawl_due_work indexed by crawl_due_work_repair_idx
        where state = 'repair' limit ?`,
    },
    {
      args: [PROJECTION_STATUS_COUNT_LIMIT + 1],
      sql: `select 1 from crawl_projection_repairs indexed by crawl_projection_repairs_order_idx
        order by source_epoch, source_type, source_id limit ?`,
    },
    {
      args: [PROJECTION_STATUS_COUNT_LIMIT + 1],
      sql: `select 1 from projection_repairs indexed by projection_repairs_order_idx
        where projection = 'public_aggregates'
        order by projection, source_epoch, subject_type, subject_id limit ?`,
    },
    {
      args: [PROJECTION_STATUS_COUNT_LIMIT + 1],
      sql: `select 1 from projection_repairs indexed by projection_repairs_order_idx
        where projection = 'artist_qualification'
        order by projection, source_epoch, subject_type, subject_id limit ?`,
    },
    { args: [], sql: `select state, scanned_count, projected_count from due_work_rebuilds` },
    {
      args: [],
      sql: `select state, scanned_count, projected_count, source_digest, projected_digest
        from crawl_due_work_rebuilds where scope = 'frontier'`,
    },
    {
      args: [],
      sql: `select state, scanned_count, projected_entry_count as projected_count,
        source_digest, projected_digest, source_epoch, aggregate_epoch, generation,
        release_hub_order_epoch
        from public_aggregate_state where scope = 'tracks'`,
    },
    {
      args: [],
      sql: `select state, scanned_count, projected_qualified_count as projected_count,
        source_digest, projected_digest, source_epoch, projection_epoch
        from artist_qualification_state where scope = 'artists'`,
    },
  ]);

  const settingRows = results[0]?.rows ?? [];
  const track = trackFamilyStatus(
    results,
    trackAudit,
    integerSetting(settingRows, TRACK_DUE_AUDIT_FENCE_KEY),
  );
  const crawl = crawlFamilyStatus(
    results,
    crawlAudit,
    integerSetting(settingRows, CRAWL_DUE_AUDIT_FENCE_KEY),
  );

  const aggregates = publicFamily(
    results[14]?.rows[0] as Record<string, unknown> | undefined,
    boundedCount(results[10]?.rows ?? []),
    "aggregate_epoch",
    aggregateAudit,
  );
  const anchorProof = await anchorsReady(client);
  const publicAggregates = { ...aggregates, anchorsReady: anchorProof };
  publicAggregates.ready = publicAggregates.ready && anchorProof;
  const artistQualification = publicFamily(
    results[15]?.rows[0] as Record<string, unknown> | undefined,
    boundedCount(results[11]?.rows ?? []),
    "projection_epoch",
    artistAudit,
  );
  const publicReady = publicAggregates.ready && artistQualification.ready;
  return {
    cutovers: {
      crawlDueWork: boolSetting(settingRows, CRAWL_DUE_CUTOVER_ENABLED_KEY),
      publicProjections: boolSetting(settingRows, PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY),
      trackDueWork: boolSetting(settingRows, TRACK_WORK_DUE_CUTOVER_ENABLED_KEY),
    },
    projections: {
      artistQualification,
      crawlDueWork: crawl,
      publicAggregates,
      trackDueWork: track,
    },
    readyToOpen: {
      crawlDueWork: crawl.ready,
      publicProjections: publicReady,
      trackDueWork: track.ready,
    },
  };
}

const TRACK_REBUILD_CYCLE_KEY = "projection_rebuild_track_cycle_v1";

async function advanceTrackRebuild(client: ProjectionClient, limit: number, restart: boolean) {
  const cycleResult = await client.execute({
    args: [TRACK_REBUILD_CYCLE_KEY],
    sql: `select value from settings where key = ?`,
  });
  let cycle = Number(cycleResult.rows[0]?.value ?? -1);
  if (restart && (!Number.isSafeInteger(cycle) || cycle < 0)) {
    cycle = 0;
    await client.execute({
      args: [TRACK_REBUILD_CYCLE_KEY, "0"],
      sql: `insert into settings (key, value) values (?, ?)
        on conflict(key) do update set value = excluded.value`,
    });
  }
  if (Number.isSafeInteger(cycle) && cycle >= 0) {
    const definition = DUE_WORK_BACKFILLS[cycle];
    if (definition === undefined) {
      await client.execute({
        args: [TRACK_REBUILD_CYCLE_KEY],
        sql: `delete from settings where key = ?`,
      });
      return { complete: true, processed: 0, scheduled: 0 };
    }
    const checkpoint = await client.execute({
      args: [definition.workKind, definition.subjectType],
      sql: `select state from due_work_rebuilds where work_kind = ? and subject_type = ?`,
    });
    const result = await runDueWorkRebuildChunk(client, definition, {
      boundedCleanup: true,
      limit,
      newGeneration: checkpoint.rows[0]?.state === "complete",
    });
    if (result.complete) {
      const next = cycle + 1;
      if (next >= DUE_WORK_BACKFILLS.length) {
        await client.execute({
          args: [TRACK_REBUILD_CYCLE_KEY],
          sql: `delete from settings where key = ?`,
        });
        return { complete: true, processed: result.scanned, scheduled: 0 };
      }
      await client.execute({
        args: [String(next), TRACK_REBUILD_CYCLE_KEY],
        sql: `update settings set value = ? where key = ?`,
      });
    }
    return { complete: false, processed: result.scanned, scheduled: 0 };
  }
  for (const definition of DUE_WORK_BACKFILLS) {
    const checkpoint = await client.execute({
      args: [definition.workKind, definition.subjectType],
      sql: `select state from due_work_rebuilds where work_kind = ? and subject_type = ?`,
    });
    if (checkpoint.rows[0]?.state === "complete") {
      continue;
    }
    const result = await runDueWorkRebuildChunk(client, definition, {
      boundedCleanup: true,
      limit,
    });
    return { complete: false, processed: result.scanned, scheduled: 0 };
  }
  return { complete: true, processed: 0, scheduled: 0 };
}

async function advanceTrackRepair(client: ProjectionClient, limit: number) {
  const sourceCount = await client.execute(
    `select 1 from due_work
      where work_kind = 'source-repair' and state = 'repair' limit 1`,
  );
  if (sourceCount.rows.length > 0) {
    const result = await fanOutDueWorkSourceRepairs(client, { limit });
    return {
      complete: !result.hasMore && result.expanded === 0,
      processed: result.scanned,
      scheduled: result.expanded,
    };
  }
  for (const definition of dueWorkRepairDefinitions(client)) {
    const pending = await client.execute({
      args: [definition.workKind, definition.subjectType],
      sql: `select 1 from due_work where work_kind = ? and subject_type = ? and state = 'repair' limit 1`,
    });
    if (pending.rows.length === 0) {
      continue;
    }
    const result = await repairDueWorkChunk(client, definition, { limit });
    return { complete: !result.hasMore, processed: result.scanned, scheduled: 0 };
  }
  return { complete: true, processed: 0, scheduled: 0 };
}

const PUBLIC_ANCHOR_REBUILD_KEY = "projection_rebuild_public_anchors_v1";
const PUBLIC_ANCHOR_CLEANUP_KEY = "projection_cleanup_public_anchor_generations_v1";
const PUBLIC_ANCHOR_ROLLBACK_KEY = "projection_public_anchor_rollback_generation_v1";
const PUBLIC_ANCHOR_RESTART_PREFIX = "projection_restart_public_anchors_v1:";
const PUBLIC_ANCHOR_SOURCE_READY_SQL = `exists (select 1 from public_aggregate_state aggregate
  where aggregate.scope = 'tracks' and aggregate.state = 'complete'
    and aggregate.generation = ? and aggregate.release_hub_order_epoch = ?
    and aggregate.aggregate_epoch = aggregate.source_epoch
    and not exists (select 1 from projection_repairs
      indexed by projection_repairs_order_idx where projection = 'public_aggregates'))`;

type AnchorRebuildState = {
  cursorId: null | string;
  cursorKey: null | string;
  firstId: null | string;
  generation: string;
  orderEpoch: number;
  phase: "non_null" | "null";
  processed: number;
  shard: number;
  version: 2;
};

type AnchorProjectionState = {
  generation: string;
  orderEpoch: number;
  total: number;
};

async function currentAnchorDocumentMatches(
  client: ProjectionClient,
  projection: AnchorProjectionState,
): Promise<boolean> {
  const document = await readCurrentProjectedTrackHubAnchors(
    client,
    TRACKS_HUB_ANCHOR_ADDRESS,
    TRACKS_HUB_PAGE_SIZE,
  );
  if (document === undefined) {
    return false;
  }
  const current = await client.execute({
    args: [
      TRACKS_HUB_ANCHOR_ADDRESS.hub,
      TRACKS_HUB_ANCHOR_ADDRESS.clauseHash,
      PUBLIC_ANCHOR_FORMAT_VERSION,
      projection.generation,
      projection.orderEpoch,
      projection.total,
    ],
    sql: `select 1 from public_aggregate_state aggregate
      join hub_page_anchor_validity validity
        on validity.hub = ? and validity.clause_hash = ?
       and validity.anchor_format_version = ?
       and validity.generation = aggregate.generation
       and validity.order_epoch = aggregate.release_hub_order_epoch
      where aggregate.scope = 'tracks' and aggregate.state = 'complete'
        and aggregate.aggregate_epoch = aggregate.source_epoch
        and aggregate.generation = ? and aggregate.release_hub_order_epoch = ?
        and aggregate.default_track_total = ?
        and not exists (select 1 from projection_repairs
          indexed by projection_repairs_order_idx where projection = 'public_aggregates')
      limit 1`,
  });
  return current.rows.length > 0;
}

function anchorProjectionState(row: unknown): AnchorProjectionState | undefined {
  if (row === undefined) {
    return undefined;
  }
  const candidate = row as Record<string, unknown>;
  const generation = candidate["generation"];
  const orderEpoch = Number(candidate["release_hub_order_epoch"]);
  const total = Number(candidate["default_track_total"]);
  if (
    typeof generation !== "string" ||
    generation.length === 0 ||
    generation.includes(":") ||
    !Number.isSafeInteger(orderEpoch) ||
    orderEpoch < 0 ||
    !Number.isSafeInteger(total) ||
    total < 0
  ) {
    throw new Error("public anchor rebuild projection state is malformed");
  }
  return { generation, orderEpoch, total };
}

function hasValidAnchorIdentity(state: Record<string, unknown>): boolean {
  const generation = state["generation"];
  const orderEpoch = state["orderEpoch"];
  const phase = state["phase"];
  return (
    state["version"] === 2 &&
    typeof generation === "string" &&
    generation.length > 0 &&
    !generation.includes(":") &&
    typeof orderEpoch === "number" &&
    Number.isSafeInteger(orderEpoch) &&
    orderEpoch >= 0 &&
    (phase === "non_null" || phase === "null")
  );
}

function hasValidAnchorProgress(state: Record<string, unknown>): boolean {
  const processed = state["processed"];
  const shard = state["shard"];
  return (
    typeof processed === "number" &&
    Number.isSafeInteger(processed) &&
    processed >= 0 &&
    typeof shard === "number" &&
    Number.isSafeInteger(shard) &&
    shard >= 0 &&
    shard <= processed
  );
}

function hasValidAnchorCursor(state: Record<string, unknown>): boolean {
  const cursorId = state["cursorId"];
  const cursorKey = state["cursorKey"];
  const firstId = state["firstId"];
  return (
    (cursorId === null || (typeof cursorId === "string" && cursorId.length > 0)) &&
    (cursorKey === null || typeof cursorKey === "string") &&
    (firstId === null || (typeof firstId === "string" && firstId.length > 0))
  );
}

function hasConsistentAnchorCursor(state: Record<string, unknown>): boolean {
  const { cursorId, cursorKey, firstId, phase, processed, shard } = state;
  if (processed === 0) {
    return (
      cursorId === null &&
      cursorKey === null &&
      firstId === null &&
      phase === "non_null" &&
      shard === 0
    );
  }
  return (
    cursorId !== null &&
    firstId !== null &&
    shard !== 0 &&
    (phase !== "non_null" || typeof cursorKey === "string") &&
    (phase !== "null" || cursorKey === null)
  );
}

function parseAnchorState(value: unknown): AnchorRebuildState | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const state = parsed as Record<string, unknown>;
    if (
      Object.keys(state).sort().join(",") !==
      "cursorId,cursorKey,firstId,generation,orderEpoch,phase,processed,shard,version"
    ) {
      return undefined;
    }
    if (
      !hasValidAnchorIdentity(state) ||
      !hasValidAnchorProgress(state) ||
      !hasValidAnchorCursor(state) ||
      !hasConsistentAnchorCursor(state)
    ) {
      return undefined;
    }
    return state as AnchorRebuildState;
  } catch {
    return undefined;
  }
}

type AnchorCleanupState = {
  currentGeneration: string;
  cursor: null | string;
  rollbackGeneration: null | string;
  version: 1;
};

function parseAnchorCleanupState(value: unknown): AnchorCleanupState | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const state = parsed as Record<string, unknown>;
    if (
      Object.keys(state).sort().join(",") !== "currentGeneration,cursor,rollbackGeneration,version"
    ) {
      return undefined;
    }
    const currentGeneration = state["currentGeneration"];
    const cursor = state["cursor"];
    const rollbackGeneration = state["rollbackGeneration"];
    const cursorPrefix = `${TRACKS_HUB_ANCHOR_ADDRESS.clauseHash}:`;
    return state["version"] === 1 &&
      typeof currentGeneration === "string" &&
      currentGeneration.length > 0 &&
      !currentGeneration.includes(":") &&
      (cursor === null ||
        (typeof cursor === "string" && cursor.startsWith(cursorPrefix) && cursor.length > 0)) &&
      (rollbackGeneration === null ||
        (typeof rollbackGeneration === "string" &&
          rollbackGeneration.length > 0 &&
          !rollbackGeneration.includes(":") &&
          rollbackGeneration !== currentGeneration))
      ? { currentGeneration, cursor, rollbackGeneration, version: 1 }
      : undefined;
  } catch {
    return undefined;
  }
}

function anchorGenerationPrefix(generation: string): string {
  return `${TRACKS_HUB_ANCHOR_ADDRESS.clauseHash}:${generation}:`;
}

function anchorCleanupState(
  value: unknown,
  generation: string,
  rollbackValue: unknown,
): AnchorCleanupState | undefined {
  const parsed = parseAnchorCleanupState(value);
  if (value === undefined || parsed !== undefined) {
    return parsed;
  }
  const rollbackGeneration =
    typeof rollbackValue === "string" &&
    rollbackValue.length > 0 &&
    !rollbackValue.includes(":") &&
    rollbackValue !== generation
      ? rollbackValue
      : null;
  return {
    currentGeneration: generation,
    cursor: null,
    rollbackGeneration,
    version: 1,
  };
}

function publishedAnchorIsCurrent(
  published: { anchor_format_version: number; generation: string; order_epoch: number } | undefined,
  projection: AnchorProjectionState,
): boolean {
  return (
    published?.generation === projection.generation &&
    Number(published.order_epoch) === projection.orderEpoch &&
    Number(published.anchor_format_version) === PUBLIC_ANCHOR_FORMAT_VERSION
  );
}

function anchorBuildState(
  saved: AnchorRebuildState | undefined,
  projection: AnchorProjectionState,
): AnchorRebuildState {
  if (
    saved !== undefined &&
    saved.generation === projection.generation &&
    saved.orderEpoch === projection.orderEpoch
  ) {
    return saved;
  }
  return {
    cursorId: null,
    cursorKey: null,
    firstId: null,
    generation: projection.generation,
    orderEpoch: projection.orderEpoch,
    phase: "non_null",
    processed: 0,
    shard: 0,
    version: 2,
  };
}

async function advanceAnchorGenerationCleanup(
  client: ProjectionClient,
  state: AnchorCleanupState,
  limit: number,
): Promise<{ complete: boolean; processed: number }> {
  const basePrefix = `${TRACKS_HUB_ANCHOR_ADDRESS.clauseHash}:`;
  const page = await client.execute({
    args: [
      TRACKS_HUB_ANCHOR_ADDRESS.hub,
      basePrefix,
      `${basePrefix}\uffff`,
      state.cursor ?? basePrefix,
      limit,
    ],
    sql: `select clause_hash from hub_page_anchors
      where hub = ? and clause_hash >= ? and clause_hash < ? and clause_hash > ?
      order by clause_hash limit ?`,
  });
  const clauseHashes = page.rows.flatMap((row) =>
    typeof row.clause_hash === "string" ? [row.clause_hash] : [],
  );
  const currentPrefix = anchorGenerationPrefix(state.currentGeneration);
  const rollbackPrefix =
    state.rollbackGeneration === null ? null : anchorGenerationPrefix(state.rollbackGeneration);
  const stale = clauseHashes.filter(
    (clauseHash) =>
      !clauseHash.startsWith(currentPrefix) &&
      (rollbackPrefix === null || !clauseHash.startsWith(rollbackPrefix)),
  );
  if (stale.length > 0) {
    const placeholders = stale.map(() => "?").join(", ");
    await client.execute({
      args: [TRACKS_HUB_ANCHOR_ADDRESS.hub, ...stale],
      sql: `delete from hub_page_anchors where hub = ? and clause_hash in (${placeholders})`,
    });
  }
  const terminal = clauseHashes.at(-1);
  if (terminal !== undefined) {
    await client.execute({
      args: [PUBLIC_ANCHOR_CLEANUP_KEY, JSON.stringify({ ...state, cursor: terminal })],
      sql: `insert into settings (key, value) values (?, ?)
        on conflict(key) do update set value = excluded.value`,
    });
    return { complete: false, processed: clauseHashes.length };
  }
  await client.execute({
    args: [PUBLIC_ANCHOR_CLEANUP_KEY],
    sql: `delete from settings where key = ?`,
  });
  return { complete: true, processed: 0 };
}

async function restartMalformedAnchorBuild(
  client: ProjectionClient,
  generation: string,
  limit: number,
): Promise<{ complete: boolean; processed: number }> {
  const restartKey = `${PUBLIC_ANCHOR_RESTART_PREFIX}${generation}`;
  const saved = await client.execute({
    args: [restartKey],
    sql: `select value from settings where key = ? limit 1`,
  });
  const prefix = anchorGenerationPrefix(generation);
  const upper = `${prefix}\uffff`;
  const savedCursor = saved.rows[0]?.value;
  const cursor =
    typeof savedCursor === "string" && savedCursor >= prefix && savedCursor < upper
      ? savedCursor
      : "";
  const page = await client.execute({
    args: [TRACKS_HUB_ANCHOR_ADDRESS.hub, prefix, upper, cursor, limit],
    sql: `select clause_hash from hub_page_anchors
      where hub = ? and clause_hash >= ? and clause_hash < ? and clause_hash > ?
      order by clause_hash limit ?`,
  });
  const clauseHashes = page.rows.flatMap((row) =>
    typeof row.clause_hash === "string" ? [row.clause_hash] : [],
  );
  if (clauseHashes.length > 0) {
    const placeholders = clauseHashes.map(() => "?").join(", ");
    const terminal = clauseHashes.at(-1) ?? cursor;
    await client.batch(
      [
        {
          args: [TRACKS_HUB_ANCHOR_ADDRESS.hub, ...clauseHashes],
          sql: `delete from hub_page_anchors where hub = ?
            and clause_hash in (${placeholders})`,
        },
        {
          args: [restartKey, terminal],
          sql: `insert into settings (key, value) values (?, ?)
            on conflict(key) do update set value = excluded.value`,
        },
      ],
      "write",
    );
    return { complete: false, processed: clauseHashes.length };
  }
  await client.batch(
    [
      { args: [PUBLIC_ANCHOR_REBUILD_KEY], sql: `delete from settings where key = ?` },
      { args: [restartKey], sql: `delete from settings where key = ?` },
    ],
    "write",
  );
  return { complete: false, processed: 0 };
}

function assertPublicAnchorLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("public anchor rebuild limit must be from 1 through 100");
  }
}

async function advanceCurrentAnchorCleanup(
  client: ProjectionClient,
  cleanup: AnchorCleanupState | undefined,
  limit: number,
  projectionState: AnchorProjectionState,
): Promise<{ complete: boolean; processed: number } | undefined> {
  if (cleanup?.currentGeneration !== projectionState.generation) {
    return undefined;
  }
  const result = await advanceAnchorGenerationCleanup(client, cleanup, limit);
  return result.complete
    ? { ...result, complete: await currentAnchorDocumentMatches(client, projectionState) }
    : result;
}

function rollbackGenerationFor(
  previousGeneration: unknown,
  savedRollback: unknown,
  generation: string,
): null | string {
  if (
    typeof previousGeneration === "string" &&
    previousGeneration.length > 0 &&
    previousGeneration !== generation &&
    !previousGeneration.includes(":")
  ) {
    return previousGeneration;
  }
  if (
    typeof savedRollback === "string" &&
    savedRollback.length > 0 &&
    !savedRollback.includes(":")
  ) {
    return savedRollback;
  }
  return null;
}

async function recoverPublicAnchorState(
  client: ProjectionClient,
  options: {
    generation: string;
    limit: number;
    persistedValue: unknown;
    projectionState: AnchorProjectionState;
    publishedCurrent: boolean;
    saved: ReturnType<typeof parseAnchorState>;
  },
): Promise<{ complete: boolean; processed: number } | undefined> {
  const { generation, limit, persistedValue, projectionState, publishedCurrent, saved } = options;
  const malformed =
    persistedValue !== undefined &&
    (saved === undefined ||
      (saved.generation === generation &&
        saved.orderEpoch === projectionState.orderEpoch &&
        saved.processed > projectionState.total));

  if (malformed) {
    if (publishedCurrent) {
      if (!(await currentAnchorDocumentMatches(client, projectionState))) {
        throw new Error("malformed published anchor state requires a fresh aggregate generation");
      }
      await client.execute({
        args: [PUBLIC_ANCHOR_REBUILD_KEY],
        sql: `delete from settings where key = ?`,
      });
      return { complete: true, processed: 0 };
    }
    return restartMalformedAnchorBuild(client, generation, limit);
  }

  if (
    saved !== undefined &&
    (saved.generation !== generation || saved.orderEpoch !== projectionState.orderEpoch)
  ) {
    await client.execute({
      args: [PUBLIC_ANCHOR_REBUILD_KEY],
      sql: `delete from settings where key = ?`,
    });
  }
  if (
    saved === undefined &&
    publishedCurrent &&
    (await currentAnchorDocumentMatches(client, projectionState))
  ) {
    return { complete: true, processed: 0 };
  }
  return undefined;
}

export async function advancePublicAnchors(
  client: ProjectionClient,
  limit: number,
): Promise<{ complete: boolean; processed: number }> {
  assertPublicAnchorLimit(limit);
  const [projection, persisted, cleanupResult, publishedResult, rollbackResult] = await Promise.all(
    [
      client.execute(`select default_track_total, generation, release_hub_order_epoch
      from public_aggregate_state aggregate
      where aggregate.scope = 'tracks' and aggregate.state = 'complete'
        and aggregate.aggregate_epoch = aggregate.source_epoch
        and not exists (select 1 from projection_repairs
          indexed by projection_repairs_order_idx where projection = 'public_aggregates')`),
      client.execute({
        args: [PUBLIC_ANCHOR_REBUILD_KEY],
        sql: `select value from settings where key = ?`,
      }),
      client.execute({
        args: [PUBLIC_ANCHOR_CLEANUP_KEY],
        sql: `select value from settings where key = ? limit 1`,
      }),
      client.execute({
        args: [TRACKS_HUB_ANCHOR_ADDRESS.hub, TRACKS_HUB_ANCHOR_ADDRESS.clauseHash],
        sql: `select anchor_format_version, generation, order_epoch
        from hub_page_anchor_validity where hub = ? and clause_hash = ? limit 1`,
      }),
      client.execute({
        args: [PUBLIC_ANCHOR_ROLLBACK_KEY],
        sql: `select value from settings where key = ? limit 1`,
      }),
    ],
  );
  const projectionState = anchorProjectionState(projection.rows[0]);
  if (projectionState === undefined) {
    return { complete: false, processed: 0 };
  }
  const { generation, orderEpoch, total } = projectionState;
  const cleanupValue = cleanupResult.rows[0]?.value;
  const cleanup = anchorCleanupState(cleanupValue, generation, rollbackResult.rows[0]?.value);
  const cleanupAdvance = await advanceCurrentAnchorCleanup(client, cleanup, limit, projectionState);
  if (cleanupAdvance !== undefined) {
    return cleanupAdvance;
  }
  const published = publishedResult.rows[0] as
    | { anchor_format_version: number; generation: string; order_epoch: number }
    | undefined;
  const publishedCurrent = publishedAnchorIsCurrent(published, projectionState);
  const persistedValue = persisted.rows[0]?.value;
  const saved = parseAnchorState(persistedValue);
  const recovered = await recoverPublicAnchorState(client, {
    generation,
    limit,
    persistedValue,
    projectionState,
    publishedCurrent,
    saved,
  });
  if (recovered !== undefined) {
    return recovered;
  }
  const state = anchorBuildState(saved, projectionState);
  const page = await readTrackAnchorSourcePage(
    client,
    { id: state.cursorId, key: state.cursorKey, phase: state.phase },
    limit,
  );
  const tracks = page.rows;
  const anchors: HubPageAnchor[] = [];
  for (const track of tracks) {
    state.processed += 1;
    const trackId = track.track_id;
    const releaseDate = track.release_date;
    state.firstId ??= trackId;
    if (state.processed % TRACKS_HUB_PAGE_SIZE === 0) {
      anchors.push({
        id: trackId,
        key: releaseDate,
        page: state.processed / TRACKS_HUB_PAGE_SIZE + 1,
      });
    }
  }
  state.cursorId = page.cursor.id;
  state.cursorKey = page.cursor.key;
  state.phase = page.cursor.phase;
  const current = await client.execute(`select generation, release_hub_order_epoch
    from public_aggregate_state aggregate
    where aggregate.scope = 'tracks' and aggregate.state = 'complete'
      and aggregate.aggregate_epoch = aggregate.source_epoch
      and not exists (select 1 from projection_repairs
        indexed by projection_repairs_order_idx where projection = 'public_aggregates')`);
  const currentRow = current.rows[0] as
    | { generation: string; release_hub_order_epoch: number }
    | undefined;
  if (
    currentRow === undefined ||
    currentRow.generation !== generation ||
    Number(currentRow.release_hub_order_epoch) !== orderEpoch
  ) {
    await client.execute({
      args: [PUBLIC_ANCHOR_REBUILD_KEY],
      sql: `delete from settings where key = ?`,
    });
    return { complete: false, processed: tracks.length };
  }
  const now = new Date().toISOString();
  const shardClauseHash = `${TRACKS_HUB_ANCHOR_ADDRESS.clauseHash}:${generation}:${String(
    state.shard,
  ).padStart(10, "0")}`;
  const shardStatement = {
    args: [
      TRACKS_HUB_ANCHOR_ADDRESS.hub,
      shardClauseHash,
      JSON.stringify(anchors),
      `${total}:${state.firstId ?? ""}:${state.shard}`,
      now,
      generation,
      orderEpoch,
    ],
    sql: `insert into hub_page_anchors
      (hub, clause_hash, anchors_json, fingerprint, computed_at)
      select ?, ?, ?, ?, ? where ${PUBLIC_ANCHOR_SOURCE_READY_SQL}
      on conflict(hub, clause_hash) do update set anchors_json = excluded.anchors_json,
        fingerprint = excluded.fingerprint, computed_at = excluded.computed_at`,
  };
  if (!page.complete) {
    state.shard += 1;
    const stateStatement = {
      args: [PUBLIC_ANCHOR_REBUILD_KEY, JSON.stringify(state), generation, orderEpoch],
      sql: `insert into settings (key, value)
        select ?, ? where ${PUBLIC_ANCHOR_SOURCE_READY_SQL}
        on conflict(key) do update set value = excluded.value`,
    };
    await client.batch(
      anchors.length > 0 ? [shardStatement, stateStatement] : [stateStatement],
      "write",
    );
    return { complete: false, processed: tracks.length };
  }
  if (state.processed !== total) {
    throw new Error("public anchor rebuild total changed without an order epoch change");
  }
  const statements: InStatement[] = [];
  if (anchors.length > 0 || state.processed < TRACKS_HUB_PAGE_SIZE) {
    statements.push(shardStatement);
  }
  const previousGeneration = published?.generation;
  const savedRollback = rollbackResult.rows[0]?.value;
  const rollbackGeneration = rollbackGenerationFor(previousGeneration, savedRollback, generation);
  if (rollbackGeneration !== null) {
    statements.push({
      args: [PUBLIC_ANCHOR_ROLLBACK_KEY, rollbackGeneration],
      sql: `insert into settings (key, value) values (?, ?)
        on conflict(key) do update set value = excluded.value`,
    });
  }
  const validityIndex = statements.length;
  statements.push(
    {
      args: [
        TRACKS_HUB_ANCHOR_ADDRESS.hub,
        TRACKS_HUB_ANCHOR_ADDRESS.clauseHash,
        PUBLIC_ANCHOR_FORMAT_VERSION,
        orderEpoch,
        generation,
        now,
        generation,
        orderEpoch,
      ],
      sql: `insert into hub_page_anchor_validity
          (hub, clause_hash, anchor_format_version, order_epoch, generation, published_at)
          select ?, ?, ?, ?, ?, ? where ${PUBLIC_ANCHOR_SOURCE_READY_SQL}
          on conflict(hub, clause_hash) do update set
            anchor_format_version = excluded.anchor_format_version,
            order_epoch = excluded.order_epoch, generation = excluded.generation,
            published_at = excluded.published_at`,
    },
    {
      args: [
        PUBLIC_ANCHOR_CLEANUP_KEY,
        JSON.stringify({
          currentGeneration: generation,
          cursor: null,
          rollbackGeneration,
          version: 1,
        } satisfies AnchorCleanupState),
        TRACKS_HUB_ANCHOR_ADDRESS.hub,
        TRACKS_HUB_ANCHOR_ADDRESS.clauseHash,
        generation,
        orderEpoch,
      ],
      sql: `insert into settings (key, value)
        select ?, ? where exists (select 1 from hub_page_anchor_validity
          where hub = ? and clause_hash = ? and generation = ? and order_epoch = ?)
        on conflict(key) do update set value = excluded.value`,
    },
    { args: [PUBLIC_ANCHOR_REBUILD_KEY], sql: `delete from settings where key = ?` },
  );
  const results = await client.batch(statements, "write");
  if ((results[validityIndex]?.rowsAffected ?? 0) === 0) {
    return { complete: false, processed: tracks.length };
  }
  return {
    complete: false,
    processed: tracks.length,
  };
}

type ProjectionAdvanceInput = {
  action: ProjectionStepAction;
  includeStatus?: boolean;
  limit: number;
  target: ProjectionTarget;
};

type ProjectionAdvanceOutcome = {
  complete: boolean;
  processed: number;
  scheduled: number;
};

async function advanceAuditProjection(
  client: ProjectionClient,
  input: ProjectionAdvanceInput,
  includeStatus: boolean,
): Promise<ProjectionAdvanceOutcome & { status: ProjectionStatus | undefined }> {
  await assertProjectionAuditReady(client, input.target);
  const audit = await advanceProjectionAudit(client, input.target, input.limit);
  if (audit.complete && !audit.matched) {
    throw new Error("projection audit completed with a digest mismatch; run a rebuild");
  }
  return {
    complete: audit.complete && audit.matched,
    processed: audit.processed,
    scheduled: 0,
    status: includeStatus ? await getProjectionStatusFor(client) : undefined,
  };
}

/** One request advances one fixed target through one explicitly bounded mutation page. */
export function advanceProjectionFor(
  client: ProjectionClient,
  input: ProjectionAdvanceInput & { includeStatus: false },
): Promise<ProjectionAdvanceOutcome & { status: undefined }>;
export function advanceProjectionFor(
  client: ProjectionClient,
  input: ProjectionAdvanceInput & { includeStatus?: true },
): Promise<ProjectionAdvanceOutcome & { status: ProjectionStatus }>;
export function advanceProjectionFor(
  client: ProjectionClient,
  input: ProjectionAdvanceInput,
): Promise<ProjectionAdvanceOutcome & { status: ProjectionStatus | undefined }>;
export async function advanceProjectionFor(
  client: ProjectionClient,
  input: ProjectionAdvanceInput,
): Promise<
  ProjectionAdvanceOutcome & {
    status: ProjectionStatus | undefined;
  }
> {
  const includeStatus = input.includeStatus !== false;
  const previousAudit =
    input.action === "rebuild"
      ? await readProjectionAuditEvidence(client, input.target)
      : undefined;
  if (input.action !== "audit") {
    await clearProjectionAuditEvidence(client, input.target);
  }
  let outcome: { complete: boolean; processed: number; scheduled: number };
  if (input.action === "audit") {
    return advanceAuditProjection(client, input, includeStatus);
  }
  if (input.target === "track_due_work") {
    outcome =
      input.action === "rebuild"
        ? await advanceTrackRebuild(client, input.limit, previousAudit?.complete === true)
        : await advanceTrackRepair(client, input.limit);
  } else if (input.target === "crawl_due_work") {
    if (input.action === "rebuild") {
      const result = await runCrawlDueRebuildChunk(client, {
        boundedCleanup: true,
        limit: input.limit,
        newGeneration: previousAudit?.complete === true,
      });
      outcome = { complete: result.complete, processed: result.scanned, scheduled: 0 };
    } else {
      const fanout = await fanOutCrawlProjectionRepairs(client, { limit: input.limit });
      if (!fanout.complete || fanout.expanded > 0) {
        outcome = {
          complete: false,
          processed: fanout.expanded,
          scheduled: fanout.expanded,
        };
      } else {
        const repair = await repairCrawlDueNodes(client, { limit: input.limit });
        outcome = { complete: !repair.hasMore, processed: repair.scanned, scheduled: 0 };
      }
    }
  } else {
    const projection = input.target as PublicProjectionName;
    if (input.action === "rebuild") {
      const result = await runPublicProjectionRebuildChunk(client, projection, {
        boundedCleanup: true,
        limit: input.limit,
        newGeneration: previousAudit?.complete === true,
      });
      if (projection === "public_aggregates" && result.complete && result.scanned === 0) {
        const anchors = await advancePublicAnchors(client, Math.min(input.limit, 100));
        outcome = {
          complete: anchors.complete,
          processed: anchors.processed,
          scheduled: 0,
        };
      } else {
        outcome = {
          complete: projection === "public_aggregates" ? false : result.complete,
          processed: result.scanned,
          scheduled: 0,
        };
      }
    } else {
      const repair = await repairPublicProjectionChunk(client, {
        limit: input.limit,
        projection,
      });
      const remainingDebt = await hasPublicProjectionRepairDebt(client, projection);
      const repairProcessed = repair.fanout + repair.repaired;
      const anchors =
        projection === "public_aggregates" && !remainingDebt && repairProcessed === 0
          ? await advancePublicAnchors(client, Math.min(input.limit, 100))
          : { complete: projection !== "public_aggregates", processed: 0 };
      const epochMatched =
        !remainingDebt && (await publicProjectionEpochMatched(client, projection));
      const status = includeStatus ? await getProjectionStatusFor(client) : undefined;
      const complete =
        !remainingDebt &&
        epochMatched &&
        (projection !== "public_aggregates" ||
          (anchors.complete &&
            (status === undefined || status.projections.publicAggregates.anchorsReady)));
      const response = {
        complete,
        processed: repairProcessed + anchors.processed,
        scheduled: repair.fanout,
      };
      return { ...response, status };
    }
  }
  return {
    ...outcome,
    status: includeStatus ? await getProjectionStatusFor(client) : undefined,
  };
}

const CUTOVER_KEYS: Record<ProjectionCutover, string> = {
  crawl_due_work: CRAWL_DUE_CUTOVER_ENABLED_KEY,
  public_projections: PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY,
  track_due_work: TRACK_WORK_DUE_CUTOVER_ENABLED_KEY,
};

function matchingAuditSql(alias: string, target: ProjectionAuditTarget): string {
  const auditVersion = target === "artist_qualification" ? 5 : 3;
  const sourceFence =
    target === "track_due_work" || target === "crawl_due_work"
      ? `and json_extract(${alias}.value, '$.sourceFence') = coalesce((select cast(fence.value as integer)
          from settings fence where fence.key = '${target === "track_due_work" ? TRACK_DUE_AUDIT_FENCE_KEY : CRAWL_DUE_AUDIT_FENCE_KEY}'
            and fence.value <> '' and fence.value not glob '*[^0-9]*'), 0)`
      : "";
  return `json_valid(${alias}.value)
    and json_extract(${alias}.value, '$.version') = ${auditVersion}
    and json_extract(${alias}.value, '$.target') = '${target}'
    and json_extract(${alias}.value, '$.complete') = 1
    and json_extract(${alias}.value, '$.matched') = 1
    and typeof(json_extract(${alias}.value, '$.sourceDigest')) = 'text'
    and length(json_extract(${alias}.value, '$.sourceDigest')) = 64
    and json_extract(${alias}.value, '$.sourceDigest') not glob '*[^0-9a-f]*'
    and typeof(json_extract(${alias}.value, '$.projectedDigest')) = 'text'
    and length(json_extract(${alias}.value, '$.projectedDigest')) = 64
    and json_extract(${alias}.value, '$.projectedDigest') not glob '*[^0-9a-f]*'
    and json_extract(${alias}.value, '$.sourceDigest') =
        json_extract(${alias}.value, '$.projectedDigest')
    ${sourceFence}`;
}

function openCutoverStatement(target: ProjectionCutover) {
  const key = CUTOVER_KEYS[target];
  if (target === "track_due_work") {
    const rebuildProof = DUE_WORK_BACKFILLS.map(
      () =>
        `exists (select 1 from due_work_rebuilds
          where work_kind = ? and subject_type = ? and state = 'complete')`,
    ).join(" and ");
    return {
      args: [
        key,
        PROJECTION_AUDIT_SETTING_KEYS.track_due_work,
        ...DUE_WORK_BACKFILLS.flatMap((definition) => [
          definition.workKind,
          definition.subjectType,
        ]),
      ],
      sql: `insert into settings (key, value)
        select ?, 'true' where
          exists (select 1 from settings audit where audit.key = ?
            and ${matchingAuditSql("audit", "track_due_work")})
          and not exists (select 1 from due_work indexed by due_work_repair_idx
            where state = 'repair')
          and ${rebuildProof}
          and (select count(*) from due_work_rebuilds) = ${DUE_WORK_BACKFILLS.length}
        on conflict(key) do update set value = excluded.value`,
    };
  }
  if (target === "crawl_due_work") {
    return {
      args: [key, PROJECTION_AUDIT_SETTING_KEYS.crawl_due_work],
      sql: `insert into settings (key, value)
        select ?, 'true' where
          exists (select 1 from settings audit where audit.key = ?
            and ${matchingAuditSql("audit", "crawl_due_work")})
          and exists (select 1 from crawl_due_work_rebuilds
            where scope = 'frontier' and state = 'complete')
          and not exists (select 1 from crawl_due_work indexed by crawl_due_work_repair_idx
            where state = 'repair')
          and not exists (select 1 from crawl_projection_repairs
            indexed by crawl_projection_repairs_order_idx)
        on conflict(key) do update set value = excluded.value`,
    };
  }
  return {
    args: [
      key,
      PROJECTION_AUDIT_SETTING_KEYS.public_aggregates,
      PROJECTION_AUDIT_SETTING_KEYS.artist_qualification,
      TRACKS_HUB_ANCHOR_ADDRESS.hub,
      TRACKS_HUB_ANCHOR_ADDRESS.clauseHash,
      PUBLIC_ANCHOR_FORMAT_VERSION,
      TRACKS_HUB_PAGE_SIZE,
      TRACKS_HUB_PAGE_SIZE,
      TRACKS_HUB_PAGE_SIZE,
      TRACKS_HUB_PAGE_SIZE,
      TRACKS_HUB_PAGE_SIZE,
    ],
    sql: `insert into settings (key, value)
      select ?, 'true' where
        exists (select 1 from public_aggregate_state aggregate
          where aggregate.scope = 'tracks' and aggregate.state = 'complete'
            and aggregate.aggregate_epoch = aggregate.source_epoch
            and not exists (select 1 from projection_repairs
              indexed by projection_repairs_order_idx
              where projection = 'public_aggregates')
            and exists (select 1 from settings audit where audit.key = ?
              and ${matchingAuditSql("audit", "public_aggregates")}
              and json_extract(audit.value, '$.sourceEpoch') = aggregate.source_epoch
              and json_extract(audit.value, '$.sourceFence') = aggregate.source_epoch
              and json_extract(audit.value, '$.anchorGeneration') = aggregate.generation
              and json_extract(audit.value, '$.anchorOrderEpoch') =
                aggregate.release_hub_order_epoch))
        and exists (select 1 from artist_qualification_state artist
          where artist.scope = 'artists' and artist.state = 'complete'
            and artist.projection_epoch = artist.source_epoch
            and not exists (select 1 from projection_repairs
              indexed by projection_repairs_order_idx
              where projection = 'artist_qualification')
            and exists (select 1 from settings audit where audit.key = ?
              and ${matchingAuditSql("audit", "artist_qualification")}
              and json_extract(audit.value, '$.sourceEpoch') = artist.source_epoch
              and json_extract(audit.value, '$.sourceFence') = artist.source_epoch))
        and exists (select 1 from public_aggregate_state aggregate
          join hub_page_anchor_validity validity
            on validity.hub = ? and validity.clause_hash = ?
           and validity.anchor_format_version = ?
           and validity.order_epoch = aggregate.release_hub_order_epoch
           and validity.generation = aggregate.generation
          where aggregate.scope = 'tracks' and aggregate.state = 'complete'
            and aggregate.aggregate_epoch = aggregate.source_epoch
            and exists (select 1 from hub_page_anchors shard
              where shard.hub = validity.hub
                and shard.clause_hash >= validity.clause_hash || ':' || validity.generation || ':'
                and shard.clause_hash < validity.clause_hash || ':' || validity.generation || ':\uffff')
            and not exists (select 1 from hub_page_anchors shard
              where shard.hub = validity.hub
                and shard.clause_hash >= validity.clause_hash || ':' || validity.generation || ':'
                and shard.clause_hash < validity.clause_hash || ':' || validity.generation || ':\uffff'
                and (not json_valid(shard.anchors_json)
                  or json_type(case when json_valid(shard.anchors_json)
                    then shard.anchors_json else 'null' end) <> 'array'))
            and (select count(*) from hub_page_anchors shard,
              json_each(case when json_valid(shard.anchors_json) then shard.anchors_json else '[]' end) item
              where shard.hub = validity.hub
                and shard.clause_hash >= validity.clause_hash || ':' || validity.generation || ':'
                and shard.clause_hash < validity.clause_hash || ':' || validity.generation || ':\uffff')
              = cast(aggregate.default_track_total / ? as integer)
            and not exists (select 1 from hub_page_anchors shard,
              json_each(case when json_valid(shard.anchors_json) then shard.anchors_json else '[]' end) item
              where shard.hub = validity.hub
                and shard.clause_hash >= validity.clause_hash || ':' || validity.generation || ':'
                and shard.clause_hash < validity.clause_hash || ':' || validity.generation || ':\uffff'
                and (json_type(item.value) <> 'object'
                  or typeof(json_extract(item.value, '$.id')) <> 'text'
                  or json_extract(item.value, '$.id') = ''
                  or json_type(item.value, '$.key') is null
                  or json_type(item.value, '$.key') not in ('null', 'text')
                  or typeof(json_extract(item.value, '$.page')) <> 'integer'))
            and coalesce((select count(distinct json_extract(item.value, '$.id'))
              from hub_page_anchors shard,
              json_each(case when json_valid(shard.anchors_json) then shard.anchors_json else '[]' end) item
              where shard.hub = validity.hub
                and shard.clause_hash >= validity.clause_hash || ':' || validity.generation || ':'
                and shard.clause_hash < validity.clause_hash || ':' || validity.generation || ':\uffff'), 0)
              = cast(aggregate.default_track_total / ? as integer)
            and coalesce((select count(distinct json_extract(item.value, '$.page'))
              from hub_page_anchors shard,
              json_each(case when json_valid(shard.anchors_json) then shard.anchors_json else '[]' end) item
              where shard.hub = validity.hub
                and shard.clause_hash >= validity.clause_hash || ':' || validity.generation || ':'
                and shard.clause_hash < validity.clause_hash || ':' || validity.generation || ':\uffff'), 0)
              = cast(aggregate.default_track_total / ? as integer)
            and (aggregate.default_track_total < ? or
              ((select min(json_extract(item.value, '$.page')) from hub_page_anchors shard,
                json_each(case when json_valid(shard.anchors_json) then shard.anchors_json else '[]' end) item
                where shard.hub = validity.hub
                  and shard.clause_hash >= validity.clause_hash || ':' || validity.generation || ':'
                  and shard.clause_hash < validity.clause_hash || ':' || validity.generation || ':\uffff') = 2
               and (select max(json_extract(item.value, '$.page')) from hub_page_anchors shard,
                json_each(case when json_valid(shard.anchors_json) then shard.anchors_json else '[]' end) item
                where shard.hub = validity.hub
                  and shard.clause_hash >= validity.clause_hash || ':' || validity.generation || ':'
                  and shard.clause_hash < validity.clause_hash || ':' || validity.generation || ':\uffff')
                 = cast(aggregate.default_track_total / ? as integer) + 1)))
      on conflict(key) do update set value = excluded.value`,
  };
}

/** Opening fails closed on current convergence; closing is always available as the rollback rail. */
export async function setProjectionCutoverFor(
  client: ProjectionClient,
  input: { enabled: boolean; target: ProjectionCutover },
): Promise<ProjectionStatus> {
  if (!input.enabled) {
    await client.execute({
      args: [CUTOVER_KEYS[input.target], "false"],
      sql: `insert into settings (key, value) values (?, ?)
        on conflict(key) do update set value = excluded.value`,
    });
    return getProjectionStatusFor(client);
  }
  if (input.target === "public_projections" && !(await anchorsReady(client))) {
    throw new Error(`${input.target} is not converged and cannot be opened`);
  }
  const results = await client.batch([openCutoverStatement(input.target)], "write");
  if ((results[0]?.rowsAffected ?? 0) !== 1) {
    throw new Error(`${input.target} is not converged and cannot be opened`);
  }
  return getProjectionStatusFor(client);
}
