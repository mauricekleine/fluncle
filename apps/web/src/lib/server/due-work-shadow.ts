import {
  DUE_WORK_TRACK_WORK_KIND_INVENTORY,
  type DueWorkKind,
  type DueWorkScope,
} from "./due-work-track-definitions";
import { listReadyDueWork, promoteDueWork, type DueWorkClient } from "./due-work";

export type DueWorkShadowResult = {
  legacyIds: string[];
  matched: boolean;
  missingIds: string[];
  orderMismatch: boolean;
  projectedIds: string[];
  unexpectedIds: string[];
};

function physicalKinds(kind: DueWorkKind, scope: "all" | DueWorkScope): string[] {
  const scopes: readonly DueWorkScope[] = scope === "all" ? ["findings", "catalogue"] : [scope];

  return scopes.flatMap((candidateScope) =>
    DUE_WORK_TRACK_WORK_KIND_INVENTORY.filter(
      (entry) => entry.kind === kind && entry.scope === candidateScope,
    ).map((entry) => entry.workKind),
  );
}

/**
 * Read the maintained worklist in the legacy outer order: findings first, then catalogue.
 * Each physical half promotes only a bounded due-time page, then seeks the same ready index used
 * by empty probes and claims.
 */
export async function readProjectedTrackWorkIds(
  client: DueWorkClient,
  options: {
    kind: DueWorkKind;
    limit: number;
    now?: () => Date;
    scope: "all" | DueWorkScope;
  },
): Promise<string[]> {
  if (options.kind === "youtube-reverdict" && options.scope === "all") {
    const pages = await Promise.all(
      physicalKinds(options.kind, options.scope).map(async (workKind) => {
        await promoteDueWork(client, workKind, {
          limit: Math.min(500, Math.max(options.limit, options.limit * 2)),
          now: options.now,
        });
        return (await listReadyDueWork(client, workKind, { limit: options.limit })).items;
      }),
    );
    return pages
      .flat()
      .sort((left, right) =>
        left.sortKey === right.sortKey
          ? left.subjectId.localeCompare(right.subjectId)
          : left.sortKey.localeCompare(right.sortKey),
      )
      .slice(0, options.limit)
      .map((item) => item.subjectId);
  }

  const ids: string[] = [];

  for (const workKind of physicalKinds(options.kind, options.scope)) {
    const remaining = options.limit - ids.length;
    if (remaining <= 0) {
      break;
    }

    await promoteDueWork(client, workKind, {
      limit: Math.min(500, Math.max(remaining, remaining * 2)),
      now: options.now,
    });
    const page = await listReadyDueWork(client, workKind, { limit: remaining });
    ids.push(...page.items.map((item) => item.subjectId));
  }

  return ids;
}

export function compareDueWorkShadow(
  legacyIds: readonly string[],
  projectedIds: readonly string[],
): DueWorkShadowResult {
  const legacySet = new Set(legacyIds);
  const projectedSet = new Set(projectedIds);
  const missingIds = legacyIds.filter((id) => !projectedSet.has(id));
  const unexpectedIds = projectedIds.filter((id) => !legacySet.has(id));
  const orderMismatch =
    missingIds.length === 0 &&
    unexpectedIds.length === 0 &&
    legacyIds.some((id, index) => projectedIds[index] !== id);

  return {
    legacyIds: [...legacyIds],
    matched: missingIds.length === 0 && unexpectedIds.length === 0 && !orderMismatch,
    missingIds,
    orderMismatch,
    projectedIds: [...projectedIds],
    unexpectedIds,
  };
}

export async function shadowTrackWorkProjection(
  client: DueWorkClient,
  options: {
    kind: DueWorkKind;
    legacyIds: () => Promise<string[]>;
    limit: number;
    now?: () => Date;
    scope: "all" | DueWorkScope;
  },
): Promise<DueWorkShadowResult> {
  const [legacyIds, projectedIds] = await Promise.all([
    options.legacyIds(),
    readProjectedTrackWorkIds(client, options),
  ]);
  return compareDueWorkShadow(legacyIds, projectedIds);
}
