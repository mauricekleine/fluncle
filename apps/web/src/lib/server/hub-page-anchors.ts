import { fnv1a } from "../log-id-shared";
import { getDb, typedRows } from "./db";

export type HubPageSqlArg = number | string;

export type HubPageClause = {
  args: HubPageSqlArg[];
  sql: string;
};

export type HubPageAnchor = {
  page: number;
  id: string;
  key: null | string;
};

export type HubOrderedPageShape = {
  clauses: HubPageClause[];

  from: string;
  idExpr: string;
  keyAlias: string;
  keyExpr: string;
  orderBy: string;
  pageSize: number;

  prefix?: HubPageClause;

  projection: string;
  seekAfter: (anchor: HubPageAnchor) => HubPageClause;
};

export type HubPageQuery = {
  anchor?: HubPageAnchor;
  args: HubPageSqlArg[];

  remainder: number;
  sql: string;
};

export type PersistedHubPageAnchors = {
  anchors: HubPageAnchor[];
  computedAt: string;
  fingerprint: string;
};

export type PersistedAnchorDecision = {
  mode: "offset" | "seek";
  reason: "fresh" | "missing" | "shallow" | "stale";
  refresh: boolean;
};

export const HUB_SHALLOW_MAX_OFFSET = 450;

function joinedWhere(clauses: HubPageClause[]): { args: HubPageSqlArg[]; sql: string } {
  return {
    args: clauses.flatMap((clause) => clause.args),
    sql: clauses.length > 0 ? `where ${clauses.map((clause) => clause.sql).join(" and ")}` : "",
  };
}

function queryPrefix(shape: HubOrderedPageShape): { args: HubPageSqlArg[]; sql: string } {
  return {
    args: shape.prefix?.args ?? [],
    sql: shape.prefix?.sql ? `${shape.prefix.sql}\n` : "",
  };
}

export function hubAnchorExtractionQuery(shape: HubOrderedPageShape): {
  args: HubPageSqlArg[];
  sql: string;
} {
  const prefix = queryPrefix(shape);
  const where = joinedWhere(shape.clauses);

  return {
    args: [...prefix.args, ...where.args],
    sql: `${prefix.sql}select rn, id, ${shape.keyAlias}
          from (
            select ${shape.idExpr} as id, ${shape.keyExpr} as ${shape.keyAlias},
                   row_number() over (order by ${shape.orderBy}) as rn
            from ${shape.from}
            ${where.sql}
          )
          where (rn % ${shape.pageSize}) = 0`,
  };
}

export function hubOffsetPageQuery(
  shape: HubOrderedPageShape,
  limit: number,
  offset: number,
): HubPageQuery {
  const prefix = queryPrefix(shape);
  const where = joinedWhere(shape.clauses);

  return {
    args: [...prefix.args, ...where.args, limit, offset],
    remainder: offset,
    sql: `${prefix.sql}select ${shape.projection}
          from ${shape.from}
          ${where.sql}
          order by ${shape.orderBy}
          limit ? offset ?`,
  };
}

export function nearestHubPageAnchor(
  page: number,
  anchors: HubPageAnchor[],
): HubPageAnchor | undefined {
  let nearest: HubPageAnchor | undefined;

  for (const anchor of anchors) {
    if (anchor.page <= page && (!nearest || anchor.page > nearest.page)) {
      nearest = anchor;
    }
  }

  return nearest;
}

export function hubSeekPageQuery(
  shape: HubOrderedPageShape,
  page: number,
  anchors: HubPageAnchor[],
): HubPageQuery {
  const anchor = nearestHubPageAnchor(page, anchors);
  const remainder = (anchor ? page - anchor.page : page - 1) * shape.pageSize;
  const clauses = anchor ? [...shape.clauses, shape.seekAfter(anchor)] : shape.clauses;
  const prefix = queryPrefix(shape);
  const where = joinedWhere(clauses);

  return {
    anchor,
    args: [...prefix.args, ...where.args, shape.pageSize, remainder],
    remainder,
    sql: `${prefix.sql}select ${shape.projection}
          from ${shape.from}
          ${where.sql}
          order by ${shape.orderBy}
          limit ? offset ?`,
  };
}

export function hubPageAnchorsFromRows(
  rows: Record<string, unknown>[],
  keyAlias: string,
  pageSize: number,
): HubPageAnchor[] {
  return rows.flatMap((row) => {
    const rn = Number(row["rn"]);
    const id = row["id"];
    const key = row[keyAlias];

    if (
      !Number.isSafeInteger(rn) ||
      rn <= 0 ||
      rn % pageSize !== 0 ||
      typeof id !== "string" ||
      (key !== null && typeof key !== "string")
    ) {
      return [];
    }

    return [{ id, key, page: rn / pageSize + 1 }];
  });
}

