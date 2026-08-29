import {
  DUE_WORK_TRACK_WORK_KIND_INVENTORY,
  type DueWorkKind,
  type DueWorkQueueKind,
  type DueWorkScope,
} from "./due-work-track-definitions";
import {
  countDueWorkNow,
  DueWorkMaintenancePendingError,
  hasDueScheduledWork,
  listReadyDueWork,
  MAX_DUE_WORK_CHUNK_SIZE,
  promoteDueWork,
  type DueWorkClient,
  type DueWorkRow,
} from "./due-work";
import { getSetting } from "./settings";

async function maintainDueWork(client: DueWorkClient, workKind: string): Promise<void> {
  const { repairDueWorkBeforeRead } = await import("./due-work-source-repair");
  await repairDueWorkBeforeRead(client, workKind);
}

/** The Goal C read flag. Only the exact string "true" opens the cutover. */
export const TRACK_WORK_DUE_CUTOVER_ENABLED_KEY = "track_work_due_cutover_enabled";

export type TrackWorkDueScope = "all" | DueWorkScope;

/**
 * Read the Goal C flag with the default-safe settings contract. A missing, malformed, or failed
 * settings read keeps the legacy selector in charge. This is intentionally a read-only flag:
 * the existing operator settings path can flip it without making queue reads responsible for any
 * due-work state transition.
 */
export async function isTrackWorkDueCutoverEnabled(): Promise<boolean> {
  try {
    return (await getSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY)) === "true";
  } catch {
    return false;
  }
}

/** The shared Goal C flag reader for due-work consumers outside listTrackWork. */
export async function isDueWorkCutoverEnabled(): Promise<boolean> {
  return isTrackWorkDueCutoverEnabled();
}

export type DueWorkContinuation = { sortKey: string; subjectId: string };

export type DueWorkSubjectPage = {
  hasMore: boolean;
  subjectIds: string[];
};

/**
 * Promote one bounded due-time page, then seek one bounded ready page by the maintained index.
 * The projection read deliberately selects only subject IDs; callers hydrate their own exact DTO.
 */
export async function readPromotedDueWorkPage(
  client: DueWorkClient,
  workKind: string,
  options: {
    continuation?: DueWorkContinuation;
    limit: number;
    now?: () => Date;
    subjectIds?: readonly string[];
  },
): Promise<DueWorkSubjectPage> {
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > MAX_DUE_WORK_CHUNK_SIZE
  ) {
    throw new RangeError(
      `due-work cutover limit must be an integer from 1 through ${MAX_DUE_WORK_CHUNK_SIZE}`,
    );
  }

  const promotionLimit = MAX_DUE_WORK_CHUNK_SIZE;
  await maintainDueWork(client, workKind);
  await promoteDueWork(client, workKind, { limit: promotionLimit, now: options.now });
  if (await hasDueScheduledWork(client, workKind, { now: options.now })) {
    throw new DueWorkMaintenancePendingError(workKind);
  }

  if (options.subjectIds?.length === 0) {
    return { hasMore: false, subjectIds: [] };
  }

  const continuation = options.continuation;
  const clauses = ["work_kind = ?", "state = 'ready'"];
  const args: Array<number | string> = [workKind];

  if (continuation) {
    clauses.push("(sort_key, subject_id) > (?, ?)");
    args.push(continuation.sortKey, continuation.subjectId);
  }

  if (options.subjectIds) {
    clauses.push(`subject_id in (${options.subjectIds.map(() => "?").join(", ")})`);
    args.push(...options.subjectIds);
  }

  args.push(options.limit + 1);
  const result = await client.execute({
    args,
    sql: `select subject_id
          from due_work
          where ${clauses.join(" and ")}
          order by sort_key, subject_id
          limit ?`,
  });
  const subjectIds = result.rows.flatMap((row) =>
    typeof row.subject_id === "string" ? [row.subject_id] : [],
  );

  return {
    hasMore: subjectIds.length > options.limit,
    subjectIds: subjectIds.slice(0, options.limit),
  };
}

