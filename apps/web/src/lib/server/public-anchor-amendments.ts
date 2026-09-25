import { type Client, type InStatement, type InValue } from "@libsql/client";

import {
  compareHubOrderKeys,
  type HubAnchorLeafMeta,
  type HubOrderKey,
  type HubPageAnchor,
  hubAnchorShardSuffixBetween,
  hubLeafSamplesFromRows,
  parseHubAnchorLeafMeta,
  serializeHubAnchorLeafMeta,
} from "./hub-page-anchors";
import {
  ANCHOR_LEAF_META_VALID_SQL,
  ANCHOR_LEAF_ROWS_SQL,
  parseAnchorDocument,
  PUBLIC_ANCHOR_FORMAT_VERSION,
  type PublicAnchorOrderChange,
  parsePublicAnchorOrderChange,
  publicAnchorOrderChangeKey,
} from "./public-projection-cutover";
import { readTrackAnchorLeafRows } from "./public-projections";
import { TRACKS_HUB_ANCHOR_ADDRESS, TRACKS_HUB_PAGE_SIZE } from "./tracks-hub";

export const PUBLIC_ANCHOR_AMENDMENT_MAX_SHARD_WRITES = 4;

export const PUBLIC_ANCHOR_AMENDMENTS_PER_STEP = 8;

export const PUBLIC_ANCHOR_LEAF_SPLIT_ROWS = 200;

export function publicAnchorAmendmentRebuildThreshold(total: number): number {
  return Math.max(
    PUBLIC_ANCHOR_AMENDMENTS_PER_STEP,
    Math.floor((total * PUBLIC_ANCHOR_AMENDMENTS_PER_STEP) / 100),
  );
}

type AmendmentClient = Pick<Client, "batch" | "execute">;

export type AnchorAmendmentGuard = { args: InValue[]; sql: string };

export type AnchorAmendmentTarget =
  | {
      kind: "published";

      orderEpoch: number;
    }
  | {
      kind: "partial";

      end: HubOrderKey | null;

      orderEpoch: number;

      processed: number;

      shard: number;

      serialized: string;

      serialize: (orderEpoch: number, processed: number) => string;
      stateKey: string;
    };

export type AnchorAmendmentInput = {
  currentEpoch: number;
  generation: string;
  now: string;

  sourceReady: AnchorAmendmentGuard;
  target: AnchorAmendmentTarget;
  total: number;
};

export type AnchorAmendmentOutcome = {
  complete: false;

  processed: number;
};

type LocatedLeaf = {
  anchors: HubPageAnchor[];
  clauseHash: string;
  fingerprint: string;
  meta: HubAnchorLeafMeta;
  prefix: number;
};

type LeafWrite = {
  anchorsJson: string;
  clauseHash: string;
  fingerprint: string;

  token: string | undefined;
};

type LeafDelete = { clauseHash: string; token: string };

type LeafPlan = { deletes: LeafDelete[]; writes: LeafWrite[] };

function generationPrefix(generation: string): string {
  return `${TRACKS_HUB_ANCHOR_ADDRESS.clauseHash}:${generation}:`;
}

async function readLedgerEntries(
  client: AmendmentClient,
  afterEpoch: number,
  throughEpoch: number,
  limit: number,
): Promise<PublicAnchorOrderChange[] | undefined> {
  const result = await client.execute({
    args: [publicAnchorOrderChangeKey(afterEpoch), publicAnchorOrderChangeKey(throughEpoch), limit],
    sql: `select value from settings where key > ? and key <= ? order by key limit ?`,
  });
  const entries: PublicAnchorOrderChange[] = [];
  for (const [index, row] of result.rows.entries()) {
    const entry = parsePublicAnchorOrderChange(row.value);

    if (entry === undefined || entry.epoch !== afterEpoch + index + 1) {
      return undefined;
    }
    entries.push(entry);
  }
  return entries.length > 0 ? entries : undefined;
}

const LEAF_AFTER_TYPE_SQL = `case when json_valid(shard.fingerprint)
  then json_type(shard.fingerprint, '$.after') end`;
const LEAF_AFTER_KEY_SQL = `case when json_valid(shard.fingerprint)
  then json_extract(shard.fingerprint, '$.after.key') end`;
