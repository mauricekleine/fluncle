import { type DueWorkReadRepairOutcome } from "./due-work-types";
import {
  clearDueWorkSourceRepairStatement,
  DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
  dueWorkCatalogueRankMarkerMaterialRevision,
  DueWorkMaintenancePendingError,
  DUE_WORK_SOURCE_REPAIR_KIND,
  listDueWorkSourceRepairs,
  MAX_DUE_WORK_CHUNK_SIZE,
  readDueWorkRebuild,
  repairDueWorkChunk,
  runDueWorkRebuildChunk,
  type DueWorkClient,
  type DueWorkProjection,
  type DueWorkRepairDefinition,
  type DueWorkRepairResult,
  type DueWorkRow,
  type DueWorkStatement,
  type DueWorkSubjectType,
} from "./due-work";
import { CATALOGUE_RANK_MATERIAL_REVISION_KEY } from "./catalogue";
import { getRequestScopedValue } from "./database-request-scope";
import {
  DUE_WORK_BACKFILLS,
  dueWorkRepairDefinitions,
  FINDING_DUE_WORK_KINDS,
  projectTrackDueWorkSourceRepairs,
  refreshDueWorkCatalogueRankCorpus,
} from "./due-work-registry";
import { DUE_WORK_TRACK_WORK_KIND_INVENTORY } from "./due-work-track-definitions";
import { DUE_WORK_VENDOR_WORK_KIND_INVENTORY } from "./due-work-vendor-definitions";
import { advanceProjectionFenceStatement, TRACK_DUE_AUDIT_FENCE_KEY } from "./projection-fences";

export const TRACK_SOURCE_REPAIR_FANOUT =
  DUE_WORK_TRACK_WORK_KIND_INVENTORY.length +
  DUE_WORK_VENDOR_WORK_KIND_INVENTORY.length +
  FINDING_DUE_WORK_KINDS.length;

export const SOURCE_REPAIR_LIMIT = Math.floor(MAX_DUE_WORK_CHUNK_SIZE / TRACK_SOURCE_REPAIR_FANOUT);
export const PHYSICAL_REPAIR_LIMIT = 50;

export const RANK_REBUILD_LIMIT = MAX_DUE_WORK_CHUNK_SIZE;

export const CATALOGUE_RANK_CORPUS_CHECK_KEY = "due_work_catalogue_rank_corpus_check_v1";

type CatalogueRankCorpusCheck = { generation: string; markerVersion: string };

function parseCatalogueRankCorpusCheck(value: unknown): CatalogueRankCorpusCheck | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as Partial<CatalogueRankCorpusCheck>;
    return typeof parsed.generation === "string" && typeof parsed.markerVersion === "string"
      ? { generation: parsed.generation, markerVersion: parsed.markerVersion }
      : undefined;
  } catch {
    return undefined;
  }
}

export type DueWorkSourceRepairResult = DueWorkRepairResult & {
  expanded: number;
  rankRebuildScanned: number;
};

async function readEntitySlugs(
  client: DueWorkClient,
  subjectType: Exclude<DueWorkSubjectType, "track">,
  subjectIds: readonly string[],
): Promise<Map<string, string>> {
  if (subjectIds.length === 0) {
    return new Map();
  }
  const placeholders = subjectIds.map(() => "?").join(", ");
  const result = await client.execute({
    args: [...subjectIds],
    sql: `select id, slug from ${subjectType}s where id in (${placeholders})`,
  });
  return new Map(
    result.rows.flatMap((row) =>
      typeof row.id === "string" && typeof row.slug === "string" ? [[row.id, row.slug]] : [],
    ),
  );
}

function usesSlugIdentity(workKind: string): boolean {
  return (
    workKind === "album.cover-master" ||
    workKind === "artist.cover-master" ||
    workKind === "label.image"
  );
}

type SourceRepairOutcome = {
  marker: DueWorkRow<typeof DUE_WORK_SOURCE_REPAIR_KIND>;
  physicalSubjectId: string;
  projection: DueWorkProjection<string> | null;
  workKind: string;
};

