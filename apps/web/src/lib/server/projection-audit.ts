import { createHash } from "node:crypto";

import { type Client } from "@libsql/client";

import { readCrawlDueAuditChunk } from "./crawl-due-work";
import { DUE_WORK_BACKFILLS } from "./due-work-registry";
import {
  readPublicProjectionAuditChunk,
  type PublicProjectionAuditLane,
} from "./public-projections";
import {
  CRAWL_DUE_AUDIT_FENCE_KEY,
  readProjectionFence,
  TRACK_DUE_AUDIT_FENCE_KEY,
} from "./projection-fences";

export type ProjectionAuditTarget =
  | "artist_qualification"
  | "crawl_due_work"
  | "public_aggregates"
  | "track_due_work";

type ProjectionAuditClient = Pick<Client, "batch" | "execute">;

type AuditState = {
  anchorGeneration: null | string;
  anchorOrderEpoch: null | number;
  buckets: Record<string, number>;
  complete: boolean;
  cursor: null | string;
  definition: number;
  lane: string;
  matched: boolean;
  projectedCount: number;
  projectedDigest: string;
  sourceCount: number;
  sourceDigest: string;
  sourceEpoch: null | number;
  sourceFence: number;
  startedAt: string;
  target: ProjectionAuditTarget;
  version: 3 | 4 | 5;
};

export type ProjectionAuditEvidence = Pick<
  AuditState,
  | "anchorGeneration"
  | "anchorOrderEpoch"
  | "complete"
  | "matched"
  | "projectedCount"
  | "projectedDigest"
  | "sourceCount"
  | "sourceDigest"
  | "sourceEpoch"
  | "sourceFence"
  | "target"
>;

const ZERO_DIGEST = "0".repeat(64);

export const PROJECTION_AUDIT_SETTING_KEYS: Record<ProjectionAuditTarget, string> = {
  artist_qualification: "projection_audit_artist_qualification_v1",
  crawl_due_work: "projection_audit_crawl_due_work_v1",
  public_aggregates: "projection_audit_public_aggregates_v1",
  track_due_work: "projection_audit_track_due_work_v1",
};

const PUBLIC_LANES: Record<
  "artist_qualification" | "public_aggregates",
  PublicProjectionAuditLane[]
> = {
  artist_qualification: [
    "artist_source_contributions",
    "artist_source_rollups",
    "artist_projected_contributions",
    "artist_projected_rollups",
  ],
  public_aggregates: [
    "aggregate_source_membership",
    "aggregate_source_anchors",
    "aggregate_projected_membership",
    "aggregate_projected_counts",
    "aggregate_projected_anchors",
  ],
};

function chainDigest(current: string, rows: readonly unknown[][]): string {
  let value = current;
  for (const row of rows) {
    value = createHash("sha256")
      .update(value)
      .update("\n")
      .update(JSON.stringify(row))
      .digest("hex");
  }
  return value;
}

function newState(
  target: ProjectionAuditTarget,
  fence: {
    anchorGeneration: null | string;
    anchorOrderEpoch: null | number;
    sourceEpoch: null | number;
    sourceFence: number;
  },
): AuditState {
  return {
    anchorGeneration: fence.anchorGeneration,
    anchorOrderEpoch: fence.anchorOrderEpoch,
    buckets: {},
    complete: false,
    cursor: null,
    definition: 0,
    lane:
      target === "track_due_work"
        ? "source"
        : target === "crawl_due_work"
          ? "source"
          : (PUBLIC_LANES[target][0] ??
            (target === "artist_qualification"
              ? "artist_source_contributions"
              : "aggregate_source_membership")),
    matched: false,
    projectedCount: 0,
    projectedDigest: ZERO_DIGEST,
    sourceCount: 0,
    sourceDigest: ZERO_DIGEST,
    sourceEpoch: fence.sourceEpoch,
    sourceFence: fence.sourceFence,
    startedAt: new Date().toISOString(),
    target,
    version: target === "artist_qualification" ? 5 : 3,
  };
}