const LEAF_AFTER_ID_SQL = `case when json_valid(shard.fingerprint)
  then json_extract(shard.fingerprint, '$.after.id') end`;

function locatedLeafFromRow(row: Record<string, unknown> | undefined): LocatedLeaf | undefined {
  if (row === undefined) {
    return undefined;
  }
  const anchors = parseAnchorDocument(row["anchors_json"]);
  const meta = parseHubAnchorLeafMeta(row["fingerprint"]);
  const prefix = Number(row["prefix"]);
  const clauseHash = row["clause_hash"];
  const fingerprint = row["fingerprint"];
  if (
    anchors === undefined ||
    meta === undefined ||
    !Number.isSafeInteger(prefix) ||
    prefix < 0 ||
    typeof clauseHash !== "string" ||
    typeof fingerprint !== "string"
  ) {
    return undefined;
  }
  return { anchors, clauseHash, fingerprint, meta, prefix };
}

async function locateLeaf(
  client: AmendmentClient,
  generation: string,
  key: HubOrderKey,
): Promise<LocatedLeaf | undefined> {
  const prefix = generationPrefix(generation);
  const result = await client.execute({
    args: [
      TRACKS_HUB_ANCHOR_ADDRESS.hub,
      prefix,
      `${prefix}\uffff`,
      key.key,
      key.key,
      key.key,
      key.id,
      key.key,
      key.key,
      key.id,
    ],
    sql: `with leaves as (
        select shard.clause_hash, shard.anchors_json, shard.fingerprint,
          ${LEAF_AFTER_TYPE_SQL} as after_type,
          ${LEAF_AFTER_KEY_SQL} as after_key,
          ${LEAF_AFTER_ID_SQL} as after_id,
          coalesce(sum(${ANCHOR_LEAF_ROWS_SQL}) over (
            order by shard.clause_hash rows between unbounded preceding and 1 preceding), 0) as prefix
        from hub_page_anchors shard
        where shard.hub = ? and shard.clause_hash >= ? and shard.clause_hash < ?)
      select clause_hash, anchors_json, fingerprint, prefix from leaves
      where after_type = 'null'
        or (after_type = 'object' and (
          (after_key is not null and ? is not null
            and (after_key > ? or (after_key = ? and after_id > ?)))
          or (after_key is not null and ? is null)
          or (after_key is null and ? is null and after_id > ?)))
      order by clause_hash desc limit 1`,
  });
  return locatedLeafFromRow(result.rows[0] as Record<string, unknown> | undefined);
}

async function readNextLeaf(
  client: AmendmentClient,
  generation: string,
  clauseHash: string,
): Promise<{ clauseHash: string; meta: HubAnchorLeafMeta } | undefined> {
  const prefix = generationPrefix(generation);
  const result = await client.execute({
    args: [TRACKS_HUB_ANCHOR_ADDRESS.hub, clauseHash, `${prefix}\uffff`],
    sql: `select clause_hash, fingerprint from hub_page_anchors
      where hub = ? and clause_hash > ? and clause_hash < ?
      order by clause_hash limit 1`,
  });
  const row = result.rows[0];
  const meta = parseHubAnchorLeafMeta(row?.fingerprint);
  return typeof row?.clause_hash === "string" && meta !== undefined
    ? { clauseHash: row.clause_hash, meta }
    : undefined;
}

function leafWrite(
  clauseHash: string,
  rows: readonly HubOrderKey[],
  after: HubOrderKey | null,
  prefix: number,
  token: string | undefined,
): LeafWrite {
  const meta: HubAnchorLeafMeta = {
    after,
    base: prefix,
    n: rows.length,
    nn: rows.filter((row) => row.key !== null).length,
    v: 1,
  };
  return {
    anchorsJson: JSON.stringify(hubLeafSamplesFromRows(rows, prefix, TRACKS_HUB_PAGE_SIZE)),
    clauseHash,
    fingerprint: serializeHubAnchorLeafMeta(meta),
    token,
  };
}

function shardSuffix(clauseHash: string, generation: string): string {
  return clauseHash.slice(generationPrefix(generation).length);
}

const LEAF_READ_BOUND = PUBLIC_ANCHOR_LEAF_SPLIT_ROWS * 2 + 1;