function markerForDefinition(
  marker: DueWorkRow<typeof DUE_WORK_SOURCE_REPAIR_KIND>,
  workKind: string,
  physicalSubjectId: string,
): DueWorkRow<string> {
  return { ...marker, subjectId: physicalSubjectId, workKind };
}

async function evaluateSourceMarkers(
  client: DueWorkClient,
  markers: readonly DueWorkRow<typeof DUE_WORK_SOURCE_REPAIR_KIND>[],
): Promise<SourceRepairOutcome[]> {
  const subjectTypes = new Set(markers.map((marker) => marker.subjectType));
  const registeredDefinitions = dueWorkRepairDefinitions(client);
  const definitions = registeredDefinitions.filter(
    (definition) => definition.subjectType !== "track" && subjectTypes.has(definition.subjectType),
  );
  const slugs = new Map<string, string>();
  for (const subjectType of ["album", "artist", "label"] as const) {
    const ids = markers
      .filter((marker) => marker.subjectType === subjectType)
      .map((marker) => marker.subjectId);
    for (const [id, slug] of await readEntitySlugs(client, subjectType, ids)) {
      slugs.set(`${subjectType}\u0000${id}`, slug);
    }
  }
  const outcomes: SourceRepairOutcome[] = [];
  const trackMarkers = markers.filter((marker) => marker.subjectType === "track");
  outcomes.push(
    ...(await projectTrackDueWorkSourceRepairs(client, trackMarkers)).map((outcome) => ({
      ...outcome,
      physicalSubjectId: outcome.marker.subjectId,
    })),
  );
  for (const definition of definitions) {
    const sourceMarkers = markers.filter((marker) => marker.subjectType === definition.subjectType);
    const evaluationMarkers = sourceMarkers.map((marker) => {
      const physicalSubjectId = usesSlugIdentity(definition.workKind)
        ? (slugs.get(`${marker.subjectType}\u0000${marker.subjectId}`) ?? marker.subjectId)
        : marker.subjectId;
      return markerForDefinition(marker, definition.workKind, physicalSubjectId);
    });
    const projections: Array<DueWorkProjection<string> | null> = [];
    if (definition.projectMany === undefined) {
      for (const marker of evaluationMarkers) {
        projections.push(await definition.project(marker));
      }
    } else {
      projections.push(...(await definition.projectMany(evaluationMarkers)));
    }
    if (projections.length !== evaluationMarkers.length) {
      throw new Error("due-work bulk source repair must return one result per marker");
    }
    for (const [index, marker] of sourceMarkers.entries()) {
      const evaluationMarker = evaluationMarkers[index];
      if (evaluationMarker === undefined) {
        throw new Error("due-work source repair marker evaluation is missing");
      }
      outcomes.push({
        marker,
        physicalSubjectId: evaluationMarker.subjectId,
        projection: projections[index] ?? null,
        workKind: definition.workKind,
      });
    }
  }
  const expectedOutcomes = markers.reduce(
    (count, marker) =>
      count +
      registeredDefinitions.filter((definition) => definition.subjectType === marker.subjectType)
        .length,
    0,
  );
  if (outcomes.length !== expectedOutcomes) {
    throw new Error("due-work source repair must evaluate every registered physical queue");
  }
  return outcomes;
}

function sourceMarkerGuard(
  marker: DueWorkRow<typeof DUE_WORK_SOURCE_REPAIR_KIND>,
): [string, string, string] {
  return [marker.subjectType, marker.subjectId, marker.sourceVersion];
}

