import {
  clearDueWorkSourceRepairStatement,
  DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
  DueWorkMaintenancePendingError,
  DUE_WORK_SOURCE_REPAIR_KIND,
  listDueWorkSourceRepairs,
  markDueWorkRepairStatement,
  readDueWorkRebuild,
  repairDueWorkChunk,
  runDueWorkRebuildChunk,
  type DueWorkClient,
  type DueWorkRepairResult,
  type DueWorkRow,
  type DueWorkStatement,
  type DueWorkSubjectType,
} from "./due-work";
import { DUE_WORK_BACKFILLS, dueWorkRepairDefinitions } from "./due-work-registry";
import { advanceProjectionFenceStatement, TRACK_DUE_AUDIT_FENCE_KEY } from "./projection-fences";

const SOURCE_REPAIR_LIMIT = 5;
const PHYSICAL_REPAIR_LIMIT = 50;
const RANK_REBUILD_LIMIT = 100;

export type DueWorkSourceRepairResult = DueWorkRepairResult & {
  expanded: number;
  rankRebuildScanned: number;
};

async function readEntitySlug(
  client: DueWorkClient,
  subjectType: Exclude<DueWorkSubjectType, "track">,
  subjectId: string,
): Promise<string | undefined> {
  const result = await client.execute({
    args: [subjectId],
    sql: `select slug from ${subjectType}s where id = ? limit 1`,
  });
  const slug = result.rows[0]?.slug;
  return typeof slug === "string" ? slug : undefined;
}

function usesSlugIdentity(workKind: string): boolean {
  return (
    workKind === "album.cover-master" ||
    workKind === "artist.cover-master" ||
    workKind === "label.image"
  );
}

async function expandSourceMarker(
  client: DueWorkClient,
  marker: DueWorkRow<typeof DUE_WORK_SOURCE_REPAIR_KIND>,
): Promise<boolean> {
  const slug =
    marker.subjectType === "track"
      ? undefined
      : await readEntitySlug(client, marker.subjectType, marker.subjectId);
  const definitions = dueWorkRepairDefinitions(client).filter(
    (definition) => definition.subjectType === marker.subjectType,
  );
  const statements: DueWorkStatement[] = [];

  for (const definition of definitions) {
    const subjectId = usesSlugIdentity(definition.workKind)
      ? (slug ?? marker.subjectId)
      : marker.subjectId;
    statements.push(
      markDueWorkRepairStatement(
        {
          sourceVersion: marker.sourceVersion,
          subjectId,
          subjectType: definition.subjectType,
          workKind: definition.workKind,
        },
        { generation: marker.generation, now: marker.updatedAt },
      ),
    );
  }

  statements.push(clearDueWorkSourceRepairStatement(marker));
  const clearIndex = statements.length - 1;
  statements.push(advanceProjectionFenceStatement(TRACK_DUE_AUDIT_FENCE_KEY));
  const results = await client.batch(statements, "write");
  return (results[clearIndex]?.rowsAffected ?? 0) > 0;
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

    if (await expandSourceMarker(client, marker)) {
      expanded += 1;
    } else {
      deferred += 1;
    }
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