type LeafPlanWithDelta = { delta: number; plan: LeafPlan };

async function planLeaf(
  client: AmendmentClient,
  input: AnchorAmendmentInput,
  leaf: LocatedLeaf,
  prefix: number,
): Promise<LeafPlanWithDelta | undefined> {
  const next = await readNextLeaf(client, input.generation, leaf.clauseHash);
  const rangeEnd = next?.meta.after ?? (input.target.kind === "partial" ? input.target.end : null);
  const source = await readTrackAnchorLeafRows(client, leaf.meta.after, rangeEnd, LEAF_READ_BOUND);
  if (!source.complete) {
    return undefined;
  }
  const delta = source.rows.length - leaf.meta.n;

  if (source.rows.length === 0 && leaf.meta.after !== null && (next !== undefined || prefix > 0)) {
    return {
      delta,
      plan: { deletes: [{ clauseHash: leaf.clauseHash, token: leaf.fingerprint }], writes: [] },
    };
  }
  if (source.rows.length <= PUBLIC_ANCHOR_LEAF_SPLIT_ROWS) {
    return {
      delta,
      plan: {
        deletes: [],
        writes: [
          leafWrite(leaf.clauseHash, source.rows, leaf.meta.after, prefix, leaf.fingerprint),
        ],
      },
    };
  }
  const half = Math.floor(source.rows.length / 2);
  const first = source.rows.slice(0, half);
  const second = source.rows.slice(half);
  const pivot = first.at(-1);
  if (pivot === undefined) {
    return undefined;
  }
  const secondKey = `${generationPrefix(input.generation)}${hubAnchorShardSuffixBetween(
    shardSuffix(leaf.clauseHash, input.generation),
    next === undefined ? undefined : shardSuffix(next.clauseHash, input.generation),
  )}`;
  return {
    delta,
    plan: {
      deletes: [],
      writes: [
        leafWrite(leaf.clauseHash, first, leaf.meta.after, prefix, leaf.fingerprint),
        leafWrite(secondKey, second, pivot, prefix + half, undefined),
      ],
    },
  };
}

type EntryPlan = { plan: LeafPlan; processedDelta: number };

function keysOf(entry: PublicAnchorOrderChange): { from?: HubOrderKey; to?: HubOrderKey } {
  switch (entry.kind) {
    case "insert":
      return { to: { id: entry.id, key: entry.to } };
    case "delete":
      return { from: { id: entry.id, key: entry.from } };
    case "move":
      return { from: { id: entry.id, key: entry.from }, to: { id: entry.id, key: entry.to } };
    default:
      return {};
  }
}

function insideBuiltPrefix(target: AnchorAmendmentTarget, key: HubOrderKey): boolean {
  if (target.kind === "published") {
    return true;
  }
  return target.end !== null && compareHubOrderKeys(key, target.end) <= 0;
}

async function planEntry(
  client: AmendmentClient,
  input: AnchorAmendmentInput,
  entry: PublicAnchorOrderChange,
): Promise<EntryPlan | undefined> {
  if (entry.kind === "unknown") {
    return undefined;
  }
  const keys = keysOf(entry);
  const located: LocatedLeaf[] = [];
  for (const key of [keys.from, keys.to]) {
    if (key === undefined || !insideBuiltPrefix(input.target, key)) {
      continue;
    }
    const leaf = await locateLeaf(client, input.generation, key);
    if (leaf === undefined) {
      return undefined;
    }
    if (!located.some((candidate) => candidate.clauseHash === leaf.clauseHash)) {
      located.push(leaf);
    }
  }

  located.sort((a, b) => (a.clauseHash < b.clauseHash ? -1 : a.clauseHash > b.clauseHash ? 1 : 0));
  const plans: LeafPlan[] = [];
  let processedDelta = 0;
  for (const leaf of located) {
    const planned = await planLeaf(client, input, leaf, leaf.prefix + processedDelta);
    if (planned === undefined) {
      return undefined;
    }
    plans.push(planned.plan);
    processedDelta += planned.delta;
  }
  return {
    plan: {
      deletes: plans.flatMap((plan) => plan.deletes),
      writes: plans.flatMap((plan) => plan.writes),
    },
    processedDelta,
  };
}