async function convergeEvaluatedSourceMarkers(
  client: DueWorkClient,
  markers: readonly DueWorkRow<typeof DUE_WORK_SOURCE_REPAIR_KIND>[],
  outcomes: readonly SourceRepairOutcome[],
): Promise<number> {
  if (markers.length === 0) {
    return 0;
  }
  const projected = outcomes.filter(
    (outcome): outcome is SourceRepairOutcome & { projection: DueWorkProjection<string> } =>
      outcome.projection !== null,
  );
  const removed = outcomes.filter((outcome) => outcome.projection === null);
  const updatedAt = new Date().toISOString();
  const writes: DueWorkStatement[] = [];

  if (projected.length > 0) {
    const rows = projected.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    writes.push({
      args: projected.flatMap(({ marker, projection }) => [
        projection.workKind,
        projection.subjectType,
        projection.subjectId,
        projection.state,
        projection.sortKey,
        projection.nextDueAt,
        projection.sourceVersion,
        projection.generation ?? marker.generation,
        updatedAt,
        ...sourceMarkerGuard(marker),
      ]),
      sql: `with candidate
        (work_kind, subject_type, subject_id, state, sort_key, next_due_at,
         source_version, generation, updated_at, marker_subject_type, marker_subject_id,
         marker_source_version) as (values ${rows})
        insert into due_work
        (work_kind, subject_type, subject_id, state, sort_key, next_due_at,
         source_version, generation, updated_at)
        select candidate.work_kind, candidate.subject_type, candidate.subject_id,
          candidate.state, candidate.sort_key, candidate.next_due_at, candidate.source_version,
          candidate.generation, candidate.updated_at
        from candidate
        where exists (
          select 1 from due_work marker
          where marker.work_kind = '${DUE_WORK_SOURCE_REPAIR_KIND}'
            and marker.subject_type = candidate.marker_subject_type
            and marker.subject_id = candidate.marker_subject_id
            and marker.state = 'repair'
            and marker.source_version = candidate.marker_source_version
        )
        on conflict(work_kind, subject_type, subject_id) do update set
          state = excluded.state,
          sort_key = excluded.sort_key,
          next_due_at = excluded.next_due_at,
          source_version = excluded.source_version,
          generation = excluded.generation,
          claim_token = null,
          claim_expires_at = null,
          claimed_by = null,
          updated_at = excluded.updated_at,
          repair_entered_at = null`,
    });
  }
  if (removed.length > 0) {
    const rows = removed.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");

    writes.push({
      args: removed.flatMap((outcome) => [
        outcome.workKind,
        outcome.marker.subjectType,
        outcome.physicalSubjectId,
        ...sourceMarkerGuard(outcome.marker),
      ]),
      sql: `with candidate
        (work_kind, subject_type, subject_id, marker_subject_type, marker_subject_id,
         marker_source_version) as (values ${rows})
        delete from due_work
        where (work_kind, subject_type, subject_id) in (
          select candidate.work_kind, candidate.subject_type, candidate.subject_id
          from candidate
          join due_work marker
            on marker.work_kind = '${DUE_WORK_SOURCE_REPAIR_KIND}'
            and marker.subject_type = candidate.marker_subject_type
            and marker.subject_id = candidate.marker_subject_id
            and marker.state = 'repair'
            and marker.source_version = candidate.marker_source_version
        )`,
    });
  }
  const clearRows = markers.map(() => "(?, ?, ?)").join(", ");
  writes.push({
    args: markers.flatMap((marker) => [marker.subjectType, marker.subjectId, marker.sourceVersion]),
    sql: `with marker(subject_type, subject_id, source_version) as (values ${clearRows})
      delete from due_work
      where work_kind = '${DUE_WORK_SOURCE_REPAIR_KIND}' and state = 'repair'
        and exists (
          select 1 from marker
          where marker.subject_type = due_work.subject_type
            and marker.subject_id = due_work.subject_id
            and marker.source_version = due_work.source_version
        )
      returning subject_id`,
  });
  writes.push(advanceProjectionFenceStatement(TRACK_DUE_AUDIT_FENCE_KEY));
  const results = await client.batch(writes, "write");
  return results[writes.length - 2]?.rows.length ?? 0;
}

