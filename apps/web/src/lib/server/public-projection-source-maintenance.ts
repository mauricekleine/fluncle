import { type InStatement, type InValue } from "@libsql/client";

export const PUBLIC_PROJECTION_LIVE_GENERATION = "live";
export const PUBLIC_PROJECTION_SYNTHETIC_TRACK_SUBJECT_ID = "@catalogue-rank-corpus";
export const PUBLIC_PROJECTION_TARGETS = ["public_aggregates", "artist_qualification"] as const;

// SHA-256 of an empty byte sequence. This is a fixed sentinel, so computing it at module load
// only introduces a server-only runtime dependency into otherwise declarative SQL builders.
const EMPTY_DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export type PublicProjectionStatement = Exclude<InStatement, string>;
export type PublicProjectionTarget = (typeof PUBLIC_PROJECTION_TARGETS)[number];
export type PublicProjectionSourceSubject = {
  subjectId: string;
  subjectType: "album" | "artist" | "label" | "track";
};
export type PublicProjectionSourceSelection = { args?: InValue[]; sql: string };

type ProjectionRepairSubject = {
  subjectId: string;
  subjectType: "artist" | "label" | "track";
};

function normalizedTargets(targets: readonly PublicProjectionTarget[]): PublicProjectionTarget[] {
  const supported = new Set<string>(PUBLIC_PROJECTION_TARGETS);
  const unique = new Set<PublicProjectionTarget>();
  for (const target of targets) {
    if (!supported.has(target)) {
      throw new Error(`unknown public projection target: ${String(target)}`);
    }
    if (unique.has(target)) {
      throw new Error(`duplicate public projection target: ${target}`);
    }
    unique.add(target);
  }
  return PUBLIC_PROJECTION_TARGETS.filter((target) => unique.has(target));
}

function assertTargetSubjectCompatibility(
  subjects: readonly PublicProjectionSourceSubject[],
  targets: readonly PublicProjectionTarget[],
): void {
  for (const subject of subjects) {
    assertNonEmpty(subject.subjectId, "public projection subject id");
  }
  if (
    targets.includes("public_aggregates") &&
    subjects.some((subject) => subject.subjectType !== "track")
  ) {
    throw new Error("public_aggregates maintenance accepts only track subjects");
  }
  if (
    targets.includes("artist_qualification") &&
    subjects.some((subject) => subject.subjectType === "album")
  ) {
    throw new Error("artist_qualification maintenance does not accept album subjects");
  }
}

function assertSelectionTargetCompatibility(
  subjectType: PublicProjectionSourceSubject["subjectType"],
  targets: readonly PublicProjectionTarget[],
): void {
  if (targets.includes("public_aggregates") && subjectType !== "track") {
    throw new Error("public_aggregates maintenance accepts only track selections");
  }
  if (targets.includes("artist_qualification") && subjectType === "album") {
    throw new Error("artist_qualification maintenance does not accept album selections");
  }
}

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

/** Build the explicitly targeted public shadow markers for one bounded source subject set. */
export function markPublicProjectionSourceChangedStatements(
  subjects: readonly PublicProjectionSourceSubject[],
  sourceVersion: string,
  targets: readonly PublicProjectionTarget[],
  options: { now?: Date | string; onlyIfPreviousStatementChanged?: boolean } = {},
): PublicProjectionStatement[] {
  const resolvedTargets = normalizedTargets(targets);
  if (resolvedTargets.length === 0) {
    return [];
  }
  assertNonEmpty(sourceVersion, "public projection source version");
  assertTargetSubjectCompatibility(subjects, resolvedTargets);
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
  const aggregateTargeted = resolvedTargets.includes("public_aggregates");
  const artistTargeted = resolvedTargets.includes("artist_qualification");
  if (
    (aggregateTargeted && tracks.length === 0) ||
    (artistTargeted && qualification.length === 0)
  ) {
    return [];
  }
  const now = iso(options.now ?? new Date(), "public projection marker time");
  const conditional = options.onlyIfPreviousStatementChanged === true;
  const statements: PublicProjectionStatement[] = [];
  if (aggregateTargeted) {
    statements.push(
      advancePublicAggregateEpochStatement(now, conditional),
      insertProjectionRepairsForSubjectsStatement("public_aggregates", tracks, sourceVersion, now),
    );
  }
  if (artistTargeted) {
    statements.push(
      advanceArtistQualificationEpochStatement(now, aggregateTargeted ? true : conditional),
      insertProjectionRepairsForSubjectsStatement(
        "artist_qualification",
        qualification,
        sourceVersion,
        now,
      ),
    );
  }
  return statements;
}

/**
 * Build public shadow markers after a bounded selection marker. Epoch admission is deliberately
 * non-configurable at this API boundary: every epoch statement checks `changes()` from the marker
 * immediately before it, so an empty selection cannot initialize or advance public state.
 */
export function markPublicProjectionSourceChangedFromSelectStatements(
  subjectType: PublicProjectionSourceSubject["subjectType"],
  selection: PublicProjectionSourceSelection,
  sourceVersion: string,
  targets: readonly PublicProjectionTarget[],
  options: { now?: Date | string } = {},
): PublicProjectionStatement[] {
  const resolvedTargets = normalizedTargets(targets);
  if (resolvedTargets.length === 0) {
    return [];
  }
  if (subjectType === "album") {
    throw new Error("public projection maintenance does not accept album selections");
  }
  assertSelectionTargetCompatibility(subjectType, resolvedTargets);
  assertNonEmpty(sourceVersion, "public projection source version");
  assertNonEmpty(selection.sql, "public projection source selection");
  const now = iso(options.now ?? new Date(), "public projection marker time");
  const statements: PublicProjectionStatement[] = [];
  const aggregateTargeted = resolvedTargets.includes("public_aggregates");
  if (aggregateTargeted) {
    statements.push(
      advancePublicAggregateEpochStatement(now, true),
      insertProjectionRepairsFromSelectionStatement(
        "public_aggregates",
        subjectType,
        selection,
        sourceVersion,
        now,
      ),
    );
  }
  if (resolvedTargets.includes("artist_qualification")) {
    statements.push(
      advanceArtistQualificationEpochStatement(now, true),
      insertProjectionRepairsFromSelectionStatement(
        "artist_qualification",
        subjectType,
        selection,
        sourceVersion,
        now,
      ),
    );
  }
  return statements;
}

export function markPublicTrackSourceChangedStatements(
  trackId: string,
  sourceVersion: string,
  options: { now?: Date | string; onlyIfPreviousStatementChanged?: boolean } = {},
): PublicProjectionStatement[] {
  return markPublicProjectionSourceChangedStatements(
    [{ subjectId: trackId, subjectType: "track" }],
    sourceVersion,
    ["public_aggregates"],
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
    ["artist_qualification"],
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
    ["artist_qualification"],
    {
      ...options,
      onlyIfPreviousStatementChanged: options.onlyIfPreviousStatementChanged !== false,
    },
  );
}