function tokenGuard(plan: LeafPlan): AnchorAmendmentGuard {
  const clauses: string[] = [];
  const args: InValue[] = [];
  for (const write of plan.writes) {
    if (write.token === undefined) {
      clauses.push(`not exists (select 1 from hub_page_anchors where hub = ? and clause_hash = ?)`);
      args.push(TRACKS_HUB_ANCHOR_ADDRESS.hub, write.clauseHash);
    } else {
      clauses.push(
        `exists (select 1 from hub_page_anchors where hub = ? and clause_hash = ? and fingerprint = ?)`,
      );
      args.push(TRACKS_HUB_ANCHOR_ADDRESS.hub, write.clauseHash, write.token);
    }
  }
  for (const remove of plan.deletes) {
    clauses.push(
      `exists (select 1 from hub_page_anchors where hub = ? and clause_hash = ? and fingerprint = ?)`,
    );
    args.push(TRACKS_HUB_ANCHOR_ADDRESS.hub, remove.clauseHash, remove.token);
  }
  return { args, sql: clauses.length === 0 ? "1 = 1" : clauses.join(" and ") };
}

function leafStatements(plan: LeafPlan, landed: AnchorAmendmentGuard, now: string): InStatement[] {
  const statements: InStatement[] = [];
  for (const write of plan.writes) {
    statements.push(
      write.token === undefined
        ? {
            args: [
              TRACKS_HUB_ANCHOR_ADDRESS.hub,
              write.clauseHash,
              write.anchorsJson,
              write.fingerprint,
              now,
              TRACKS_HUB_ANCHOR_ADDRESS.hub,
              write.clauseHash,
              ...landed.args,
            ],
            sql: `insert into hub_page_anchors
              (hub, clause_hash, anchors_json, fingerprint, computed_at)
              select ?, ?, ?, ?, ?
              where not exists (select 1 from hub_page_anchors where hub = ? and clause_hash = ?)
                and ${landed.sql}`,
          }
        : {
            args: [
              write.anchorsJson,
              write.fingerprint,
              now,
              TRACKS_HUB_ANCHOR_ADDRESS.hub,
              write.clauseHash,
              write.token,
              ...landed.args,
            ],
            sql: `update hub_page_anchors
              set anchors_json = ?, fingerprint = ?, computed_at = ?
              where hub = ? and clause_hash = ? and fingerprint = ? and ${landed.sql}`,
          },
    );
  }
  for (const remove of plan.deletes) {
    statements.push({
      args: [TRACKS_HUB_ANCHOR_ADDRESS.hub, remove.clauseHash, remove.token, ...landed.args],
      sql: `delete from hub_page_anchors
        where hub = ? and clause_hash = ? and fingerprint = ? and ${landed.sql}`,
    });
  }
  return statements;
}

function amendmentBatch(
  input: AnchorAmendmentInput,
  entry: PublicAnchorOrderChange,
  entryPlan: EntryPlan,
  nextProcessed: number,
): InStatement[] {
  const tokens = tokenGuard(entryPlan.plan);
  const { target } = input;
  if (target.kind === "published") {
    const landed: AnchorAmendmentGuard = {
      args: [
        TRACKS_HUB_ANCHOR_ADDRESS.hub,
        TRACKS_HUB_ANCHOR_ADDRESS.clauseHash,
        input.generation,
        entry.epoch,
      ],
      sql: `exists (select 1 from hub_page_anchor_validity
        where hub = ? and clause_hash = ? and generation = ? and order_epoch = ?)`,
    };
    return [
      {
        args: [
          entry.epoch,
          input.now,
          TRACKS_HUB_ANCHOR_ADDRESS.hub,
          TRACKS_HUB_ANCHOR_ADDRESS.clauseHash,
          input.generation,
          target.orderEpoch,
          PUBLIC_ANCHOR_FORMAT_VERSION,
          ...input.sourceReady.args,
          ...tokens.args,
        ],
        sql: `update hub_page_anchor_validity set order_epoch = ?, published_at = ?
          where hub = ? and clause_hash = ? and generation = ? and order_epoch = ?
            and anchor_format_version = ?
            and ${input.sourceReady.sql} and ${tokens.sql}`,
      },
      ...leafStatements(entryPlan.plan, landed, input.now),
      {
        args: [publicAnchorOrderChangeKey(entry.epoch), ...landed.args],
        sql: `delete from settings where key = ? and ${landed.sql}`,
      },
    ];
  }
  const nextState = target.serialize(entry.epoch, nextProcessed);
  const landed: AnchorAmendmentGuard = {
    args: [target.stateKey, nextState],
    sql: `exists (select 1 from settings where key = ? and value = ?)`,
  };
  return [
    {
      args: [
        nextState,
        target.stateKey,
        target.serialized,
        ...input.sourceReady.args,
        ...tokens.args,
      ],
      sql: `update settings set value = ? where key = ? and value = ?
        and ${input.sourceReady.sql} and ${tokens.sql}`,
    },
    ...leafStatements(entryPlan.plan, landed, input.now),
    {
      args: [publicAnchorOrderChangeKey(entry.epoch), ...landed.args],
      sql: `delete from settings where key = ? and ${landed.sql}`,
    },
  ];
}

