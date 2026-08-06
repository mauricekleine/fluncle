import { fnv1a } from "../log-id-shared";
import { getDb, typedRows } from "./db";

export type HubPageSqlArg = number | string;

export type HubPageClause = {
  args: HubPageSqlArg[];
  sql: string;
};

export type HubPageAnchor = {
  /** The first page whose rows start strictly after this boundary row. */
  page: number;
  id: string;
  key: null | string;
};

export type HubOrderedPageShape = {
  /** Clauses applied before any seek boundary. */
  clauses: HubPageClause[];
  /** The ordered source, including constant joins when the hub needs them. */
  from: string;
  idExpr: string;
  keyAlias: string;
  keyExpr: string;
  orderBy: string;
  pageSize: number;
  /** A CTE or other constant prefix whose bind arguments precede the page query's arguments. */
  prefix?: HubPageClause;
  /** The page row projection. The anchor query always projects only id + ordering key. */
  projection: string;
  seekAfter: (anchor: HubPageAnchor) => HubPageClause;
};

export type HubPageQuery = {
  anchor?: HubPageAnchor;
  args: HubPageSqlArg[];
  /** Rows still skipped after the nearest known boundary. Zero for a fresh per-page anchor set. */
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

/**
 * A bounded offset is cheaper than reading + fingerprinting an anchor record. The first ten hub
 * pages stay on the direct path: their largest offset is 432 rows at size 48 and 450 rows at size
 * 50. Every larger walk uses anchors when they exist.
 */
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

/**
 * Extract one boundary row per full page entirely in SQL. No growing corpus crosses into the
 * isolate: only `(rn, id, key)` rows at page-size intervals do. `orderBy` is the same literal the
 * offset and seek builders consume, so the three statements cannot silently disagree on rank.
 */
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

/** Compile today's direct `limit/offset` page while sharing the ordered shape with seek. */
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

/** The largest boundary whose target page does not exceed the requested page. */
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

/**
 * Build a numbered page as a seek from the nearest known boundary plus a bounded offset remainder.
 * A fresh extraction contains the requested page's exact boundary, so the remainder is zero. A
 * stale set can end before a newly grown tail; retaining the nearest older boundary and walking
 * only `(page - anchor.page) * pageSize` keeps that tail reachable. Rows around concurrent archive
 * mutations may drift between numbered pages, which is the pager's documented drift-window
 * semantics, but stale anchors never become a hard end cursor.
 */
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

/** Convert the extraction's tiny boundary result into persisted/memoized anchors. */
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

/** The exact clause-set key can stay readable in memory; persistence stores its compact hash. */
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

/**
 * De-duplicate one in-isolate rebuild. Refreshes are best-effort: failure is swallowed and the
 * detached promise can never block or fail the page it accelerates.
 */
export function scheduleHubPageAnchorRefresh(key: string, refresh: () => Promise<void>): void {
  if (scheduledRefreshes.has(key)) {
    return;
  }

  const task = Promise.resolve()
    .then(refresh)
    .catch(() => undefined)
    .finally(() => scheduledRefreshes.delete(key));

  scheduledRefreshes.set(key, task);

  // This module also powers the standalone hosted bench, where no Worker execution context exists;
  // the detached refresh may be cut short if an isolate ends immediately after the response.
  void task;
}
