import { type Client, type InStatement, type InValue, type ResultSet } from "@libsql/client";

import { getDb } from "./db";
import {
  markPublicProjectionSourceChangedFromSelectStatements,
  markPublicProjectionSourceChangedStatements,
} from "./public-projection-source-maintenance";

export const DUE_WORK_LIVE_GENERATION = "live";
export const DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID = "@catalogue-rank-corpus";
export const DUE_WORK_SOURCE_REPAIR_KIND = "source-repair";
export const MAX_DUE_WORK_CHUNK_SIZE = 500;

export class DueWorkMaintenancePendingError extends Error {
  constructor(workKind: string) {
    super(`due-work maintenance is still converging for ${workKind}`);
    this.name = "DueWorkMaintenancePendingError";
  }
}

export type DueWorkSubjectType = "album" | "artist" | "label" | "track";
export type DueWorkState = "leased" | "ready" | "repair" | "scheduled";
export type DueWorkProjectionState = Extract<DueWorkState, "ready" | "scheduled">;
export type DueWorkClient = Pick<Client, "batch" | "execute">;
export type DueWorkStatement = Exclude<InStatement, string>;
type DueWorkPositionalStatement = { args?: InValue[]; sql: string };

export type DueWorkIdentity<WorkKind extends string = string> = {
  subjectId: string;
  subjectType: DueWorkSubjectType;
  workKind: WorkKind;
};

export type DueWorkSourceSubject = Pick<DueWorkIdentity, "subjectId" | "subjectType">;

export type DueWorkProjection<WorkKind extends string = string> = DueWorkIdentity<WorkKind> & {
  generation?: string;
  nextDueAt: string;
  sortKey: string;
  sourceVersion: string;
  state: DueWorkProjectionState;
};

export type DueWorkRow<WorkKind extends string = string> = DueWorkIdentity<WorkKind> & {
  claimExpiresAt: null | string;
  claimToken: null | string;
  claimedBy: null | string;
  generation: string;
  nextDueAt: string;
  sortKey: string;
  sourceVersion: string;
  state: DueWorkState;
  updatedAt: string;
};

export type DueWorkPage<WorkKind extends string = string> = {
  hasMore: boolean;
  items: DueWorkRow<WorkKind>[];
};

export type DueWorkClaim<WorkKind extends string = string> = DueWorkPage<WorkKind> & {
  claimExpiresAt: string;
  claimToken: string;
  promoted: number;
  reaped: number;
};

export type DueWorkRepairDefinition<WorkKind extends string> = {
  project: (
    marker: DueWorkRow<WorkKind>,
  ) => Promise<DueWorkProjection<WorkKind> | null> | DueWorkProjection<WorkKind> | null;
  subjectType: DueWorkSubjectType;
  workKind: WorkKind;
};

export type DueWorkRepairResult = {
  cursor: null | string;
  deferred: number;
  hasMore: boolean;
  repaired: number;
  scanned: number;
};

export type DueWorkRebuildCheckpoint<WorkKind extends string = string> = {
  completedAt: null | string;
  cursor: null | string;
  generation: string;
  projectedCount: number;
  scannedCount: number;
  startedAt: string;
  state: "complete" | "running";
  subjectType: DueWorkSubjectType;
  updatedAt: string;
  workKind: WorkKind;
};

export type DueWorkRebuildSource = {
  cursor: string;
  sourceVersion: string;
  subjectId: string;
};

export type DueWorkRebuildDefinition<
  WorkKind extends string,
  Source extends DueWorkRebuildSource,
> = {
  project: (
    source: Source,
    context: { generation: string; now: string },
  ) => DueWorkProjection<WorkKind> | null;
  readSourceChunk: (context: {
    after: null | string;
    client: DueWorkClient;
    limit: number;
  }) => Promise<Source[]>;
  subjectType: DueWorkSubjectType;
  workKind: WorkKind;
};

export type DueWorkRebuildChunkResult<WorkKind extends string = string> = {
  checkpoint: DueWorkRebuildCheckpoint<WorkKind>;
  complete: boolean;
  noOp: boolean;
  projected: number;
  scanned: number;
};

export type DueWorkDrift<WorkKind extends string = string> = {
  mismatched: {
    actual: DueWorkRow<WorkKind>;
    expected: DueWorkProjection<WorkKind>;
    fields: string[];
  }[];
  missing: DueWorkProjection<WorkKind>[];
  unexpected: DueWorkRow<WorkKind>[];
};

type DueWorkSqlRow = {
  claim_expires_at: null | string;
  claim_token: null | string;
  claimed_by: null | string;
  generation: string;
  next_due_at: string;
  sort_key: string;
  source_version: string;
  state: string;
  subject_id: string;
  subject_type: string;
  updated_at: string;
  work_kind: string;
};

type RebuildSqlRow = {
  completed_at: null | string;
  cursor: null | string;
  generation: string;
  projected_count: number;
  scanned_count: number;
  started_at: string;
  state: string;
  subject_type: string;
  updated_at: string;
  work_kind: string;
};

const DUE_WORK_COLUMNS = `claim_expires_at, claim_token, claimed_by, generation, next_due_at,
  sort_key, source_version, state, subject_id, subject_type, updated_at, work_kind`;
const REBUILD_COLUMNS = `completed_at, cursor, generation, projected_count, scanned_count,
  started_at, state, subject_type, updated_at, work_kind`;

function assertNonEmpty(value: string, name: string): void {
  if (!value.trim()) {
    throw new Error(`${name} must not be empty`);
  }
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DUE_WORK_CHUNK_SIZE) {
    throw new Error(`due-work limit must be an integer from 1 through ${MAX_DUE_WORK_CHUNK_SIZE}`);
  }
}

