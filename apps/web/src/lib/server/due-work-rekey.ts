import { advanceProjectionFenceStatement, TRACK_DUE_AUDIT_FENCE_KEY } from "./projection-fences";
import {
  markDueWorkRepairStatement,
  MAX_DUE_WORK_CHUNK_SIZE,
  type DueWorkClient,
  type DueWorkStatement,
} from "./due-work";
import { DUE_WORK_BACKFILLS } from "./due-work-registry";

export const DUE_WORK_REKEY_REMAINING_LIMIT = 10_000;

export type DueWorkRekeyInput = {
  apply?: boolean;
  cursor?: null | string;
  limit?: number;
  now?: () => Date;
  workKind: string;
};

export type DueWorkRekeyResult = {
  applied: boolean;
  cursor: null | string;
  definitionVersion: string;
  hasMore: boolean;
  marked: number;
  matched: number;
  remaining: { count: number; truncated: boolean };
  subjectType: string;
  workKind: string;
};

export class UnknownDueWorkQueueError extends Error {
  readonly workKinds: readonly string[];

  constructor(workKind: string, workKinds: readonly string[]) {
    super(`no due-work queue named ${workKind}`);
    this.name = "UnknownDueWorkQueueError";
    this.workKinds = workKinds;
  }
}

export function rekeyableDueWorkQueues(): readonly string[] {
  return DUE_WORK_BACKFILLS.map((definition) => definition.workKind);
}

export async function rekeyDueWorkQueue(
  client: DueWorkClient,
  input: DueWorkRekeyInput,
): Promise<DueWorkRekeyResult> {
  const definition = DUE_WORK_BACKFILLS.find((entry) => entry.workKind === input.workKind);
  if (definition === undefined) {
    throw new UnknownDueWorkQueueError(input.workKind, rekeyableDueWorkQueues());
  }
  const limit = input.limit ?? MAX_DUE_WORK_CHUNK_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DUE_WORK_CHUNK_SIZE) {
    throw new Error(
      `due-work re-key limit must be an integer from 1 through ${MAX_DUE_WORK_CHUNK_SIZE}`,
    );
  }
  const apply = input.apply === true;
  const after = input.cursor ?? "";
  const page = await client.execute({
    args: [definition.workKind, definition.subjectType, after, limit],
    sql: `select subject_id, source_version from due_work
      where work_kind = ? and subject_type = ? and subject_id > ? and state <> 'repair'
      order by subject_id
      limit ?`,
  });
  const rows = page.rows as unknown as { source_version: string; subject_id: string }[];
  const cursor = rows[rows.length - 1]?.subject_id ?? null;

  if (apply && rows.length > 0) {
    const now = (input.now ?? (() => new Date()))();
    const writes: DueWorkStatement[] = rows.map((row) =>
      markDueWorkRepairStatement(
        {
          sourceVersion: row.source_version,
          subjectId: row.subject_id,
          subjectType: definition.subjectType,
          workKind: definition.workKind,
        },
        { now },
      ),
    );

    writes.push(advanceProjectionFenceStatement(TRACK_DUE_AUDIT_FENCE_KEY));
    await client.batch(writes, "write");
  }

  const remainingAfter = cursor ?? after;
  const probe = await client.execute({
    args: [
      definition.workKind,
      definition.subjectType,
      remainingAfter,
      DUE_WORK_REKEY_REMAINING_LIMIT,
    ],
    sql: `select count(*) as remaining from (
      select 1 from due_work
      where work_kind = ? and subject_type = ? and subject_id > ? and state <> 'repair'
      limit ?)`,
  });
  const remaining = Number(probe.rows[0]?.remaining ?? 0);

  return {
    applied: apply,
    cursor,
    definitionVersion: definition.definitionVersion,
    hasMore: remaining > 0,
    marked: apply ? rows.length : 0,
    matched: rows.length,
    remaining: { count: remaining, truncated: remaining >= DUE_WORK_REKEY_REMAINING_LIMIT },
    subjectType: definition.subjectType,
    workKind: definition.workKind,
  };
}
