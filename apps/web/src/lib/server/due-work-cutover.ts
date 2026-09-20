import {
  DUE_WORK_TRACK_WORK_KIND_INVENTORY,
  type DueWorkKind,
  type DueWorkQueueKind,
  type DueWorkScope,
} from "./due-work-track-definitions";
import {
  countDueWorkNow,
  DUE_WORK_SOURCE_REPAIR_KIND,
  DueWorkMaintenancePendingError,
  dueWorkReadyScanWindow,
  hasDueScheduledWork,
  listServableDueWork,
  MAX_DUE_WORK_CHUNK_SIZE,
  promoteDueWork,
  type DueWorkClient,
  type DueWorkRow,
} from "./due-work";
import { type DueWorkReadRepairOutcome } from "./due-work-types";
import { getSetting } from "./settings";

/**
 * Drain this queue's repair and report what converged. A ready read that finds servable rows serves
 * them whatever the drain left behind: a source marker withholds its own subject and nothing else,
 * and a physical marker holds its row out of `ready` by itself.
 */
async function maintainDueWork(
  client: DueWorkClient,
  workKind: string,
): Promise<DueWorkReadRepairOutcome> {
  const { drainDueWorkBeforeRead } = await import("./due-work-source-repair");
  return drainDueWorkBeforeRead(client, workKind);
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
    /**
     * What an EMPTY page means while this request's bounded drain left source debt behind.
     *
     * `defer` (the default) answers `due_work_maintenance_pending`: the debt may own every row the
     * read would have returned, or rows not projected yet, so "nothing to do" cannot be said
     * honestly. `serve` answers the empty page instead. Serving an empty page hands out no row and
     * therefore spends nothing — the cost of a wrong empty is a MISSED TICK, not a wrong spend —
     * so a queue may opt in when its consumer simply retries on its own cadence and nothing
     * downstream reads "empty" as "backlog drained". A queue whose order spends a metered budget
     * keeps the default: there an empty answer is what tells the operator the money stopped.
     */
    emptyPageUnderDebt?: "defer" | "serve";
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
  const repair = await maintainDueWork(client, workKind);
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

  // The bounded window is scanned in ready order, then every subject an outstanding source marker
  // still owns is withheld by that marker's own primary key. Withholding is per subject, so the
  // rest of the window is exactly as servable as it was before the marker landed.
  args.push(dueWorkReadyScanWindow(options.limit), options.limit + 1);
  const result = await client.execute({
    args,
    sql: `select subject_id from (
            select subject_id, subject_type, sort_key
            from due_work
            where ${clauses.join(" and ")}
            order by sort_key, subject_id
            limit ?
          ) ready
          where not exists (
            select 1 from due_work marker
            where marker.work_kind = '${DUE_WORK_SOURCE_REPAIR_KIND}'
              and marker.subject_type = ready.subject_type
              and marker.subject_id = ready.subject_id
              and marker.state = 'repair')
          order by sort_key, subject_id
          limit ?`,
  });
  const subjectIds = result.rows.flatMap((row) =>
    typeof row.subject_id === "string" ? [row.subject_id] : [],
  );

  // Nothing servable while the subject family still owes repair is not an empty queue: the debt may
  // own every row this read would have returned, or rows it has not projected yet. A queue that
  // opted into `serve` accepts that and answers the empty page, because the worst it can cost is
  // one delayed tick.
  if (
    subjectIds.length === 0 &&
    !repair.sourceConverged &&
    options.emptyPageUnderDebt !== "serve"
  ) {
    throw new DueWorkMaintenancePendingError(workKind);
  }

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
  const repair = await maintainDueWork(client, entry.workKind);
  await promoteDueWork(client, entry.workKind, { limit: Math.max(limit, 100) });
  const page = await listServableDueWork(client, entry.workKind, { limit });
  if (page.items.length === 0 && !repair.sourceConverged) {
    throw new DueWorkMaintenancePendingError(entry.workKind);
  }
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
  // A scope spanning both certification halves reads two physical queues. One of them having
  // nothing servable while its family still owes repair does not make the other's rows unservable,
  // so a pending answer is carried and raised only if the whole request ends up with nothing.
  let pending: DueWorkMaintenancePendingError | undefined;
  const readOrDefer = async (
    entry: TrackWorkInventoryEntry,
    limit: number,
  ): Promise<ReadyTrackRow[]> => {
    try {
      return await readReadyPage(client, entry, limit);
    } catch (error) {
      if (!(error instanceof DueWorkMaintenancePendingError)) {
        throw error;
      }
      pending ??= error;
      return [];
    }
  };
  const answer = (ids: string[]): string[] => {
    if (ids.length === 0 && pending !== undefined) {
      throw pending;
    }
    return ids;
  };

  if (options.kind === "youtube-reverdict" && options.scope === "all") {
    const pages: ReadyTrackRow[][] = [];
    for (const entry of entries) {
      pages.push(await readOrDefer(entry, options.limit));
    }
    return answer(
      pages
        .flat()
        .sort(compareReadyRows)
        .slice(0, options.limit)
        .map((row) => row.subjectId),
    );
  }

  const ids: string[] = [];
  for (const entry of entries) {
    const remaining = options.limit - ids.length;
    if (remaining <= 0) {
      break;
    }

    ids.push(...(await readOrDefer(entry, remaining)).map((row) => row.subjectId));
  }

  return answer(ids);
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