async function advanceCatalogueRankRebuild(
  client: DueWorkClient,
  marker: DueWorkRow<typeof DUE_WORK_SOURCE_REPAIR_KIND>,
  corpusCheck: CatalogueRankCorpusCheck | undefined,
  limit: number,
): Promise<{ complete: boolean; scanned: number }> {
  const definition = DUE_WORK_BACKFILLS.find(
    (candidate) => candidate.workKind === "catalogue-rank",
  );
  if (definition === undefined) {
    throw new Error("catalogue-rank due-work rebuild definition is missing");
  }
  const checkpoint = await readDueWorkRebuild(client, definition);

  const markerChecked =
    checkpoint?.state === "running" &&
    corpusCheck?.generation === checkpoint.generation &&
    corpusCheck.markerVersion === marker.sourceVersion;
  const materialRevision = dueWorkCatalogueRankMarkerMaterialRevision(marker.sourceVersion);
  if (!markerChecked && materialRevision !== undefined) {
    await client.execute({
      args: [
        CATALOGUE_RANK_MATERIAL_REVISION_KEY,
        materialRevision,
        DUE_WORK_SOURCE_REPAIR_KIND,
        marker.subjectType,
        marker.subjectId,
        marker.sourceVersion,
      ],
      sql: `insert into settings (key, value)
        select ?, ? where exists (
          select 1 from due_work
          where work_kind = ? and subject_type = ? and subject_id = ?
            and state = 'repair' and source_version = ?
        )
        on conflict(key) do update set value = excluded.value`,
    });
  }
  const liveCorpus = markerChecked ? undefined : await refreshDueWorkCatalogueRankCorpus(client);
  const newGeneration = liveCorpus !== undefined && checkpoint?.generation !== liveCorpus;
  const generation = newGeneration ? liveCorpus : checkpoint?.generation;
  if (generation === undefined) {
    throw new Error("catalogue-rank generation could not be derived");
  }
  const result = await runDueWorkRebuildChunk(client, definition, {
    boundedCleanup: true,
    generation,
    limit,
    newGeneration,
  });

  let markerCleared = false;
  if (
    result.complete &&
    result.checkpoint.generation === generation &&
    (liveCorpus !== undefined || markerChecked)
  ) {
    const clearResults = await client.batch(
      [
        clearDueWorkSourceRepairStatement(marker),
        advanceProjectionFenceStatement(TRACK_DUE_AUDIT_FENCE_KEY),
      ],
      "write",
    );
    markerCleared = (clearResults[0]?.rowsAffected ?? 0) > 0;
  }
  if (liveCorpus !== undefined && !markerCleared) {
    await client.execute({
      args: [
        CATALOGUE_RANK_CORPUS_CHECK_KEY,
        JSON.stringify({ generation, markerVersion: marker.sourceVersion }),
      ],
      sql: `insert into settings (key, value) values (?, ?)
        on conflict(key) do update set value = excluded.value`,
    });
  }
  return { complete: result.complete && markerCleared, scanned: result.scanned };
}

async function readCatalogueRankMarker(client: DueWorkClient): Promise<
  | {
      corpusCheck: CatalogueRankCorpusCheck | undefined;
      marker: DueWorkRow<typeof DUE_WORK_SOURCE_REPAIR_KIND>;
    }
  | undefined
> {
  const result = await client.execute({
    args: [
      CATALOGUE_RANK_CORPUS_CHECK_KEY,
      DUE_WORK_SOURCE_REPAIR_KIND,
      DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
    ],
    sql: `select generation, next_due_at, sort_key, source_version, updated_at,
        (select value from settings where key = ?) as corpus_check
      from due_work where work_kind = ? and subject_type = 'track' and subject_id = ?
        and state = 'repair' limit 1`,
  });
  const row = result.rows[0];
  if (row === undefined) {
    return undefined;
  }
  if (
    typeof row.generation !== "string" ||
    typeof row.next_due_at !== "string" ||
    typeof row.sort_key !== "string" ||
    typeof row.source_version !== "string" ||
    typeof row.updated_at !== "string"
  ) {
    throw new Error("catalogue-rank source marker is malformed");
  }
  return {
    corpusCheck: parseCatalogueRankCorpusCheck(row.corpus_check),
    marker: {
      claimExpiresAt: null,
      claimToken: null,
      claimedBy: null,
      generation: row.generation,
      nextDueAt: row.next_due_at,
      sortKey: row.sort_key,
      sourceVersion: row.source_version,
      state: "repair",
      subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
      subjectType: "track",
      updatedAt: row.updated_at,
      workKind: DUE_WORK_SOURCE_REPAIR_KIND,
    },
  };
}

