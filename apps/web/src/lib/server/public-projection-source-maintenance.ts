import { type InStatement, type InValue } from "@libsql/client";
import { createHash } from "node:crypto";

export const PUBLIC_PROJECTION_LIVE_GENERATION = "live";
export const PUBLIC_PROJECTION_SYNTHETIC_TRACK_SUBJECT_ID = "@catalogue-rank-corpus";

const EMPTY_DIGEST = createHash("sha256").digest("hex");

export type PublicProjectionStatement = Exclude<InStatement, string>;
export type PublicProjectionSourceSubject = {
  subjectId: string;
  subjectType: "album" | "artist" | "label" | "track";
};
export type PublicProjectionSourceSelection = { args?: InValue[]; sql: string };

type ProjectionRepairSubject = {
  subjectId: string;
  subjectType: "artist" | "label" | "track";
};

function assertNonEmpty(value: string, name: string): void {
  if (!value.trim()) {
    throw new Error(`${name} must not be empty`);
  }
}

function iso(value: Date | string, name: string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${name} must be a valid timestamp`);
  }
  return date.toISOString();
}

function uniqueProjectionSubjects(
  subjects: readonly PublicProjectionSourceSubject[],
): ProjectionRepairSubject[] {
  const unique = new Map<string, ProjectionRepairSubject>();
  for (const subject of subjects) {
    assertNonEmpty(subject.subjectId, "public projection subject id");
    if (subject.subjectType === "album") {
      continue;
    }
    if (
      subject.subjectType === "track" &&
      subject.subjectId === PUBLIC_PROJECTION_SYNTHETIC_TRACK_SUBJECT_ID
    ) {
      continue;
    }
    unique.set(`${subject.subjectType}\u0000${subject.subjectId}`, {
      subjectId: subject.subjectId,
      subjectType: subject.subjectType,
    });
  }
  return [...unique.values()];
}

function publicAggregateInitialStateStatement(now: string): PublicProjectionStatement {
  return {
    args: [now, now, now, EMPTY_DIGEST, EMPTY_DIGEST],
    sql: `insert into public_aggregate_state
      (scope, generation, cursor, scanned_count, source_entry_count,
       projected_entry_count, default_track_total, source_epoch, aggregate_epoch,
       rebuild_start_epoch, release_hub_order_epoch, state, started_at, updated_at,
       completed_at, source_digest, projected_digest)
      values ('tracks', '${PUBLIC_PROJECTION_LIVE_GENERATION}', null, 0, 0, 0, 0,
              0, 0, 0, 0, 'complete', ?, ?, ?, ?, ?)
      on conflict(scope) do nothing`,
  };
}

function artistQualificationInitialStateStatement(now: string): PublicProjectionStatement {
  return {
    args: [now, now, now, EMPTY_DIGEST, EMPTY_DIGEST],
    sql: `insert into artist_qualification_state
      (scope, generation, cursor, scanned_count, source_qualified_count,
       projected_qualified_count, source_epoch, projection_epoch, rebuild_start_epoch,
       state, started_at, updated_at, completed_at, source_digest, projected_digest)
      values ('artists', '${PUBLIC_PROJECTION_LIVE_GENERATION}', null, 0, 0, 0,
              0, 0, 0, 'complete', ?, ?, ?, ?, ?)
      on conflict(scope) do nothing`,
  };
}

export async function ensurePublicProjectionState(
  client: { batch: (statements: InStatement[], mode: "write") => Promise<unknown> },
  options: { now?: () => Date } = {},
): Promise<void> {
  const now = (options.now ?? (() => new Date()))().toISOString();
  await client.batch(
    [publicAggregateInitialStateStatement(now), artistQualificationInitialStateStatement(now)],
    "write",
  );
}

function advancePublicAggregateEpochStatement(
  now: string,
  onlyIfPreviousStatementChanged: boolean,
): PublicProjectionStatement {
  const condition = onlyIfPreviousStatementChanged ? "where changes() > 0" : "";
  return {
    args: [now, now, now, EMPTY_DIGEST, EMPTY_DIGEST],
    sql: `insert into public_aggregate_state
      (scope, generation, cursor, scanned_count, source_entry_count,
       projected_entry_count, default_track_total, source_epoch, aggregate_epoch,
       rebuild_start_epoch, release_hub_order_epoch, state, started_at, updated_at,
       completed_at, source_digest, projected_digest)
      select 'tracks', '${PUBLIC_PROJECTION_LIVE_GENERATION}', null, 0, 0, 0, 0,
             1, 0, 0, 0, 'complete', ?, ?, ?, ?, ? ${condition}
      on conflict(scope) do update set
        source_epoch = public_aggregate_state.source_epoch + 1,
        updated_at = excluded.updated_at`,
  };
}

function advanceArtistQualificationEpochStatement(
  now: string,
  onlyIfPreviousStatementChanged: boolean,
): PublicProjectionStatement {
  const condition = onlyIfPreviousStatementChanged ? "where changes() > 0" : "";
  return {
    args: [now, now, now, EMPTY_DIGEST, EMPTY_DIGEST],
    sql: `insert into artist_qualification_state
      (scope, generation, cursor, scanned_count, source_qualified_count,
       projected_qualified_count, source_epoch, projection_epoch, rebuild_start_epoch,
       state, started_at, updated_at, completed_at, source_digest, projected_digest)
      select 'artists', '${PUBLIC_PROJECTION_LIVE_GENERATION}', null, 0, 0, 0,
             1, 0, 0, 'complete', ?, ?, ?, ?, ? ${condition}
      on conflict(scope) do update set
        source_epoch = artist_qualification_state.source_epoch + 1,
        updated_at = excluded.updated_at`,
  };
}

function repairConflictClause(): string {
  return `on conflict(projection, subject_type, subject_id) do update set
    source_version = case
      when excluded.source_epoch >= projection_repairs.source_epoch
        then excluded.source_version else projection_repairs.source_version end,
    updated_at = case
      when excluded.source_epoch >= projection_repairs.source_epoch
        then excluded.updated_at else projection_repairs.updated_at end,
    source_epoch = max(projection_repairs.source_epoch, excluded.source_epoch)`;
}

function insertProjectionRepairsForSubjectsStatement(
  projection: "artist_qualification" | "public_aggregates",
  subjects: readonly ProjectionRepairSubject[],
  sourceVersion: string,
  now: string,
): PublicProjectionStatement {
  const stateTable =
    projection === "public_aggregates" ? "public_aggregate_state" : "artist_qualification_state";
  const scope = projection === "public_aggregates" ? "tracks" : "artists";
  const rows = subjects.map(() => "(?, ?)").join(", ");
  return {
    args: [
      ...subjects.flatMap((subject) => [subject.subjectType, subject.subjectId]),
      sourceVersion,
      now,
      now,
      scope,
    ],
    sql: `with source(subject_type, subject_id) as (values ${rows})
      insert into projection_repairs
        (projection, subject_type, subject_id, source_epoch, source_version, created_at, updated_at)
      select '${projection}', source.subject_type, source.subject_id, state.source_epoch, ?, ?, ?
      from source cross join ${stateTable} state
      where state.scope = ? and changes() > 0
      ${repairConflictClause()}`,
  };
}

function insertProjectionRepairsFromSelectionStatement(
  projection: "artist_qualification" | "public_aggregates",
  subjectType: "artist" | "label" | "track",
  selection: PublicProjectionSourceSelection,
  sourceVersion: string,
  now: string,
): PublicProjectionStatement {
  assertNonEmpty(selection.sql, "public projection source selection");
  const stateTable =
    projection === "public_aggregates" ? "public_aggregate_state" : "artist_qualification_state";
  const scope = projection === "public_aggregates" ? "tracks" : "artists";
  const syntheticGuard = subjectType === "track" ? "and source.subject_id <> ?" : "";
  return {
    args: [
      ...(selection.args ?? []),
      sourceVersion,
      now,
      now,
      scope,
      ...(subjectType === "track" ? [PUBLIC_PROJECTION_SYNTHETIC_TRACK_SUBJECT_ID] : []),
    ],
    sql: `with source as (${selection.sql})
      insert into projection_repairs
        (projection, subject_type, subject_id, source_epoch, source_version, created_at, updated_at)
      select distinct '${projection}', '${subjectType}', source.subject_id, state.source_epoch, ?, ?, ?
      from source cross join ${stateTable} state
      where state.scope = ? and changes() > 0
        and source.subject_id is not null and trim(source.subject_id) <> '' ${syntheticGuard}
      ${repairConflictClause()}`,
  };
}

/** Build all public shadow markers owed by one already-bounded source subject set. */
export function markPublicProjectionSourceChangedStatements(
  subjects: readonly PublicProjectionSourceSubject[],
  sourceVersion: string,
  options: { now?: Date | string; onlyIfPreviousStatementChanged?: boolean } = {},
): PublicProjectionStatement[] {
  assertNonEmpty(sourceVersion, "public projection source version");
  const unique = uniqueProjectionSubjects(subjects);
  const tracks = unique.filter(
    (subject): subject is ProjectionRepairSubject & { subjectType: "track" } =>
      subject.subjectType === "track",
  );
  const qualification = unique.filter(
    (subject): subject is ProjectionRepairSubject =>
      subject.subjectType === "artist" ||
      subject.subjectType === "label" ||
      subject.subjectType === "track",
  );
  if (qualification.length === 0) {
    return [];
  }
  const now = iso(options.now ?? new Date(), "public projection marker time");
  const conditional = options.onlyIfPreviousStatementChanged === true;
  const statements: PublicProjectionStatement[] = [];
  if (tracks.length > 0) {
    statements.push(
      advancePublicAggregateEpochStatement(now, conditional),
      insertProjectionRepairsForSubjectsStatement("public_aggregates", tracks, sourceVersion, now),
      advanceArtistQualificationEpochStatement(now, true),
    );
  } else {
    statements.push(advanceArtistQualificationEpochStatement(now, conditional));
  }
  statements.push(
    insertProjectionRepairsForSubjectsStatement(
      "artist_qualification",
      qualification,
      sourceVersion,
      now,
    ),
  );
  return statements;
}

/** Build public shadow markers from the same bounded selection used by a source write batch. */
export function markPublicProjectionSourceChangedFromSelectStatements(
  subjectType: PublicProjectionSourceSubject["subjectType"],
  selection: PublicProjectionSourceSelection,
  sourceVersion: string,
  options: { now?: Date | string; onlyIfPreviousStatementChanged?: boolean } = {},
): PublicProjectionStatement[] {
  if (subjectType === "album") {
    return [];
  }
  assertNonEmpty(sourceVersion, "public projection source version");
  const now = iso(options.now ?? new Date(), "public projection marker time");
  const conditional = options.onlyIfPreviousStatementChanged === true;
  if (subjectType === "track") {
    return [
      advancePublicAggregateEpochStatement(now, conditional),
      insertProjectionRepairsFromSelectionStatement(
        "public_aggregates",
        subjectType,
        selection,
        sourceVersion,
        now,
      ),
      advanceArtistQualificationEpochStatement(now, true),
      insertProjectionRepairsFromSelectionStatement(
        "artist_qualification",
        subjectType,
        selection,
        sourceVersion,
        now,
      ),
    ];
  }
  return [
    advanceArtistQualificationEpochStatement(now, conditional),
    insertProjectionRepairsFromSelectionStatement(
      "artist_qualification",
      subjectType,
      selection,
      sourceVersion,
      now,
    ),
  ];
}

export function markPublicTrackSourceChangedStatements(
  trackId: string,
  sourceVersion: string,
  options: { now?: Date | string; onlyIfPreviousStatementChanged?: boolean } = {},
): PublicProjectionStatement[] {
  return markPublicProjectionSourceChangedStatements(
    [{ subjectId: trackId, subjectType: "track" }],
    sourceVersion,
    {
      ...options,
      onlyIfPreviousStatementChanged: options.onlyIfPreviousStatementChanged !== false,
    },
  );
}

export function markPublicLabelSourceChangedStatements(
  labelId: string,
  sourceVersion: string,
  options: { now?: Date | string; onlyIfPreviousStatementChanged?: boolean } = {},
): PublicProjectionStatement[] {
  return markPublicProjectionSourceChangedStatements(
    [{ subjectId: labelId, subjectType: "label" }],
    sourceVersion,
    {
      ...options,
      onlyIfPreviousStatementChanged: options.onlyIfPreviousStatementChanged !== false,
    },
  );
}

export function markArtistQualificationRepairStatements(
  artistId: string,
  sourceVersion: string,
  options: { now?: Date | string; onlyIfPreviousStatementChanged?: boolean } = {},
): PublicProjectionStatement[] {
  return markPublicProjectionSourceChangedStatements(
    [{ subjectId: artistId, subjectType: "artist" }],
    sourceVersion,
    {
      ...options,
      onlyIfPreviousStatementChanged: options.onlyIfPreviousStatementChanged !== false,
    },
  );
}
