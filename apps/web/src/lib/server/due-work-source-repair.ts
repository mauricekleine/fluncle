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
  type DueWorkRepairResult,
  type DueWorkRow,
  type DueWorkStatement,
  type DueWorkSubjectType,
} from "./due-work";
import { CATALOGUE_RANK_MATERIAL_REVISION_KEY } from "./catalogue";
import {
  DUE_WORK_BACKFILLS,
  dueWorkRepairDefinitions,
  projectTrackDueWorkSourceRepairs,
  refreshDueWorkCatalogueRankCorpus,
} from "./due-work-registry";
import { advanceProjectionFenceStatement, TRACK_DUE_AUDIT_FENCE_KEY } from "./projection-fences";

const SOURCE_REPAIR_LIMIT = 5;
export const PHYSICAL_REPAIR_LIMIT = 50;
const RANK_REBUILD_LIMIT = 100;

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
          updated_at = excluded.updated_at`,
    });
  }
  if (removed.length > 0) {
    const rows = removed.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    // Keep the bounded candidate set on the driving side. A correlated EXISTS with `due_work` as
    // the outer DELETE turns this into a full projection scan instead of primary-key removals.
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
  limit: number,
): Promise<{ complete: boolean; scanned: number }> {
  const definition = DUE_WORK_BACKFILLS.find(
    (candidate) => candidate.workKind === "catalogue-rank",
  );
  if (definition === undefined) {
    throw new Error("catalogue-rank due-work rebuild definition is missing");
  }
  const checkpoint = await readDueWorkRebuild(client, definition);
  // A running generation owns its cached corpus and cursor until completion. Once it completes,
  // re-read the live definition: an equivalent newer marker clears against the durable generation,
  // while a changed definition starts once from page zero.
  const materialRevision = dueWorkCatalogueRankMarkerMaterialRevision(marker.sourceVersion);
  if (checkpoint?.state !== "running" && materialRevision !== undefined) {
    // A marker written before the material-revision protocol may be the only durable proof of an
    // in-place finding-vector replacement. Adopt it exactly once, but only while that exact marker
    // still owns the synthetic subject; a concurrent newer mutation therefore wins both rows.
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
  const validatedCorpus =
    checkpoint?.state === "running" ? undefined : await refreshDueWorkCatalogueRankCorpus(client);
  const desiredGeneration = validatedCorpus;
  const checkpointSatisfiesMarker =
    checkpoint !== undefined &&
    desiredGeneration !== undefined &&
    checkpoint.generation === desiredGeneration;
  const generation =
    checkpoint?.state === "running"
      ? checkpoint.generation
      : checkpointSatisfiesMarker
        ? checkpoint.generation
        : desiredGeneration;
  if (generation === undefined) {
    throw new Error("catalogue-rank generation could not be derived");
  }
  const newGeneration =
    checkpoint?.state === "running"
      ? false
      : checkpoint === undefined || !checkpointSatisfiesMarker;
  const result = await runDueWorkRebuildChunk(client, definition, {
    boundedCleanup: true,
    generation,
    limit,
    newGeneration,
  });

  let markerCleared = false;
  if (result.complete && validatedCorpus !== undefined) {
    const clearResults = await client.batch(
      [
        clearDueWorkSourceRepairStatement(marker),
        advanceProjectionFenceStatement(TRACK_DUE_AUDIT_FENCE_KEY),
      ],
      "write",
    );
    markerCleared = (clearResults[0]?.rowsAffected ?? 0) > 0;
  }
  return { complete: result.complete && markerCleared, scanned: result.scanned };
}

async function readCatalogueRankMarker(
  client: DueWorkClient,
): Promise<DueWorkRow<typeof DUE_WORK_SOURCE_REPAIR_KIND> | undefined> {
  const result = await client.execute({
    args: [DUE_WORK_SOURCE_REPAIR_KIND, DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID],
    sql: `select generation, next_due_at, sort_key, source_version, updated_at
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
  };
}

/**
 * Converge a bounded page of transactionally coupled source markers directly into final physical
 * rows. Each generic marker is cleared atomically with all of its eligible upserts and ineligible
 * deletes; its version guard leaves a concurrent producer marker and projection rows intact.
 * Catalogue-rank corpus changes instead advance one resumable rebuild chunk under the producer
 * marker's generation.
 */
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
  // One track marker can project into every registered physical queue. Keep that multiplicative
  // write shape hosted-safe even when the operator supplies the shared 500-row projection limit;
  // callers already continue from the durable marker set while `hasMore` remains true.
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
  const rankMarker =
    options.includeCatalogueRank === false ||
    (options.subjectType !== undefined && options.subjectType !== "track")
      ? undefined
      : await readCatalogueRankMarker(client);
  const rankLimit = Math.min(options.limit ?? RANK_REBUILD_LIMIT, RANK_REBUILD_LIMIT);
  const rankResult =
    rankMarker === undefined
      ? undefined
      : await advanceCatalogueRankRebuild(client, rankMarker, rankLimit);
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

/** Repair generic producers and the requested physical queue before reading its ready index. */
export async function repairDueWorkBeforeRead(
  client: DueWorkClient,
  workKind: string,
): Promise<void> {
  const definition = dueWorkRepairDefinitions(client).find(
    (candidate) => candidate.workKind === workKind,
  );
  if (definition !== undefined) {
    const sourceRepair = await fanOutDueWorkSourceRepairs(client, {
      includeCatalogueRank: workKind === "catalogue-rank",
      subjectType: definition.subjectType,
    });
    const physicalRepair = await repairDueWorkChunk(client, definition, {
      limit: PHYSICAL_REPAIR_LIMIT,
    });
    if (
      sourceRepair.hasMore ||
      physicalRepair.hasMore ||
      sourceRepair.deferred > 0 ||
      physicalRepair.deferred > 0
    ) {
      throw new DueWorkMaintenancePendingError(workKind);
    }
  }
}