async function advanceCatalogueRankSourceMarker(
  client: DueWorkClient,
  limit: number,
): Promise<
  | { complete: boolean; marker: DueWorkRow<typeof DUE_WORK_SOURCE_REPAIR_KIND>; scanned: number }
  | undefined
> {
  const rank = await readCatalogueRankMarker(client);
  if (rank === undefined) {
    return undefined;
  }
  const result = await advanceCatalogueRankRebuild(client, rank.marker, rank.corpusCheck, limit);
  return { ...result, marker: rank.marker };
}

export async function fanOutDueWorkSourceRepairs(
  client: DueWorkClient,
  options: {
    includeCatalogueRank?: boolean;
    limit?: number;
    subjectType?: DueWorkSubjectType;
  } = {},
): Promise<DueWorkSourceRepairResult> {
  if (
    options.limit !== undefined &&
    (!Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > MAX_DUE_WORK_CHUNK_SIZE)
  ) {
    throw new Error(`due-work limit must be an integer from 1 through ${MAX_DUE_WORK_CHUNK_SIZE}`);
  }

  const limit = Math.min(options.limit ?? SOURCE_REPAIR_LIMIT, SOURCE_REPAIR_LIMIT);
  const page = await listDueWorkSourceRepairs(client, {
    excludeSubjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
    limit,
    subjectType: options.subjectType,
  });
  const regular = page.items;
  const regularOutcomes = await evaluateSourceMarkers(client, regular);
  const cleared = await convergeEvaluatedSourceMarkers(client, regular, regularOutcomes);
  const regularDeferred = regular.length - cleared;
  const rankLimit = Math.min(options.limit ?? RANK_REBUILD_LIMIT, RANK_REBUILD_LIMIT);
  const rankResult =
    options.includeCatalogueRank === false ||
    (options.subjectType !== undefined && options.subjectType !== "track")
      ? undefined
      : await advanceCatalogueRankSourceMarker(client, rankLimit);
  const rankMarker = rankResult?.marker;
  const rankExpanded = rankResult?.complete === true ? 1 : 0;
  const rankDeferred = rankMarker === undefined || rankResult?.complete === true ? 0 : 1;
  const expanded = cleared + rankExpanded;
  const deferred = regularDeferred + rankDeferred;

  return {
    cursor: page.items.at(-1)?.subjectId ?? rankMarker?.subjectId ?? null,
    deferred,
    expanded,
    hasMore: page.hasMore || deferred > 0,
    rankRebuildScanned: rankResult?.scanned ?? 0,
    repaired: expanded,
    scanned: page.items.length + (rankMarker === undefined ? 0 : 1),
  };
}

export async function findPendingPhysicalRepairDefinition(
  client: DueWorkClient,
): Promise<DueWorkRepairDefinition<string> | undefined> {
  const definitions = dueWorkRepairDefinitions(client);
  const identity = (workKind: string, subjectType: string) =>
    JSON.stringify([workKind, subjectType]);
  const registered = new Map(
    definitions.map((definition) => [
      identity(definition.workKind, definition.subjectType),
      definition,
    ]),
  );
  const unregistered: Array<[string, string]> = [];
  for (let read = 0; read < definitions.length; read += 1) {
    const exclusions = unregistered
      .map(() => "\n        and not (work_kind = ? and subject_type = ?)")
      .join("");
    const result = await client.execute({
      args: unregistered.flat(),
      sql: `select work_kind, subject_type from due_work
        where state = 'repair' and work_kind <> '${DUE_WORK_SOURCE_REPAIR_KIND}'${exclusions}
        limit 1`,
    });
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    if (typeof row.work_kind !== "string" || typeof row.subject_type !== "string") {
      throw new Error("due-work repair marker identity is malformed");
    }
    const definition = registered.get(identity(row.work_kind, row.subject_type));
    if (definition !== undefined) {
      return definition;
    }
    unregistered.push([row.work_kind, row.subject_type]);
  }
  return undefined;
}

