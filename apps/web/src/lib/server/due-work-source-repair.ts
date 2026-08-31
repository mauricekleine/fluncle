import {
  clearDueWorkSourceRepairStatement,
  DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
  DueWorkMaintenancePendingError,
  DUE_WORK_SOURCE_REPAIR_KIND,
  listDueWorkSourceRepairs,
  readDueWorkRebuild,
  repairDueWorkChunk,
  runDueWorkRebuildChunk,
  type DueWorkClient,
  type DueWorkRepairResult,
  type DueWorkRow,
  type DueWorkSubjectType,
} from "./due-work";
import { DUE_WORK_BACKFILLS, dueWorkRepairDefinitions } from "./due-work-registry";
import { advanceProjectionFenceStatement, TRACK_DUE_AUDIT_FENCE_KEY } from "./projection-fences";

const SOURCE_REPAIR_LIMIT = 5;
const SOURCE_FANOUT_WRITE_BATCH_SIZE = 50;
const PHYSICAL_REPAIR_LIMIT = 50;
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

async function expandSourceMarkers(
  client: DueWorkClient,
  markers: readonly DueWorkRow<typeof DUE_WORK_SOURCE_REPAIR_KIND>[],
): Promise<number> {
  if (markers.length === 0) {
    return 0;
  }
  const subjectTypes = new Set(markers.map((marker) => marker.subjectType));
  const definitions = dueWorkRepairDefinitions(client).filter((definition) =>
    subjectTypes.has(definition.subjectType),
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
  const markerRows = markers.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
  const definitionRows = definitions.map(() => "(?, ?, ?)").join(", ");
  const clearRows = markers.map(() => "(?, ?, ?)").join(", ");
  const results = await client.batch(
    [
      {
        args: [
          ...markers.flatMap((marker) => [
            marker.subjectType,
            marker.subjectId,
            slugs.get(`${marker.subjectType}\u0000${marker.subjectId}`) ?? null,
            marker.sourceVersion,
            marker.generation,
            marker.updatedAt,
          ]),
          ...definitions.flatMap((definition) => [
            definition.workKind,
            definition.subjectType,
            usesSlugIdentity(definition.workKind) ? 1 : 0,
          ]),
        ],
        sql: `with
          marker(subject_type, subject_id, slug, source_version, generation, updated_at)
            as (values ${markerRows}),
          definition(work_kind, subject_type, uses_slug) as (values ${definitionRows})
          insert into due_work
          (work_kind, subject_type, subject_id, state, sort_key, next_due_at,
           source_version, generation, updated_at)
          select definition.work_kind, marker.subject_type,
            case when definition.uses_slug = 1 then coalesce(marker.slug, marker.subject_id)
              else marker.subject_id end,
            'repair', '', marker.updated_at, marker.source_version, marker.generation,
            marker.updated_at
          from marker
          join definition on definition.subject_type = marker.subject_type
          join due_work source_marker
            on source_marker.work_kind = '${DUE_WORK_SOURCE_REPAIR_KIND}'
            and source_marker.subject_type = marker.subject_type
            and source_marker.subject_id = marker.subject_id
            and source_marker.state = 'repair'
            and source_marker.source_version = marker.source_version
          on conflict(work_kind, subject_type, subject_id) do update set
            state = 'repair',
            sort_key = '',
            next_due_at = excluded.next_due_at,
            source_version = excluded.source_version,
            generation = excluded.generation,
            claim_token = null,
            claim_expires_at = null,
            claimed_by = null,
            updated_at = excluded.updated_at`,
      },
      {
        args: markers.flatMap((marker) => [
          marker.subjectType,
          marker.subjectId,
          marker.sourceVersion,
        ]),
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
      },
      advanceProjectionFenceStatement(TRACK_DUE_AUDIT_FENCE_KEY),
    ],
    "write",
  );
  return results[1]?.rows.length ?? 0;
}

async function advanceCatalogueRankRebuild(
  client: DueWorkClient,
  marker: DueWorkRow<typeof DUE_WORK_SOURCE_REPAIR_KIND>,
): Promise<{ complete: boolean; scanned: number }> {
  const definition = DUE_WORK_BACKFILLS.find(
    (candidate) => candidate.workKind === "catalogue-rank",
  );
  if (definition === undefined) {
    throw new Error("catalogue-rank due-work rebuild definition is missing");
  }
  const checkpoint = await readDueWorkRebuild(client, definition);
  const result = await runDueWorkRebuildChunk(client, definition, {
    generation: marker.sourceVersion,
    limit: RANK_REBUILD_LIMIT,
    newGeneration: checkpoint?.generation !== marker.sourceVersion,
  });

  if (result.complete) {
    await client.batch(
      [
        clearDueWorkSourceRepairStatement(marker),
        advanceProjectionFenceStatement(TRACK_DUE_AUDIT_FENCE_KEY),
      ],
      "write",
    );
  }
  return { complete: result.complete, scanned: result.scanned };
}

/**
 * Expand a bounded page of transactionally coupled source markers into the exact physical repair
 * rows. The generic marker is cleared in the same transaction as its fan-out; its version guard
 * leaves a concurrent producer marker intact. Catalogue-rank corpus changes instead advance one
 * resumable rebuild chunk under the producer marker's generation.
 */
export async function fanOutDueWorkSourceRepairs(
  client: DueWorkClient,
  options: {
    includeCatalogueRank?: boolean;
    limit?: number;
    subjectType?: DueWorkSubjectType;
  } = {},
): Promise<DueWorkSourceRepairResult> {
  const limit = options.limit ?? SOURCE_REPAIR_LIMIT;
  const page = await listDueWorkSourceRepairs(client, {
    excludeSubjectId:
      options.includeCatalogueRank === false
        ? DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID
        : undefined,
    limit,
    subjectType: options.subjectType,
  });
  let deferred = 0;
  let expanded = 0;
  let rankRebuildScanned = 0;
  const regular: DueWorkRow<typeof DUE_WORK_SOURCE_REPAIR_KIND>[] = [];

  for (const marker of page.items) {
    if (
      marker.subjectType === "track" &&
      marker.subjectId === DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID
    ) {
      const result = await advanceCatalogueRankRebuild(client, marker);
      rankRebuildScanned += result.scanned;
      if (result.complete) {
        expanded += 1;
      } else {
        deferred += 1;
      }
      continue;
    }
    regular.push(marker);
  }
  for (let index = 0; index < regular.length; index += SOURCE_FANOUT_WRITE_BATCH_SIZE) {
    const chunk = regular.slice(index, index + SOURCE_FANOUT_WRITE_BATCH_SIZE);
    const cleared = await expandSourceMarkers(client, chunk);
    expanded += cleared;
    deferred += chunk.length - cleared;
  }

  return {
    cursor: page.items.at(-1)?.subjectId ?? null,
    deferred,
    expanded,
    hasMore: page.hasMore || deferred > 0,
    rankRebuildScanned,
    repaired: expanded,
    scanned: page.items.length,
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