function parseState(value: unknown, target: ProjectionAuditTarget): AuditState | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const state = JSON.parse(value) as Partial<AuditState>;
    const versionMatches =
      target === "artist_qualification" ? state.version === 5 : state.version === 3;
    return versionMatches && state.target === target ? (state as AuditState) : undefined;
  } catch {
    return undefined;
  }
}

async function readState(
  client: ProjectionAuditClient,
  target: ProjectionAuditTarget,
): Promise<AuditState | undefined> {
  const result = await client.execute({
    args: [PROJECTION_AUDIT_SETTING_KEYS[target]],
    sql: `select value from settings where key = ?`,
  });
  return parseState(result.rows[0]?.value, target);
}

async function writeState(client: ProjectionAuditClient, state: AuditState): Promise<void> {
  await client.execute({
    args: [PROJECTION_AUDIT_SETTING_KEYS[state.target], JSON.stringify(state)],
    sql: `insert into settings (key, value) values (?, ?)
      on conflict(key) do update set value = excluded.value`,
  });
}

async function currentSourceEpoch(
  client: ProjectionAuditClient,
  target: ProjectionAuditTarget,
): Promise<null | number> {
  if (target !== "artist_qualification" && target !== "public_aggregates") {
    return null;
  }
  const table =
    target === "public_aggregates" ? "public_aggregate_state" : "artist_qualification_state";
  const scope = target === "public_aggregates" ? "tracks" : "artists";
  const result = await client.execute(`select source_epoch from ${table} where scope = '${scope}'`);
  const value = result.rows[0]?.source_epoch;
  return value === undefined ? null : Number(value);
}

async function currentAuditFence(
  client: ProjectionAuditClient,
  target: ProjectionAuditTarget,
): Promise<{
  anchorGeneration: null | string;
  anchorOrderEpoch: null | number;
  sourceEpoch: null | number;
  sourceFence: number;
}> {
  if (target === "track_due_work" || target === "crawl_due_work") {
    const sourceFence = await readProjectionFence(
      client,
      target === "track_due_work" ? TRACK_DUE_AUDIT_FENCE_KEY : CRAWL_DUE_AUDIT_FENCE_KEY,
    );
    return {
      anchorGeneration: null,
      anchorOrderEpoch: null,
      sourceEpoch: null,
      sourceFence,
    };
  }
  const sourceEpoch = await currentSourceEpoch(client, target);
  if (target === "artist_qualification") {
    return {
      anchorGeneration: null,
      anchorOrderEpoch: null,
      sourceEpoch,
      sourceFence: sourceEpoch ?? -1,
    };
  }
  const result = await client.execute(`select generation, release_hub_order_epoch
    from public_aggregate_state where scope = 'tracks' limit 1`);
  const generation = result.rows[0]?.generation;
  const orderEpoch = Number(result.rows[0]?.release_hub_order_epoch ?? -1);
  return {
    anchorGeneration: typeof generation === "string" && generation.length > 0 ? generation : null,
    anchorOrderEpoch: Number.isSafeInteger(orderEpoch) && orderEpoch >= 0 ? orderEpoch : null,
    sourceEpoch,
    sourceFence: sourceEpoch ?? -1,
  };
}

function sameAuditFence(
  state: AuditState,
  fence: Awaited<ReturnType<typeof currentAuditFence>>,
): boolean {
  return (
    state.anchorGeneration === fence.anchorGeneration &&
    state.anchorOrderEpoch === fence.anchorOrderEpoch &&
    state.sourceEpoch === fence.sourceEpoch &&
    state.sourceFence === fence.sourceFence
  );
}

export async function readProjectionAuditEvidence(
  client: ProjectionAuditClient,
  target: ProjectionAuditTarget,
): Promise<ProjectionAuditEvidence | undefined> {
  const state = await readState(client, target);
  if (state === undefined) {
    return undefined;
  }
  const {
    anchorGeneration,
    anchorOrderEpoch,
    complete,
    matched,
    projectedCount,
    projectedDigest,
    sourceCount,
    sourceDigest,
    sourceEpoch,
    sourceFence,
  } = state;
  return {
    anchorGeneration,
    anchorOrderEpoch,
    complete,
    matched,
    projectedCount,
    projectedDigest,
    sourceCount,
    sourceDigest,
    sourceEpoch,
    sourceFence,
    target,
  };
}