function iso(value: Date | string, name: string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${name} must be a valid timestamp`);
  }
  return date.toISOString();
}

function nowIso(now: (() => Date) | undefined): string {
  return (now ?? (() => new Date()))().toISOString();
}

function randomToken(): string {
  return crypto.randomUUID();
}

function dueWorkRow<WorkKind extends string>(row: DueWorkSqlRow): DueWorkRow<WorkKind> {
  if (
    row.state !== "leased" &&
    row.state !== "ready" &&
    row.state !== "repair" &&
    row.state !== "scheduled"
  ) {
    throw new Error(`invalid due-work state: ${row.state}`);
  }
  if (
    row.subject_type !== "album" &&
    row.subject_type !== "artist" &&
    row.subject_type !== "label" &&
    row.subject_type !== "track"
  ) {
    throw new Error(`invalid due-work subject type: ${row.subject_type}`);
  }

  return {
    claimExpiresAt: row.claim_expires_at,
    claimToken: row.claim_token,
    claimedBy: row.claimed_by,
    generation: row.generation,
    nextDueAt: row.next_due_at,
    sortKey: row.sort_key,
    sourceVersion: row.source_version,
    state: row.state,
    subjectId: row.subject_id,
    subjectType: row.subject_type,
    updatedAt: row.updated_at,
    workKind: row.work_kind as WorkKind,
  };
}

function dueWorkRows<WorkKind extends string>(result: ResultSet): DueWorkRow<WorkKind>[] {
  return (result.rows as unknown as DueWorkSqlRow[]).map(dueWorkRow<WorkKind>);
}

function rebuildRow<WorkKind extends string>(
  row: RebuildSqlRow,
): DueWorkRebuildCheckpoint<WorkKind> {
  if (row.state !== "complete" && row.state !== "running") {
    throw new Error(`invalid due-work rebuild state: ${row.state}`);
  }
  if (
    row.subject_type !== "album" &&
    row.subject_type !== "artist" &&
    row.subject_type !== "label" &&
    row.subject_type !== "track"
  ) {
    throw new Error(`invalid due-work rebuild subject type: ${row.subject_type}`);
  }

  return {
    completedAt: row.completed_at,
    cursor: row.cursor,
    generation: row.generation,
    projectedCount: Number(row.projected_count),
    scannedCount: Number(row.scanned_count),
    startedAt: row.started_at,
    state: row.state,
    subjectType: row.subject_type,
    updatedAt: row.updated_at,
    workKind: row.work_kind as WorkKind,
  };
}

function projectionValues<WorkKind extends string>(
  projection: DueWorkProjection<WorkKind>,
  updatedAt: string,
): [string, DueWorkSubjectType, string, string, string, string, string, string, string] {
  assertNonEmpty(projection.workKind, "work kind");
  assertNonEmpty(projection.subjectId, "subject id");
  assertNonEmpty(projection.sourceVersion, "source version");
  const nextDueAt = iso(projection.nextDueAt, "next due time");

  return [
    projection.workKind,
    projection.subjectType,
    projection.subjectId,
    projection.state,
    projection.sortKey,
    nextDueAt,
    projection.sourceVersion,
    projection.generation ?? DUE_WORK_LIVE_GENERATION,
    updatedAt,
  ];
}

export function upsertDueWorkStatement<WorkKind extends string>(
  projection: DueWorkProjection<WorkKind>,
  options: { now?: Date | string } = {},
): InStatement {
  const updatedAt = iso(options.now ?? new Date(), "updated time");

  return {
    args: projectionValues(projection, updatedAt),
    sql: `insert into due_work
      (work_kind, subject_type, subject_id, state, sort_key, next_due_at,
       source_version, generation, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  };
}

export async function upsertDueWork<WorkKind extends string>(
  client: DueWorkClient,
  projection: DueWorkProjection<WorkKind>,
  options: { now?: Date | string } = {},
): Promise<void> {
  await client.execute(upsertDueWorkStatement(projection, options));
}

export function deleteDueWorkStatement<WorkKind extends string>(
  identity: DueWorkIdentity<WorkKind>,
): InStatement {
  return {
    args: [identity.workKind, identity.subjectType, identity.subjectId],
    sql: `delete from due_work
      where work_kind = ? and subject_type = ? and subject_id = ?`,
  };
}

export async function deleteDueWork<WorkKind extends string>(
  client: DueWorkClient,
  identity: DueWorkIdentity<WorkKind>,
): Promise<boolean> {
  const result = await client.execute(deleteDueWorkStatement(identity));
  return result.rowsAffected > 0;
}