export function hubClauseSetKey(clauses: HubPageClause[]): string {
  return JSON.stringify(clauses.map((clause) => [clause.sql, clause.args]));
}

export function hubClauseHash(clauseSetKey: string): string {
  return fnv1a(clauseSetKey).toString(16).padStart(8, "0");
}

export function hubCorpusFingerprint(total: number, firstId: string | undefined): string {
  return `${total}:${firstId ?? ""}`;
}

export function isShallowHubPage(page: number, pageSize: number): boolean {
  return (page - 1) * pageSize <= HUB_SHALLOW_MAX_OFFSET;
}

export function persistedAnchorDecision(
  page: number,
  pageSize: number,
  stored: PersistedHubPageAnchors | undefined,
  currentFingerprint: string,
): PersistedAnchorDecision {
  if (isShallowHubPage(page, pageSize)) {
    return { mode: "offset", reason: "shallow", refresh: false };
  }

  if (!stored) {
    return { mode: "offset", reason: "missing", refresh: true };
  }

  if (stored.fingerprint !== currentFingerprint) {
    return { mode: "seek", reason: "stale", refresh: true };
  }

  return { mode: "seek", reason: "fresh", refresh: false };
}

function parseStoredAnchors(value: string): HubPageAnchor[] | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;

    if (!Array.isArray(parsed)) {
      return undefined;
    }

    const anchors = parsed.flatMap((candidate) => {
      if (typeof candidate !== "object" || candidate === null) {
        return [];
      }

      const record = candidate as Record<string, unknown>;
      const id = record["id"];
      const key = record["key"];
      const page = Number(record["page"]);

      if (
        typeof id !== "string" ||
        (key !== null && typeof key !== "string") ||
        !Number.isSafeInteger(page) ||
        page < 2
      ) {
        return [];
      }

      return [{ id, key, page }];
    });

    return anchors.length === parsed.length ? anchors : undefined;
  } catch {
    return undefined;
  }
}

export async function loadPersistedHubPageAnchors(
  hub: string,
  clauseHash: string,
): Promise<PersistedHubPageAnchors | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [hub, clauseHash],
    sql: `select anchors_json, fingerprint, computed_at
          from hub_page_anchors
          where hub = ? and clause_hash = ?
          limit 1`,
  });
  const row = typedRows<{
    anchors_json: string;
    computed_at: string;
    fingerprint: string;
  }>(result.rows)[0];

  if (!row) {
    return undefined;
  }

  const anchors = parseStoredAnchors(row.anchors_json);

  return anchors
    ? { anchors, computedAt: row.computed_at, fingerprint: row.fingerprint }
    : undefined;
}

export async function persistHubPageAnchors(
  hub: string,
  clauseHash: string,
  anchors: HubPageAnchor[],
  fingerprint: string,
): Promise<void> {
  const db = await getDb();

  await db.execute({
    args: [hub, clauseHash, JSON.stringify(anchors), fingerprint, new Date().toISOString()],
    sql: `insert into hub_page_anchors
            (hub, clause_hash, anchors_json, fingerprint, computed_at)
          values (?, ?, ?, ?, ?)
          on conflict (hub, clause_hash) do update set
            anchors_json = excluded.anchors_json,
            fingerprint = excluded.fingerprint,
            computed_at = excluded.computed_at`,
  });
}

const scheduledRefreshes = new Map<string, Promise<void>>();

export function scheduleHubPageAnchorRefresh(key: string, refresh: () => Promise<void>): void {
  if (scheduledRefreshes.has(key)) {
    return;
  }

  const task = Promise.resolve()
    .then(refresh)
    .catch(() => undefined)
    .finally(() => scheduledRefreshes.delete(key));

  scheduledRefreshes.set(key, task);

  void task;
}

export type HubOrderKey = {
  id: string;
  key: null | string;
};

export function compareHubOrderKeys(a: HubOrderKey, b: HubOrderKey): number {
  if (a.key !== null && b.key !== null && a.key !== b.key) {
    return a.key > b.key ? -1 : 1;
  }
  if (a.key === null && b.key !== null) {
    return 1;
  }
  if (a.key !== null && b.key === null) {
    return -1;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id > b.id ? -1 : 1;
}

export type HubAnchorLeafMeta = {
  after: HubOrderKey | null;
  base: number;
  n: number;
  nn: number;
  v: 1;
};

const HUB_ANCHOR_LEAF_META_VERSION = 1;

function isHubOrderKey(value: unknown): value is HubOrderKey {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const id = record["id"];
  const key = record["key"];
  return typeof id === "string" && id.length > 0 && (key === null || typeof key === "string");
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseHubAnchorLeafMeta(value: unknown): HubAnchorLeafMeta | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const after = record["after"];
    const base = record["base"];
    const n = record["n"];
    const nn = record["nn"];
    if (
      record["v"] !== HUB_ANCHOR_LEAF_META_VERSION ||
      (after !== null && !isHubOrderKey(after)) ||
      !isCount(base) ||
      !isCount(n) ||
      !isCount(nn) ||
      nn > n ||
      (after !== null && after.key === null && nn > 0)
    ) {
      return undefined;
    }
    return { after: after === null ? null : { id: after.id, key: after.key }, base, n, nn, v: 1 };
  } catch {
    return undefined;
  }
}