export async function clearProjectionAuditEvidence(
  client: ProjectionAuditClient,
  target: ProjectionAuditTarget,
): Promise<void> {
  await client.execute({
    args: [PROJECTION_AUDIT_SETTING_KEYS[target]],
    sql: `delete from settings where key = ?`,
  });
}

function canonicalDueProjection(
  row: {
    nextDueAt: string;
    sortKey: string;
    sourceVersion: string;
    state: string;
    subjectId: string;
  },
  state = row.state,
): unknown[] {
  return [row.subjectId, state, row.sortKey, row.nextDueAt, row.sourceVersion];
}

async function advanceTrackAudit(
  client: ProjectionAuditClient,
  state: AuditState,
  limit: number,
): Promise<number> {
  const definition = DUE_WORK_BACKFILLS[state.definition];
  if (definition === undefined) {
    state.complete = true;
    state.matched =
      state.sourceCount === state.projectedCount && state.sourceDigest === state.projectedDigest;
    return 0;
  }
  if (state.lane === "source") {
    const sources = await definition.readSourceChunk({ after: state.cursor, client, limit });
    const rows = sources.flatMap((source) => {
      const projected = definition.project(source, {
        generation: "audit",
        now: state.startedAt,
      });
      return projected === null ? [] : [canonicalDueProjection(projected)];
    });
    state.sourceDigest = chainDigest(state.sourceDigest, rows);
    state.sourceCount += rows.length;
    state.cursor = sources.at(-1)?.cursor ?? null;
    if (sources.length < limit) {
      state.lane = "projected";
      state.cursor = null;
    }
    return sources.length;
  }

  const result = await client.execute({
    args: [definition.workKind, definition.subjectType, state.cursor ?? "", limit],
    sql: `select next_due_at, sort_key, source_version, state, subject_id from due_work
      where work_kind = ? and subject_type = ? and state <> 'repair' and subject_id > ?
      order by subject_id limit ?`,
  });
  const actual = result.rows as unknown as {
    next_due_at: string;
    sort_key: string;
    source_version: string;
    state: string;
    subject_id: string;
  }[];
  const rows = actual.map((row) =>
    canonicalDueProjection(
      {
        nextDueAt: row.next_due_at,
        sortKey: row.sort_key,
        sourceVersion: row.source_version,
        state: row.state,
        subjectId: row.subject_id,
      },
      row.state === "leased" ? "ready" : row.state,
    ),
  );
  state.projectedDigest = chainDigest(state.projectedDigest, rows);
  state.projectedCount += rows.length;
  state.cursor = actual.at(-1)?.subject_id ?? null;
  if (result.rows.length < limit) {
    state.definition += 1;
    state.lane = "source";
    state.cursor = null;
    if (state.definition >= DUE_WORK_BACKFILLS.length) {
      state.complete = true;
      state.matched =
        state.sourceCount === state.projectedCount && state.sourceDigest === state.projectedDigest;
    }
  }
  return result.rows.length;
}

async function advanceCrawlAudit(
  client: ProjectionAuditClient,
  state: AuditState,
  limit: number,
): Promise<number> {
  const lane = state.lane === "source" ? "source" : "projected";
  const page = await readCrawlDueAuditChunk(client, lane, {
    after: state.cursor ?? "",
    limit,
  });
  if (lane === "source") {
    state.sourceDigest = chainDigest(state.sourceDigest, page.rows);
    state.sourceCount += page.rows.length;
  } else {
    state.projectedDigest = chainDigest(state.projectedDigest, page.rows);
    state.projectedCount += page.rows.length;
  }
  state.cursor = page.cursor;
  if (page.scanned < limit) {
    if (lane === "source") {
      state.lane = "projected";
      state.cursor = null;
    } else {
      state.complete = true;
      state.matched =
        state.sourceCount === state.projectedCount && state.sourceDigest === state.projectedDigest;
    }
  }
  return page.scanned;
}