export function markDueWorkRepairStatement<WorkKind extends string>(
  identity: DueWorkIdentity<WorkKind> & { sourceVersion: string },
  options: { generation?: string; now?: Date | string } = {},
): DueWorkStatement {
  const updatedAt = iso(options.now ?? new Date(), "updated time");
  assertNonEmpty(identity.sourceVersion, "source version");

  return {
    args: [
      identity.workKind,
      identity.subjectType,
      identity.subjectId,
      updatedAt,
      identity.sourceVersion,
      options.generation ?? DUE_WORK_LIVE_GENERATION,
      updatedAt,
    ],
    sql: `insert into due_work
      (work_kind, subject_type, subject_id, state, sort_key, next_due_at,
       source_version, generation, updated_at)
      values (?, ?, ?, 'repair', '', ?, ?, ?, ?)
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
  };
}

export async function markDueWorkRepair<WorkKind extends string>(
  client: DueWorkClient,
  identity: DueWorkIdentity<WorkKind> & { sourceVersion: string },
  options: { generation?: string; now?: Date | string } = {},
): Promise<void> {
  await client.execute(markDueWorkRepairStatement(identity, options));
}

function uniqueSourceSubjects(subjects: readonly DueWorkSourceSubject[]): DueWorkSourceSubject[] {
  const unique = new Map<string, DueWorkSourceSubject>();

  for (const subject of subjects) {
    assertNonEmpty(subject.subjectId, "source repair subject id");
    unique.set(`${subject.subjectType}\u0000${subject.subjectId}`, subject);
  }

  const values = [...unique.values()];
  if (values.length === 0 || values.length > MAX_DUE_WORK_CHUNK_SIZE) {
    throw new Error(
      `due-work source repair batches must contain 1 through ${MAX_DUE_WORK_CHUNK_SIZE} subjects`,
    );
  }
  return values;
}

/**
 * Mark each changed source subject once, independently of how many physical queues derive from it.
 * Producers append this statement to the same write batch as the source mutation. The opaque token
 * lets reconciliation clear only the snapshot it evaluated, so a concurrent source write survives.
 */
export function markDueWorkSourceRepairsStatement(
  subjects: readonly DueWorkSourceSubject[],
  options: {
    markerVersion?: string;
    now?: Date | string;
    onlyIfPreviousStatementChanged?: boolean;
    producer: string;
  },
): DueWorkStatement {
  const unique = uniqueSourceSubjects(subjects);
  const updatedAt = iso(options.now ?? new Date(), "updated time");
  assertNonEmpty(options.producer, "due-work producer");
  const markerVersion = options.markerVersion ?? `${options.producer}:${randomToken()}`;
  assertNonEmpty(markerVersion, "source repair marker version");
  const rows = unique
    .map(
      () =>
        "select ? as work_kind, ? as subject_type, ? as subject_id, 'repair' as state, '' as sort_key, ? as next_due_at, ? as source_version, ? as generation, ? as updated_at",
    )
    .join(" union all ");
  const args = unique.flatMap((subject) => [
    DUE_WORK_SOURCE_REPAIR_KIND,
    subject.subjectType,
    subject.subjectId,
    updatedAt,
    markerVersion,
    DUE_WORK_LIVE_GENERATION,
    updatedAt,
  ]);

  return {
    args,
    sql: `insert into due_work
      (work_kind, subject_type, subject_id, state, sort_key, next_due_at,
       source_version, generation, updated_at)
      select * from (${rows})
      where 1 = 1${options.onlyIfPreviousStatementChanged === true ? " and changes() > 0" : ""}
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
  };
}

/** Clear a source marker only when no later producer has replaced its race token. */
export function clearDueWorkSourceRepairStatement(
  marker: DueWorkSourceSubject & { sourceVersion: string },
): DueWorkStatement {
  assertNonEmpty(marker.sourceVersion, "source repair marker version");
  return {
    args: [DUE_WORK_SOURCE_REPAIR_KIND, marker.subjectType, marker.subjectId, marker.sourceVersion],
    sql: `delete from due_work
      where work_kind = ? and subject_type = ? and subject_id = ?
        and state = 'repair' and source_version = ?`,
  };
}