export const PENDING_TRACK_SOURCE_MARKERS_SQL = `select 1 from due_work
  where work_kind = '${DUE_WORK_SOURCE_REPAIR_KIND}' and subject_type = 'track' and +state = 'repair'
    and subject_id <> '${DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID}'`;

export async function hasPendingTrackSourceMarkers(client: DueWorkClient): Promise<boolean> {
  const result = await client.execute(`${PENDING_TRACK_SOURCE_MARKERS_SQL} limit 1`);
  return result.rows.length > 0;
}

export type DueWorkReadDrainBudget = {
  physicalChunks: number;

  sourcePages: number;

  wallMs: number;
};

export const DUE_WORK_READ_DRAIN_BUDGET: Readonly<DueWorkReadDrainBudget> = {
  physicalChunks: 4,
  sourcePages: 12,
  wallMs: 1_500,
};

type DueWorkReadDrain = { physicalChunks: number; sourcePages: number; spentMs: number };

const DUE_WORK_READ_DRAIN_KEY = Symbol("due-work-read-drain");

function freshReadDrain(): DueWorkReadDrain {
  return { physicalChunks: 0, sourcePages: 0, spentMs: 0 };
}

function repairConverged(result: DueWorkRepairResult): boolean {
  return !result.hasMore && result.deferred === 0;
}

export type { DueWorkReadRepairOutcome } from "./due-work-types";

export async function drainDueWorkBeforeRead(
  client: DueWorkClient,
  workKind: string,
  options: { budget?: DueWorkReadDrainBudget; now?: () => number } = {},
): Promise<DueWorkReadRepairOutcome> {
  const definition = dueWorkRepairDefinitions(client).find(
    (candidate) => candidate.workKind === workKind,
  );
  if (definition === undefined) {
    return { physicalConverged: true, sourceConverged: true };
  }
  const budget = options.budget ?? DUE_WORK_READ_DRAIN_BUDGET;
  const now = options.now ?? (() => performance.now());
  const drain = getRequestScopedValue(DUE_WORK_READ_DRAIN_KEY, freshReadDrain) ?? freshReadDrain();
  const timed = async <Result>(unit: () => Promise<Result>): Promise<Result> => {
    const startedAt = now();
    try {
      return await unit();
    } finally {
      drain.spentMs += now() - startedAt;
    }
  };
  const mayStart = (started: number, cap: number): boolean =>
    started < cap && drain.spentMs < budget.wallMs;
  const drainSourcePage = (): Promise<DueWorkSourceRepairResult> => {
    drain.sourcePages += 1;
    return timed(() =>
      fanOutDueWorkSourceRepairs(client, {
        includeCatalogueRank: false,
        subjectType: definition.subjectType,
      }),
    );
  };
  const drainPhysicalChunk = (): Promise<DueWorkRepairResult> => {
    drain.physicalChunks += 1;
    return timed(() => repairDueWorkChunk(client, definition, { limit: PHYSICAL_REPAIR_LIMIT }));
  };

  let source = await drainSourcePage();
  while (!repairConverged(source) && mayStart(drain.sourcePages, budget.sourcePages)) {
    source = await drainSourcePage();
  }

  const rank =
    workKind === "catalogue-rank"
      ? await timed(() => advanceCatalogueRankSourceMarker(client, RANK_REBUILD_LIMIT))
      : undefined;
  const sourceConverged = repairConverged(source) && (rank === undefined || rank.complete);

  let physical = await drainPhysicalChunk();
  while (
    sourceConverged &&
    !repairConverged(physical) &&
    mayStart(drain.physicalChunks, budget.physicalChunks)
  ) {
    physical = await drainPhysicalChunk();
  }

  return { physicalConverged: repairConverged(physical), sourceConverged };
}

export async function repairDueWorkBeforeRead(
  client: DueWorkClient,
  workKind: string,
  options: { budget?: DueWorkReadDrainBudget; now?: () => number } = {},
): Promise<void> {
  const outcome = await drainDueWorkBeforeRead(client, workKind, options);
  if (!outcome.sourceConverged || !outcome.physicalConverged) {
    throw new DueWorkMaintenancePendingError(workKind);
  }
}