async function isLeafDocument(client: AmendmentClient, generation: string): Promise<boolean> {
  const prefix = generationPrefix(generation);
  const result = await client.execute({
    args: [TRACKS_HUB_ANCHOR_ADDRESS.hub, prefix, `${prefix}\uffff`],
    sql: `select count(*) as shards,
        coalesce(sum(case when ${ANCHOR_LEAF_META_VALID_SQL} then 1 else 0 end), 0) as valid
      from hub_page_anchors shard
      where shard.hub = ? and shard.clause_hash >= ? and shard.clause_hash < ?`,
  });
  const row = result.rows[0];
  const shards = Number(row?.shards);
  return shards > 0 && Number(row?.valid) === shards;
}

export async function amendPublicAnchorDocument(
  client: AmendmentClient,
  input: AnchorAmendmentInput,
): Promise<AnchorAmendmentOutcome | undefined> {
  const represented = input.target.orderEpoch;
  const pending = input.currentEpoch - represented;
  if (pending <= 0) {
    return undefined;
  }
  if (
    input.target.kind === "published" &&
    pending > publicAnchorAmendmentRebuildThreshold(input.total)
  ) {
    return undefined;
  }
  const entries = await readLedgerEntries(
    client,
    represented,
    input.currentEpoch,
    input.target.kind === "published" ? PUBLIC_ANCHOR_AMENDMENTS_PER_STEP : 100,
  );
  if (entries === undefined) {
    return undefined;
  }
  if (input.target.kind === "partial" && input.target.end === null) {
  } else if (!(await isLeafDocument(client, input.generation))) {
    return undefined;
  }
  let processed = 0;
  let amended = 0;
  let target = input.target;
  for (const entry of entries) {
    if (target.kind === "published" && amended >= PUBLIC_ANCHOR_AMENDMENTS_PER_STEP) {
      break;
    }
    const entryPlan = await planEntry(client, { ...input, target }, entry);
    if (entryPlan === undefined) {
      break;
    }
    const nextProcessed =
      target.kind === "partial" ? target.processed + entryPlan.processedDelta : 0;
    if (
      target.kind === "partial" &&
      (nextProcessed < target.shard || (nextProcessed === 0 && target.end !== null))
    ) {
      break;
    }
    const results = await client.batch(
      amendmentBatch({ ...input, target }, entry, entryPlan, nextProcessed),
      "write",
    );
    if ((results[0]?.rowsAffected ?? 0) === 0) {
      break;
    }
    processed += 1;
    if (entryPlan.plan.writes.length + entryPlan.plan.deletes.length > 0) {
      amended += 1;
    }
    target =
      target.kind === "published"
        ? { kind: "published", orderEpoch: entry.epoch }
        : {
            ...target,
            orderEpoch: entry.epoch,
            processed: nextProcessed,
            serialized: target.serialize(entry.epoch, nextProcessed),
          };
  }
  return processed === 0 ? undefined : { complete: false, processed };
}

export function purgeAnchorOrderChangesStatement(throughEpoch: number): InStatement {
  return {
    args: [publicAnchorOrderChangeKey(0), publicAnchorOrderChangeKey(throughEpoch)],
    sql: `delete from settings where key >= ? and key <= ?`,
  };
}