type TrackWorkInventoryEntry = (typeof DUE_WORK_TRACK_WORK_KIND_INVENTORY)[number];
type ReadyTrackRow = DueWorkRow<DueWorkQueueKind>;

function entriesFor(kind: DueWorkKind, scope: TrackWorkDueScope): TrackWorkInventoryEntry[] {
  const scopes: readonly DueWorkScope[] = scope === "all" ? ["findings", "catalogue"] : [scope];

  return scopes.flatMap((candidateScope) =>
    DUE_WORK_TRACK_WORK_KIND_INVENTORY.filter(
      (entry) => entry.kind === kind && entry.scope === candidateScope,
    ),
  );
}

async function readReadyPage(
  client: DueWorkClient,
  entry: TrackWorkInventoryEntry,
  limit: number,
): Promise<ReadyTrackRow[]> {
  await maintainDueWork(client, entry.workKind);
  await promoteDueWork(client, entry.workKind, { limit: Math.max(limit, 100) });
  const page = await listReadyDueWork(client, entry.workKind, { limit });
  return page.items;
}

function compareBinary(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);

  for (let index = 0; index < length; index += 1) {
    const leftByte = leftBytes[index];
    const rightByte = rightBytes[index];

    if (leftByte === undefined || rightByte === undefined || leftByte === rightByte) {
      continue;
    }

    return leftByte < rightByte ? -1 : 1;
  }

  return leftBytes.length - rightBytes.length;
}

function compareReadyRows(left: ReadyTrackRow, right: ReadyTrackRow): number {
  const sortKey = compareBinary(left.sortKey, right.sortKey);
  return sortKey === 0 ? compareBinary(left.subjectId, right.subjectId) : sortKey;
}

/**
 * Read the bounded ready projection for one listTrackWork request.
 *
 * The bounded promotion moves elapsed retries onto the same ready index before the page read.
 * `listTrackWork` remains non-claiming because its existing CLI and sweep contract is a read;
 * the returned IDs are the only source rows the caller hydrates.
 */
export async function readTrackWorkDueIds(
  client: DueWorkClient,
  options: { kind: DueWorkKind; limit: number; scope: TrackWorkDueScope },
): Promise<string[]> {
  const entries = entriesFor(options.kind, options.scope);

  if (entries.length === 0) {
    return [];
  }

  // `youtube-reverdict` was the one legacy specialist read whose global order interleaved the two
  // certification halves. Its two physical projections therefore need a bounded merge. All other
  // shared queues preserve listTrackWork's findings-first concatenation, while anchor/recovery are
  // catalogue-only and have one physical queue.
  if (options.kind === "youtube-reverdict" && options.scope === "all") {
    const pages = await Promise.all(
      entries.map((entry) => readReadyPage(client, entry, options.limit)),
    );
    return pages
      .flat()
      .sort(compareReadyRows)
      .slice(0, options.limit)
      .map((row) => row.subjectId);
  }

  const ids: string[] = [];
  for (const entry of entries) {
    const remaining = options.limit - ids.length;
    if (remaining <= 0) {
      break;
    }

    const rows = await readReadyPage(client, entry, remaining);
    ids.push(...rows.map((row) => row.subjectId));
  }

  return ids;
}

/** Count only the projected backlog that is due now, preserving the physical scope split. */
export async function countTrackWorkDue(
  client: DueWorkClient,
  options: { kind: DueWorkKind; scope: TrackWorkDueScope },
): Promise<number> {
  const entries = entriesFor(options.kind, options.scope);
  for (const entry of entries) {
    await maintainDueWork(client, entry.workKind);
  }
  const counts = await Promise.all(entries.map((entry) => countDueWorkNow(client, entry.workKind)));
  return counts.reduce((total, count) => total + count, 0);
}