export function serializeHubAnchorLeafMeta(meta: HubAnchorLeafMeta): string {
  return JSON.stringify({
    after: meta.after,
    base: meta.base,
    n: meta.n,
    nn: meta.nn,
    v: HUB_ANCHOR_LEAF_META_VERSION,
  });
}

export function hubLeafSamplesFromRows(
  rows: readonly HubOrderKey[],
  prefix: number,
  pageSize: number,
): HubPageAnchor[] {
  return rows.flatMap((row, index) => {
    const rank = prefix + index + 1;
    return rank % pageSize === 0 ? [{ id: row.id, key: row.key, page: rank / pageSize + 1 }] : [];
  });
}

export type HubProjectedPageStart = {
  after: HubOrderKey | null;

  offset: number;

  phase: "non_null" | "null";
};

export type HubAnchorLeaf = {
  anchors: HubPageAnchor[];
  meta: HubAnchorLeafMeta;

  prefix: number;
};

export function hubLeafPageStart(
  pageStart: number,
  leaf: HubAnchorLeaf,
  pageSize: number,
): HubProjectedPageStart | undefined {
  const relative = pageStart - leaf.prefix;
  if (!Number.isSafeInteger(relative) || relative < 0 || relative >= leaf.meta.n) {
    return undefined;
  }
  let best: { position: number; row: HubOrderKey } | undefined;
  for (const anchor of leaf.anchors) {
    const position = pageSize * (anchor.page - 1) - 1 - leaf.meta.base;
    if (position >= 0 && position < relative && (best === undefined || position > best.position)) {
      best = { position, row: { id: anchor.id, key: anchor.key } };
    }
  }
  if (relative >= leaf.meta.nn) {
    if (best !== undefined && best.row.key === null) {
      return { after: best.row, offset: relative - best.position - 1, phase: "null" };
    }
    if (leaf.meta.after !== null && leaf.meta.after.key === null) {
      return { after: leaf.meta.after, offset: relative, phase: "null" };
    }
    return { after: null, offset: relative - leaf.meta.nn, phase: "null" };
  }
  if (best !== undefined) {
    return { after: best.row, offset: relative - best.position - 1, phase: "non_null" };
  }
  return { after: leaf.meta.after, offset: relative, phase: "non_null" };
}

function midpointFractionDigits(lower: string, upper: string): string {
  for (let index = 0; ; index += 1) {
    const low = index < lower.length ? Number(lower[index]) : 0;
    if (index < upper.length) {
      const high = Number(upper[index]);
      if (low === high) {
        continue;
      }
      if (high - low >= 2) {
        return `${upper.slice(0, index)}${Math.floor((low + high) / 2)}`;
      }
      return `${upper.slice(0, index)}${low}${midpointFractionDigits(lower.slice(index + 1), "")}`;
    }
    if (low <= 8) {
      return `${upper.slice(0, index)}${Math.floor((low + 10) / 2)}`;
    }
    return `${upper.slice(0, index)}9${midpointFractionDigits(lower.slice(index + 1), "")}`;
  }
}

function splitShardSuffix(suffix: string): { fraction: string; integer: string } | undefined {
  const match = /^(\d+)(?:\.(\d*[1-9]))?$/.exec(suffix);
  if (match === null) {
    return undefined;
  }
  return { fraction: match[2] ?? "", integer: match[1] ?? "" };
}

export function hubAnchorShardSuffixBetween(lower: string, upper: string | undefined): string {
  const low = splitShardSuffix(lower);
  const high = upper === undefined ? undefined : splitShardSuffix(upper);
  if (low === undefined || (upper !== undefined && high === undefined)) {
    throw new Error("anchor shard suffix is malformed");
  }
  const sameInteger = high !== undefined && high.integer === low.integer;
  const upperFraction = sameInteger ? high.fraction : "";
  if (sameInteger && upperFraction <= low.fraction) {
    throw new Error("anchor shard suffixes are not ordered");
  }
  const suffix = `${low.integer}.${midpointFractionDigits(low.fraction, upperFraction)}`;
  if (suffix <= lower || (upper !== undefined && suffix >= upper)) {
    throw new Error("anchor shard suffix midpoint escaped its bounds");
  }
  return suffix;
}