function addAggregateBuckets(state: AuditState, rows: readonly unknown[][]): void {
  for (const row of rows) {
    const year = row[2];
    const key = row[3];
    if (typeof year === "string") {
      state.buckets[`release_date_bucket\u0000${year}`] =
        (state.buckets[`release_date_bucket\u0000${year}`] ?? 0) + 1;
    }
    if (typeof key === "string") {
      state.buckets[`key\u0000${key}`] = (state.buckets[`key\u0000${key}`] ?? 0) + 1;
    }
  }
}

function appendAggregateSourceCounts(state: AuditState): void {
  const rows: unknown[][] = [
    ...Object.entries(state.buckets)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([compound, value]) => {
        const [kind, bucket] = compound.split("\u0000");
        return ["count", kind, bucket, value];
      }),
    ["total", state.sourceCount],
  ];
  state.sourceDigest = chainDigest(state.sourceDigest, rows);
}

async function appendAggregateProjectedTotal(
  client: ProjectionAuditClient,
  state: AuditState,
): Promise<void> {
  const result = await client.execute(
    `select default_track_total from public_aggregate_state where scope = 'tracks'`,
  );
  state.projectedDigest = chainDigest(state.projectedDigest, [
    ["total", Number(result.rows[0]?.default_track_total ?? -1)],
  ]);
}

async function advancePublicAudit(
  client: ProjectionAuditClient,
  state: AuditState,
  limit: number,
): Promise<number> {
  const target = state.target as "artist_qualification" | "public_aggregates";
  const lanes = PUBLIC_LANES[target];
  const lane = state.lane as PublicProjectionAuditLane;
  const page = await readPublicProjectionAuditChunk(client, lane, {
    cursor: state.cursor,
    limit,
  });
  const source = lane.includes("_source_");
  if (source) {
    state.sourceDigest = chainDigest(state.sourceDigest, page.rows);
    state.sourceCount += page.rows.length;
    if (lane === "aggregate_source_membership") {
      addAggregateBuckets(state, page.rows);
    }
  } else {
    state.projectedDigest = chainDigest(state.projectedDigest, page.rows);
    state.projectedCount += page.rows.length;
  }
  state.cursor = page.cursor;
  if (page.complete ?? page.scanned < limit) {
    const index = lanes.indexOf(lane);
    if (lane === "aggregate_source_membership") {
      appendAggregateSourceCounts(state);
    }
    if (lane === "aggregate_projected_counts") {
      await appendAggregateProjectedTotal(client, state);
    }
    if (index + 1 < lanes.length) {
      state.lane = lanes[index + 1] ?? lane;
      state.cursor = null;
    } else {
      const fence = await currentAuditFence(client, target);
      state.complete = true;
      state.matched =
        fence.sourceEpoch !== null &&
        sameAuditFence(state, fence) &&
        state.sourceDigest === state.projectedDigest;
    }
  }
  return page.scanned;
}

/** Advance exactly one persisted audit lane page. No source identifiers are returned. */
export async function advanceProjectionAudit(
  client: ProjectionAuditClient,
  target: ProjectionAuditTarget,
  limit: number,
): Promise<{ complete: boolean; matched: boolean; processed: number }> {
  let state = await readState(client, target);
  const fence = await currentAuditFence(client, target);
  if (state === undefined || !sameAuditFence(state, fence)) {
    state = newState(target, fence);
  }
  if (state.complete) {
    return { complete: true, matched: state.matched, processed: 0 };
  }
  const processed =
    target === "track_due_work"
      ? await advanceTrackAudit(client, state, limit)
      : target === "crawl_due_work"
        ? await advanceCrawlAudit(client, state, limit)
        : await advancePublicAudit(client, state, limit);
  await writeState(client, state);
  return { complete: state.complete, matched: state.matched, processed };
}