/** Mark the subjects returned as `subject_id` by a bounded, producer-owned selection query. */
export function markDueWorkSourceRepairsFromSelectStatement(
  subjectType: DueWorkSubjectType,
  selection: DueWorkPositionalStatement,
  options: { markerVersion?: string; now?: Date | string; producer: string },
): DueWorkStatement {
  assertNonEmpty(selection.sql, "source repair selection");
  assertNonEmpty(options.producer, "due-work producer");
  const updatedAt = iso(options.now ?? new Date(), "updated time");
  const markerVersion = options.markerVersion ?? `${options.producer}:${randomToken()}`;
  assertNonEmpty(markerVersion, "source repair marker version");

  return {
    args: [
      DUE_WORK_SOURCE_REPAIR_KIND,
      subjectType,
      updatedAt,
      markerVersion,
      DUE_WORK_LIVE_GENERATION,
      updatedAt,
      ...(selection.args ?? []),
    ],
    sql: `insert into due_work
      (work_kind, subject_type, subject_id, state, sort_key, next_due_at,
       source_version, generation, updated_at)
      select distinct ?, ?, source.subject_id, 'repair', '', ?, ?, ?, ?
      from (${selection.sql}) source
      where source.subject_id is not null and trim(source.subject_id) <> ''
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
  };
}

/**
 * Append the legacy due-work marker and every public shadow marker with one race token and time.
 * The returned statements belong immediately after the bounded source statement they describe.
 */
export function markDueWorkSourceMaintenanceStatements(
  subjects: readonly DueWorkSourceSubject[],
  options: {
    markerVersion?: string;
    now?: Date | string;
    onlyIfPreviousStatementChanged?: boolean;
    producer: string;
  },
): DueWorkStatement[] {
  const updatedAt = iso(options.now ?? new Date(), "updated time");
  assertNonEmpty(options.producer, "due-work producer");
  const markerVersion = options.markerVersion ?? `${options.producer}:${randomToken()}`;
  assertNonEmpty(markerVersion, "source repair marker version");
  return [
    markDueWorkSourceRepairsStatement(subjects, {
      markerVersion,
      now: updatedAt,
      onlyIfPreviousStatementChanged: options.onlyIfPreviousStatementChanged,
      producer: options.producer,
    }),
    ...markPublicProjectionSourceChangedStatements(subjects, markerVersion, {
      now: updatedAt,
      onlyIfPreviousStatementChanged: true,
    }),
  ];
}

/**
 * Build both maintenance rails from one bounded producer-owned `subject_id` selection. The legacy
 * marker is first because its affected-row count is the public epoch admission gate.
 */
export function markDueWorkSourceMaintenanceFromSelectStatements(
  subjectType: DueWorkSubjectType,
  selection: DueWorkPositionalStatement,
  options: {
    markerVersion?: string;
    now?: Date | string;
    producer: string;
  },
): DueWorkStatement[] {
  const updatedAt = iso(options.now ?? new Date(), "updated time");
  assertNonEmpty(options.producer, "due-work producer");
  const markerVersion = options.markerVersion ?? `${options.producer}:${randomToken()}`;
  assertNonEmpty(markerVersion, "source repair marker version");
  return [
    markDueWorkSourceRepairsFromSelectStatement(subjectType, selection, {
      markerVersion,
      now: updatedAt,
      producer: options.producer,
    }),
    ...markPublicProjectionSourceChangedFromSelectStatements(
      subjectType,
      selection,
      markerVersion,
      { now: updatedAt },
    ),
  ];
}

/** Execute a bounded source mutation and its repair marker in one libSQL write transaction. */
export async function batchDueWorkSourceMutation(
  client: DueWorkClient,
  statements: readonly InStatement[],
  subjects: readonly DueWorkSourceSubject[],
  options: {
    markerVersion?: string;
    now?: Date | string;
    onlyIfLastSourceStatementChanged?: boolean;
    producer: string;
  },
): Promise<ResultSet[]> {
  if (statements.length === 0) {
    throw new Error("due-work source mutation batches must contain at least one source statement");
  }

  const maintenance = markDueWorkSourceMaintenanceStatements(subjects, {
    markerVersion: options.markerVersion,
    now: options.now,
    onlyIfPreviousStatementChanged: options.onlyIfLastSourceStatementChanged,
    producer: options.producer,
  });
  if (statements.length + maintenance.length > MAX_DUE_WORK_CHUNK_SIZE) {
    throw new Error(
      `due-work source mutation batches may contain at most ${MAX_DUE_WORK_CHUNK_SIZE - maintenance.length} source statements for their maintenance shape`,
    );
  }

  return client.batch([...statements, ...maintenance], "write");
}

export async function listReadyDueWork<WorkKind extends string>(
  client: DueWorkClient,
  workKind: WorkKind,
  options: { limit?: number } = {},
): Promise<DueWorkPage<WorkKind>> {
  const limit = options.limit ?? 100;
  assertLimit(limit);
  const result = await client.execute({
    args: [workKind, limit + 1],
    sql: `select ${DUE_WORK_COLUMNS}
      from due_work
      where work_kind = ? and state = 'ready'
      order by sort_key, subject_id
      limit ?`,
  });
  const rows = dueWorkRows<WorkKind>(result);

  return { hasMore: rows.length > limit, items: rows.slice(0, limit) };
}

export async function hasReadyDueWork(client: DueWorkClient, workKind: string): Promise<boolean> {
  const result = await client.execute({
    args: [workKind],
    sql: `select subject_id
      from due_work
      where work_kind = ? and state = 'ready'
      order by sort_key, subject_id
      limit 1`,
  });
  return result.rows.length > 0;
}

/**
 * Count work that can be handed out now without consulting a source table. Ready rows and
 * scheduled rows whose retry time has elapsed are counted through their two partial indexes;
 * leases and future retries are deliberately excluded.
 */
export async function countDueWorkNow(
  client: DueWorkClient,
  workKind: string,
  options: { now?: () => Date } = {},
): Promise<number> {
  const now = nowIso(options.now);
  const results = await client.batch([
    {
      args: [workKind],
      sql: `select count(*) as queued
        from due_work
        where work_kind = ? and state = 'ready'`,
    },
    {
      args: [workKind, now],
      sql: `select count(*) as queued
        from due_work
        where work_kind = ? and state = 'scheduled' and next_due_at <= ?`,
    },
  ]);

  return results.reduce(
    (total, result) =>
      total + Number((result.rows[0] as { queued?: bigint | number } | undefined)?.queued ?? 0),
    0,
  );
}

/** Read a bounded page of transactionally coupled source-repair markers. */
export async function listDueWorkSourceRepairs(
  client: DueWorkClient,
  options: {
    excludeSubjectId?: string;
    limit?: number;
    subjectType?: DueWorkSubjectType;
  } = {},
): Promise<DueWorkPage<typeof DUE_WORK_SOURCE_REPAIR_KIND>> {
  const limit = options.limit ?? 10;
  assertLimit(limit);
  const clauses = ["work_kind = ?", "state = 'repair'"];
  const args: Array<number | string> = [DUE_WORK_SOURCE_REPAIR_KIND];
  if (options.subjectType !== undefined) {
    clauses.push("subject_type = ?");
    args.push(options.subjectType);
  }
  if (options.excludeSubjectId !== undefined) {
    clauses.push("subject_id <> ?");
    args.push(options.excludeSubjectId);
  }
  args.push(limit + 1);
  const result = await client.execute({
    args,
    sql: `select ${DUE_WORK_COLUMNS}
      from due_work
      where ${clauses.join(" and ")}
      order by subject_type, subject_id
      limit ?`,
  });
  const rows = dueWorkRows<typeof DUE_WORK_SOURCE_REPAIR_KIND>(result);
  return { hasMore: rows.length > limit, items: rows.slice(0, limit) };
}

function promoteStatement(workKind: string, now: string, limit: number): InStatement {
  return {
    args: [now, workKind, now, limit],
    sql: `update due_work
      set state = 'ready', updated_at = ?
      where (work_kind, subject_type, subject_id) in (
        select work_kind, subject_type, subject_id
        from due_work
        where work_kind = ? and state = 'scheduled' and next_due_at <= ?
        order by next_due_at, subject_id
        limit ?
      )`,
  };
}

export async function promoteDueWork(
  client: DueWorkClient,
  workKind: string,
  options: { limit?: number; now?: () => Date } = {},
): Promise<number> {
  const limit = options.limit ?? 100;
  assertLimit(limit);
  const result = await client.execute(promoteStatement(workKind, nowIso(options.now), limit));
  return result.rowsAffected;
}

/** Probe whether another overdue scheduled row remains after one bounded promotion page. */
export async function hasDueScheduledWork(
  client: DueWorkClient,
  workKind: string,
  options: { now?: () => Date } = {},
): Promise<boolean> {
  const result = await client.execute({
    args: [workKind, nowIso(options.now)],
    sql: `select subject_id from due_work
      where work_kind = ? and state = 'scheduled' and next_due_at <= ?
      order by next_due_at, subject_id
      limit 1`,
  });
  return result.rows.length > 0;
}

function reapStatement(workKind: string | undefined, now: string, limit: number): InStatement {
  const kindClause = workKind === undefined ? "" : " and work_kind = ?";
  const args = workKind === undefined ? [now, now, now, limit] : [now, now, workKind, now, limit];

  return {
    args,
    sql: `update due_work
      set state = case when next_due_at <= ? then 'ready' else 'scheduled' end,
          claim_token = null,
          claim_expires_at = null,
          claimed_by = null,
          updated_at = ?
      where (work_kind, subject_type, subject_id) in (
        select work_kind, subject_type, subject_id
        from due_work
        where state = 'leased'${kindClause} and claim_expires_at <= ?
        order by claim_expires_at, work_kind, subject_id
        limit ?
      )`,
  };
}

export async function reapExpiredDueWorkLeases(
  client: DueWorkClient,
  options: { limit?: number; now?: () => Date; workKind?: string } = {},
): Promise<number> {
  const limit = options.limit ?? 100;
  assertLimit(limit);
  const now = nowIso(options.now);
  const result = await client.execute(reapStatement(options.workKind, now, limit));
  return result.rowsAffected;
}

export async function claimDueWork<WorkKind extends string>(
  client: DueWorkClient,
  workKind: WorkKind,
  options: {
    claimedBy: string;
    leaseMs: number;
    limit?: number;
    maintenanceLimit?: number;
    now?: () => Date;
    token?: string;
  },
): Promise<DueWorkClaim<WorkKind>> {
  const limit = options.limit ?? 100;
  const maintenanceLimit = options.maintenanceLimit ?? MAX_DUE_WORK_CHUNK_SIZE;
  assertLimit(limit);
  assertLimit(maintenanceLimit);
  assertNonEmpty(options.claimedBy, "claim owner");
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 1) {
    throw new Error("due-work lease must be a positive integer number of milliseconds");
  }

  const now = nowIso(options.now);
  const claimExpiresAt = new Date(new Date(now).getTime() + options.leaseMs).toISOString();
  const claimToken = options.token ?? randomToken();
  assertNonEmpty(claimToken, "claim token");
  const results = await client.batch(
    [
      promoteStatement(workKind, now, maintenanceLimit),
      reapStatement(workKind, now, maintenanceLimit),
      {
        args: [
          claimToken,
          claimExpiresAt,
          options.claimedBy,
          now,
          workKind,
          limit,
          workKind,
          now,
          workKind,
          options.claimedBy,
          claimToken,
        ],
        sql: `update due_work
          set state = 'leased', claim_token = ?, claim_expires_at = ?, claimed_by = ?, updated_at = ?
          where (work_kind, subject_type, subject_id) in (
            select work_kind, subject_type, subject_id
            from due_work
            where work_kind = ? and state = 'ready'
            order by sort_key, subject_id
            limit ?
          )
          and not exists (
            select 1 from due_work scheduled_due
            where scheduled_due.work_kind = ? and scheduled_due.state = 'scheduled'
              and scheduled_due.next_due_at <= ?
          )
          and not exists (
            select 1 from due_work existing_claim
            where existing_claim.work_kind = ? and existing_claim.state = 'leased'
              and existing_claim.claimed_by = ? and existing_claim.claim_token = ?
          )`,
      },
      {
        args: [workKind, options.claimedBy, claimToken],
        sql: `select ${DUE_WORK_COLUMNS} from due_work
          where work_kind = ? and state = 'leased' and claimed_by = ? and claim_token = ?
          order by sort_key, subject_id`,
      },
      {
        args: [workKind],
        sql: `select subject_id from due_work
          where work_kind = ? and state = 'ready'
          order by sort_key, subject_id
          limit 1`,
      },
    ],
    "write",
  );
  const claimResult = results[3];
  const claimed = claimResult === undefined ? [] : dueWorkRows<WorkKind>(claimResult);
  claimed.sort((left, right) =>
    left.sortKey === right.sortKey
      ? left.subjectId.localeCompare(right.subjectId)
      : left.sortKey.localeCompare(right.sortKey),
  );

  if (
    claimed.length === 0 &&
    (await hasDueScheduledWork(client, workKind, { now: () => new Date(now) }))
  ) {
    throw new DueWorkMaintenancePendingError(workKind);
  }

  return {
    claimExpiresAt: claimed[0]?.claimExpiresAt ?? claimExpiresAt,
    claimToken,
    hasMore: (results[4]?.rows.length ?? 0) > 0,
    items: claimed,
    promoted: results[0]?.rowsAffected ?? 0,
    reaped: results[1]?.rowsAffected ?? 0,
  };
}

export async function completeDueWorkClaim<WorkKind extends string>(
  client: DueWorkClient,
  identity: DueWorkIdentity<WorkKind> & { claimToken: string },
): Promise<boolean> {
  const result = await client.execute({
    args: [identity.workKind, identity.subjectType, identity.subjectId, identity.claimToken],
    sql: `delete from due_work
      where work_kind = ? and subject_type = ? and subject_id = ?
        and state = 'leased' and claim_token = ?`,
  });
  return result.rowsAffected > 0;
}

export async function rescheduleDueWorkClaim<WorkKind extends string>(
  client: DueWorkClient,
  identity: DueWorkIdentity<WorkKind> & { claimToken: string },
  options: { nextDueAt: Date | string; now?: Date | string; sortKey?: string },
): Promise<boolean> {
  const nextDueAt = iso(options.nextDueAt, "next due time");
  const updatedAt = iso(options.now ?? new Date(), "updated time");
  const state: DueWorkProjectionState = nextDueAt <= updatedAt ? "ready" : "scheduled";
  const result = await client.execute({
    args: [
      state,
      nextDueAt,
      options.sortKey ?? null,
      updatedAt,
      identity.workKind,
      identity.subjectType,
      identity.subjectId,
      identity.claimToken,
    ],
    sql: `update due_work
      set state = ?, next_due_at = ?, sort_key = coalesce(?, sort_key),
          claim_token = null, claim_expires_at = null, claimed_by = null, updated_at = ?
      where work_kind = ? and subject_type = ? and subject_id = ?
        and state = 'leased' and claim_token = ?`,
  });
  return result.rowsAffected > 0;
}

function conditionalRepairProjectionStatement<WorkKind extends string>(
  projection: DueWorkProjection<WorkKind>,
  marker: DueWorkRow<WorkKind>,
  updatedAt: string,
): InStatement {
  const values = projectionValues(projection, updatedAt);
  return {
    args: [...values, marker.sourceVersion],
    sql: `insert into due_work
      (work_kind, subject_type, subject_id, state, sort_key, next_due_at,
       source_version, generation, updated_at)
      select ?, ?, ?, ?, ?, ?, ?, ?, ?
      where exists (
        select 1 from due_work
        where work_kind = ?1 and subject_type = ?2 and subject_id = ?3
          and state = 'repair' and source_version = ?10
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
        updated_at = excluded.updated_at
      returning subject_id`,
  };
}

export async function repairDueWorkChunk<WorkKind extends string>(
  client: DueWorkClient,
  definition: DueWorkRepairDefinition<WorkKind>,
  options: { after?: string; limit?: number; now?: () => Date } = {},
): Promise<DueWorkRepairResult> {
  const limit = options.limit ?? 100;
  assertLimit(limit);
  const result = await client.execute({
    args: [definition.subjectType, definition.workKind, options.after ?? "", limit + 1],
    sql: `select ${DUE_WORK_COLUMNS}
      from due_work
      where state = 'repair' and subject_type = ? and work_kind = ? and subject_id > ?
      order by subject_id
      limit ?`,
  });
  const markers = dueWorkRows<WorkKind>(result);
  const hasMore = markers.length > limit;
  const page = markers.slice(0, limit);
  let deferred = 0;
  let repaired = 0;

  for (const marker of page) {
    const projection = await definition.project(marker);
    const updatedAt = nowIso(options.now);
    const write =
      projection === null
        ? {
            args: [marker.workKind, marker.subjectType, marker.subjectId, marker.sourceVersion],
            sql: `delete from due_work
              where work_kind = ? and subject_type = ? and subject_id = ?
                and state = 'repair' and source_version = ?
              returning subject_id`,
          }
        : conditionalRepairProjectionStatement(projection, marker, updatedAt);
    const applied = await client.execute(write);
    if (applied.rows.length > 0) {
      repaired += 1;
    } else {
      deferred += 1;
    }
  }

  return {
    cursor: page[page.length - 1]?.subjectId ?? null,
    deferred,
    hasMore,
    repaired,
    scanned: page.length,
  };
}

export async function readDueWorkRebuild<WorkKind extends string>(
  client: DueWorkClient,
  identity: Pick<DueWorkIdentity<WorkKind>, "subjectType" | "workKind">,
): Promise<DueWorkRebuildCheckpoint<WorkKind> | undefined> {
  const result = await client.execute({
    args: [identity.workKind, identity.subjectType],
    sql: `select ${REBUILD_COLUMNS} from due_work_rebuilds
      where work_kind = ? and subject_type = ?`,
  });
  const row = result.rows[0] as unknown as RebuildSqlRow | undefined;
  return row === undefined ? undefined : rebuildRow<WorkKind>(row);
}

export async function startDueWorkRebuild<WorkKind extends string>(
  client: DueWorkClient,
  identity: Pick<DueWorkIdentity<WorkKind>, "subjectType" | "workKind">,
  options: { generation?: string; newGeneration?: boolean; now?: () => Date } = {},
): Promise<DueWorkRebuildCheckpoint<WorkKind>> {
  const now = nowIso(options.now);
  const generation = options.generation ?? randomToken();
  if (generation === DUE_WORK_LIVE_GENERATION) {
    throw new Error("due-work rebuild generation 'live' is reserved for transactional repairs");
  }
  const restart = options.newGeneration === true ? 1 : 0;
  const results = await client.batch(
    [
      {
        args: [identity.workKind, identity.subjectType, generation, now, now, restart],
        sql: `insert into due_work_rebuilds
          (work_kind, subject_type, generation, cursor, scanned_count, projected_count,
           state, started_at, updated_at, completed_at)
          values (?, ?, ?, null, 0, 0, 'running', ?, ?, null)
          on conflict(work_kind, subject_type) do update set
            generation = excluded.generation,
            cursor = null,
            scanned_count = 0,
            projected_count = 0,
            state = 'running',
            started_at = excluded.started_at,
            updated_at = excluded.updated_at,
            completed_at = null
          where ? = 1`,
      },
      {
        args: [identity.workKind, identity.subjectType],
        sql: `select ${REBUILD_COLUMNS} from due_work_rebuilds
          where work_kind = ? and subject_type = ?`,
      },
    ],
    "write",
  );
  const row = results[1]?.rows[0] as unknown as RebuildSqlRow | undefined;
  if (row === undefined) {
    throw new Error("due-work rebuild checkpoint was not created");
  }
  return rebuildRow<WorkKind>(row);
}

function checkpointGuard(
  workKind: string,
  subjectType: DueWorkSubjectType,
  generation: string,
  cursor: null | string,
): { args: (null | string)[]; sql: string } {
  return {
    args: [workKind, subjectType, generation, cursor],
    sql: `work_kind = ? and subject_type = ? and generation = ? and state = 'running'
      and cursor is ?`,
  };
}

function guardedRebuildProjectionStatement<WorkKind extends string>(
  projection: DueWorkProjection<WorkKind>,
  checkpoint: DueWorkRebuildCheckpoint<WorkKind>,
  updatedAt: string,
): InStatement {
  const values = projectionValues(projection, updatedAt);
  const guard = checkpointGuard(
    checkpoint.workKind,
    checkpoint.subjectType,
    checkpoint.generation,
    checkpoint.cursor,
  );
  return {
    args: [...values, ...guard.args, checkpoint.startedAt],
    sql: `insert into due_work
      (work_kind, subject_type, subject_id, state, sort_key, next_due_at,
       source_version, generation, updated_at)
      select ?, ?, ?, ?, ?, ?, ?, ?, ?
      where exists (select 1 from due_work_rebuilds where ${guard.sql})
      on conflict(work_kind, subject_type, subject_id) do update set
        state = excluded.state,
        sort_key = excluded.sort_key,
        next_due_at = excluded.next_due_at,
        source_version = excluded.source_version,
        generation = excluded.generation,
        claim_token = null,
        claim_expires_at = null,
        claimed_by = null,
        updated_at = excluded.updated_at
      where due_work.state <> 'repair'
        and (due_work.generation <> 'live' or due_work.updated_at < ?)`,
  };
}

async function finishRebuild<WorkKind extends string>(
  client: DueWorkClient,
  checkpoint: DueWorkRebuildCheckpoint<WorkKind>,
  updatedAt: string,
): Promise<DueWorkRebuildCheckpoint<WorkKind>> {
  const guard = checkpointGuard(
    checkpoint.workKind,
    checkpoint.subjectType,
    checkpoint.generation,
    checkpoint.cursor,
  );
  await client.batch(
    [
      {
        args: [
          checkpoint.workKind,
          checkpoint.subjectType,
          checkpoint.generation,
          checkpoint.startedAt,
          ...guard.args,
        ],
        sql: `delete from due_work
          where work_kind = ? and subject_type = ? and generation <> ?
            and state <> 'repair' and (generation <> 'live' or updated_at < ?)
            and exists (select 1 from due_work_rebuilds where ${guard.sql})`,
      },
      {
        args: [updatedAt, updatedAt, ...guard.args],
        sql: `update due_work_rebuilds
          set state = 'complete', completed_at = ?, updated_at = ?
          where ${guard.sql}`,
      },
    ],
    "write",
  );
  const current = await readDueWorkRebuild(client, checkpoint);
  if (current === undefined) {
    throw new Error("due-work rebuild checkpoint disappeared during completion");
  }
  return current;
}

export async function runDueWorkRebuildChunk<
  WorkKind extends string,
  Source extends DueWorkRebuildSource,
>(
  client: DueWorkClient,
  definition: DueWorkRebuildDefinition<WorkKind, Source>,
  options: {
    generation?: string;
    limit?: number;
    newGeneration?: boolean;
    now?: () => Date;
  } = {},
): Promise<DueWorkRebuildChunkResult<WorkKind>> {
  const limit = options.limit ?? 100;
  assertLimit(limit);
  const checkpoint = await startDueWorkRebuild(client, definition, options);
  if (checkpoint.state === "complete") {
    return { checkpoint, complete: true, noOp: true, projected: 0, scanned: 0 };
  }

  const sources = await definition.readSourceChunk({
    after: checkpoint.cursor,
    client,
    limit,
  });
  if (sources.length > limit) {
    throw new Error(`due-work source reader returned more than its ${limit}-row bound`);
  }
  let previous = checkpoint.cursor;
  for (const source of sources) {
    assertNonEmpty(source.cursor, "source cursor");
    assertNonEmpty(source.subjectId, "source subject id");
    assertNonEmpty(source.sourceVersion, "source version");
    if (previous !== null && source.cursor <= previous) {
      throw new Error("due-work source cursors must be strictly increasing");
    }
    previous = source.cursor;
  }

  const updatedAt = nowIso(options.now);
  if (sources.length === 0) {
    const completed = await finishRebuild(client, checkpoint, updatedAt);
    return {
      checkpoint: completed,
      complete: completed.state === "complete",
      noOp: false,
      projected: 0,
      scanned: 0,
    };
  }

  const projections = sources.flatMap((source) => {
    const projected = definition.project(source, {
      generation: checkpoint.generation,
      now: updatedAt,
    });
    if (projected === null) {
      return [];
    }
    if (
      projected.workKind !== definition.workKind ||
      projected.subjectType !== definition.subjectType ||
      projected.subjectId !== source.subjectId ||
      projected.sourceVersion !== source.sourceVersion
    ) {
      throw new Error(
        "due-work rebuild projection must preserve its definition and source identity",
      );
    }
    return [{ ...projected, generation: checkpoint.generation }];
  });
  const nextCursor = sources[sources.length - 1]?.cursor;
  if (nextCursor === undefined) {
    throw new Error("due-work source chunk lost its terminal cursor");
  }
  const guard = checkpointGuard(
    checkpoint.workKind,
    checkpoint.subjectType,
    checkpoint.generation,
    checkpoint.cursor,
  );
  const writes: InStatement[] = projections.map((projection) =>
    guardedRebuildProjectionStatement(projection, checkpoint, updatedAt),
  );
  writes.push({
    args: [nextCursor, sources.length, projections.length, updatedAt, ...guard.args],
    sql: `update due_work_rebuilds
      set cursor = ?, scanned_count = scanned_count + ?, projected_count = projected_count + ?,
          updated_at = ?
      where ${guard.sql}`,
  });

  const shouldComplete = sources.length < limit;
  if (shouldComplete) {
    const advancedGuard = checkpointGuard(
      checkpoint.workKind,
      checkpoint.subjectType,
      checkpoint.generation,
      nextCursor,
    );
    writes.push(
      {
        args: [
          checkpoint.workKind,
          checkpoint.subjectType,
          checkpoint.generation,
          checkpoint.startedAt,
          ...advancedGuard.args,
        ],
        sql: `delete from due_work
          where work_kind = ? and subject_type = ? and generation <> ?
            and state <> 'repair' and (generation <> 'live' or updated_at < ?)
            and exists (select 1 from due_work_rebuilds where ${advancedGuard.sql})`,
      },
      {
        args: [updatedAt, updatedAt, ...advancedGuard.args],
        sql: `update due_work_rebuilds
          set state = 'complete', completed_at = ?, updated_at = ?
          where ${advancedGuard.sql}`,
      },
    );
  }

  const results = await client.batch(writes, "write");
  const checkpointWrite = results[projections.length];
  const current = await readDueWorkRebuild(client, definition);
  if (current === undefined) {
    throw new Error("due-work rebuild checkpoint disappeared after a chunk");
  }

  return {
    checkpoint: current,
    complete: current.state === "complete",
    noOp: (checkpointWrite?.rowsAffected ?? 0) === 0,
    projected: (checkpointWrite?.rowsAffected ?? 0) > 0 ? projections.length : 0,
    scanned: (checkpointWrite?.rowsAffected ?? 0) > 0 ? sources.length : 0,
  };
}

export async function runDueWorkRebuildToCompletion<
  WorkKind extends string,
  Source extends DueWorkRebuildSource,
>(
  client: DueWorkClient,
  definition: DueWorkRebuildDefinition<WorkKind, Source>,
  options: {
    generation?: string;
    limit?: number;
    maxChunks?: number;
    newGeneration?: boolean;
    now?: () => Date;
  } = {},
): Promise<DueWorkRebuildCheckpoint<WorkKind>> {
  const maxChunks = options.maxChunks ?? 10_000;
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 1) {
    throw new Error("due-work rebuild maxChunks must be a positive integer");
  }

  for (let chunk = 0; chunk < maxChunks; chunk += 1) {
    const result = await runDueWorkRebuildChunk(client, definition, {
      ...options,
      newGeneration: chunk === 0 ? options.newGeneration : false,
    });
    if (result.complete) {
      return result.checkpoint;
    }
  }
  throw new Error(`due-work rebuild exceeded its ${maxChunks}-chunk safety bound`);
}

function projectionMismatchFields<WorkKind extends string>(
  expected: DueWorkProjection<WorkKind>,
  actual: DueWorkRow<WorkKind>,
): string[] {
  const fields: string[] = [];
  const expectedState = actual.state === "leased" ? "ready" : actual.state;
  if (expectedState !== expected.state) {
    fields.push("state");
  }
  if (actual.sortKey !== expected.sortKey) {
    fields.push("sortKey");
  }
  if (actual.nextDueAt !== iso(expected.nextDueAt, "next due time")) {
    fields.push("nextDueAt");
  }
  if (actual.sourceVersion !== expected.sourceVersion) {
    fields.push("sourceVersion");
  }
  if (actual.generation !== (expected.generation ?? DUE_WORK_LIVE_GENERATION)) {
    fields.push("generation");
  }
  return fields;
}

export function compareDueWorkRows<WorkKind extends string>(
  expected: readonly DueWorkProjection<WorkKind>[],
  actual: readonly DueWorkRow<WorkKind>[],
): DueWorkDrift<WorkKind> {
  if (expected.length > MAX_DUE_WORK_CHUNK_SIZE || actual.length > MAX_DUE_WORK_CHUNK_SIZE) {
    throw new Error(`due-work drift chunks may contain at most ${MAX_DUE_WORK_CHUNK_SIZE} rows`);
  }
  const key = (row: DueWorkIdentity<WorkKind>) =>
    `${row.workKind}\u0000${row.subjectType}\u0000${row.subjectId}`;
  const expectedByKey = new Map(expected.map((row) => [key(row), row]));
  const actualByKey = new Map(actual.map((row) => [key(row), row]));
  const missing = expected.filter((row) => !actualByKey.has(key(row)));
  const unexpected = actual.filter((row) => !expectedByKey.has(key(row)));
  const mismatched = expected.flatMap((row) => {
    const stored = actualByKey.get(key(row));
    if (stored === undefined) {
      return [];
    }
    const fields = projectionMismatchFields(row, stored);
    return fields.length === 0 ? [] : [{ actual: stored, expected: row, fields }];
  });
  return { mismatched, missing, unexpected };
}

export async function readDueWorkProjectionChunk<WorkKind extends string>(
  client: DueWorkClient,
  identity: Pick<DueWorkIdentity<WorkKind>, "subjectType" | "workKind">,
  options: { after?: string; generation?: string; limit?: number } = {},
): Promise<DueWorkPage<WorkKind>> {
  const limit = options.limit ?? 100;
  assertLimit(limit);
  const result = await client.execute({
    args: [
      identity.workKind,
      identity.subjectType,
      options.generation ?? DUE_WORK_LIVE_GENERATION,
      options.after ?? "",
      limit + 1,
    ],
    sql: `select ${DUE_WORK_COLUMNS} from due_work
      where work_kind = ? and subject_type = ? and generation = ? and subject_id > ?
        and state <> 'repair'
      order by subject_id
      limit ?`,
  });
  const rows = dueWorkRows<WorkKind>(result);
  return { hasMore: rows.length > limit, items: rows.slice(0, limit) };
}

/** Convenience for scripts that must use the same configured client as the Worker. */
export async function configuredDueWorkClient(): Promise<DueWorkClient> {
  return getDb();
}
