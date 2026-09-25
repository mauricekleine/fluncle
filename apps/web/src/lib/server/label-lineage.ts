import { searchMbLabelId, setLabelMbLabelId } from "./label-images";
import { getDb, typedRows } from "./db";
import { logEvent } from "./log";
import { mbFetch } from "./musicbrainz";

const MAX_BATCH = 8;

const COOLDOWN_MS = 6 * 60 * 60 * 1000;

const MAX_FAILURES = 5;

const RESPONSE_BUDGET_MS = 60_000;

const PARENT_REL_TYPES = new Set(["label ownership", "imprint"]);

type ResolveOutcome =
  | {
      kind: "resolved";
      disambiguation: string | null;
      foundedLocation: string | null;
      foundingDate: string | null;
      parentLabelId: string | null;
      unmatchedParents: number;
    }
  | { kind: "none" }
  | { kind: "failed"; error: string }
  | { kind: "rate-limited" };

export type LabelLineageResolveResult = {
  dryRun: boolean;

  resolved: string[];
  resolvedCount: number;

  none: string[];
  noneCount: number;
  failed: Array<{ error: string; slug: string }>;
  failedCount: number;

  unmatchedParents: number;

  nextCursor: string | null;

  rateLimited: boolean;
};

type MbLabelRelation = {
  direction?: string;
  label?: { id?: string; name?: string };
  type?: string;
};
type MbLabelLineageDetail = {
  area?: { name?: string } | null;

  disambiguation?: string | null;
  "life-span"?: { begin?: string | null } | null;
  relations?: MbLabelRelation[];
};

async function fetchMbLabelLineage(mbid: string): Promise<{
  disambiguation: string | null;
  foundedLocation: string | null;
  foundingDate: string | null;
  parentMbids: string[];
  rateLimited: boolean;
}> {
  const { data, rateLimited } = await mbFetch<MbLabelLineageDetail>(
    `/label/${encodeURIComponent(mbid)}?inc=label-rels`,
  );

  if (rateLimited) {
    return {
      disambiguation: null,
      foundedLocation: null,
      foundingDate: null,
      parentMbids: [],
      rateLimited: true,
    };
  }

  const begin = data?.["life-span"]?.begin;
  const areaName = data?.area?.name;
  const comment = data?.disambiguation;
  const parentMbids: string[] = [];

  for (const relation of data?.relations ?? []) {
    const relatedId = relation.label?.id;

    if (
      relatedId &&
      relation.direction === "backward" &&
      relation.type &&
      PARENT_REL_TYPES.has(relation.type)
    ) {
      parentMbids.push(relatedId);
    }
  }

  return {
    disambiguation: typeof comment === "string" && comment.trim() ? comment.trim() : null,
    foundedLocation: typeof areaName === "string" && areaName.trim() ? areaName : null,
    foundingDate: typeof begin === "string" && begin.trim() ? begin : null,
    parentMbids,
    rateLimited: false,
  };
}

type LabelWorkRow = {
  lineage_failures: number;
  mb_label_id: string | null;
  name: string;
  slug: string;
};

async function listPendingLabels(
  limit: number,
  cursor: string | undefined,
): Promise<LabelWorkRow[]> {
  const db = await getDb();
  const cooldownBefore = new Date(Date.now() - COOLDOWN_MS).toISOString();

  const result = await db.execute({
    args: cursor ? [cooldownBefore, cursor, limit] : [cooldownBefore, limit],
    sql: cursor
      ? `select slug, name, mb_label_id, lineage_failures
         from labels
         where lineage_state = 'pending'
           and (lineage_attempted_at is null or lineage_attempted_at < ?)
           and slug > ?
         order by slug asc limit ?`
      : `select slug, name, mb_label_id, lineage_failures
         from labels
         where lineage_state = 'pending'
           and (lineage_attempted_at is null or lineage_attempted_at < ?)
         order by slug asc limit ?`,
  });

  return typedRows<LabelWorkRow>(result.rows);
}

async function findLabelIdByMbid(mbid: string): Promise<string | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [mbid],
    sql: `select id from labels where mb_label_id = ? limit 1`,
  });

  return typedRows<{ id: string }>(result.rows)[0]?.id;
}

async function markResolved(
  slug: string,
  foundingDate: string | null,
  foundedLocation: string | null,
  disambiguation: string | null,
  parentLabelId: string | null,
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();

  await db.execute({
    args: [foundingDate, foundedLocation, disambiguation, parentLabelId, now, now, slug],
    sql: `update labels
          set founding_date = coalesce(founding_date, ?),
              founded_location = coalesce(founded_location, ?),
              disambiguation = coalesce(disambiguation, ?),
              parent_label_id = coalesce(parent_label_id, ?),
              lineage_state = 'resolved', lineage_failures = 0,
              lineage_attempted_at = ?, updated_at = ?
          where slug = ?`,
  });
}

async function markNone(slug: string): Promise<void> {
  const db = await getDb();

  await db.execute({
    args: [new Date().toISOString(), slug],
    sql: `update labels
          set lineage_state = 'none', lineage_failures = 0, lineage_attempted_at = ?
          where slug = ?`,
  });
}

async function recordFailure(slug: string, priorFailures: number): Promise<void> {
  const db = await getDb();
  const failures = priorFailures + 1;
  const giveUp = failures >= MAX_FAILURES;

  await db.execute({
    args: [failures, giveUp ? "none" : "pending", new Date().toISOString(), slug],
    sql: `update labels
          set lineage_failures = ?, lineage_state = ?, lineage_attempted_at = ?
          where slug = ?`,
  });
}

async function resolveOneLabel(row: LabelWorkRow): Promise<ResolveOutcome> {
  try {
    let mbid = row.mb_label_id;

    if (!mbid) {
      const search = await searchMbLabelId(row.name);

      if (search.rateLimited) {
        return { kind: "rate-limited" };
      }

      mbid = search.mbid;

      if (mbid) {
        await setLabelMbLabelId(row.slug, mbid);
      }
    }

    if (!mbid) {
      return { kind: "none" };
    }

    const lineage = await fetchMbLabelLineage(mbid);

    if (lineage.rateLimited) {
      return { kind: "rate-limited" };
    }

    let parentLabelId: string | null = null;
    let unmatchedParents = 0;

    for (const parentMbid of lineage.parentMbids) {
      const existingId = await findLabelIdByMbid(parentMbid);

      if (existingId && !parentLabelId) {
        parentLabelId = existingId;
      } else if (!existingId) {
        unmatchedParents += 1;
      }
    }

    return {
      disambiguation: lineage.disambiguation,
      foundedLocation: lineage.foundedLocation,
      foundingDate: lineage.foundingDate,
      kind: "resolved",
      parentLabelId,
      unmatchedParents,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), kind: "failed" };
  }
}

export async function resolveLabelLineage(
  limit: number,
  dryRun: boolean,
  cursor?: string,
): Promise<LabelLineageResolveResult> {
  const batchLimit = Math.max(1, Math.min(limit, MAX_BATCH));
  const rows = await listPendingLabels(batchLimit, cursor);

  const resolved: string[] = [];
  const none: string[] = [];
  const failed: Array<{ error: string; slug: string }> = [];
  let unmatchedParents = 0;
  let rateLimited = false;
  let budgetPaused = false;
  let lastHandledSlug: string | null = null;
  const deadline = Date.now() + RESPONSE_BUDGET_MS;

  if (dryRun) {
    for (const row of rows) {
      resolved.push(row.slug);
    }
  } else {
    for (const row of rows) {
      if (Date.now() >= deadline) {
        budgetPaused = true;
        logEvent("info", "label-lineage.budget-pause", {
          handled: resolved.length + none.length + failed.length,
          pageSize: rows.length,
        });
        break;
      }

      const outcome = await resolveOneLabel(row);

      if (outcome.kind === "rate-limited") {
        rateLimited = true;
        break;
      }

      if (outcome.kind === "resolved") {
        await markResolved(
          row.slug,
          outcome.foundingDate,
          outcome.foundedLocation,
          outcome.disambiguation,
          outcome.parentLabelId,
        );
        unmatchedParents += outcome.unmatchedParents;
        logEvent("info", "label-lineage.resolved", {
          disambiguation: outcome.disambiguation,
          foundedLocation: outcome.foundedLocation,
          foundingDate: outcome.foundingDate,
          parentLabelId: outcome.parentLabelId,
          slug: row.slug,
          unmatchedParents: outcome.unmatchedParents,
        });
        resolved.push(row.slug);
        lastHandledSlug = row.slug;
        continue;
      }

      if (outcome.kind === "none") {
        await markNone(row.slug);
        none.push(row.slug);
        lastHandledSlug = row.slug;
        continue;
      }

      await recordFailure(row.slug, row.lineage_failures);
      failed.push({ error: outcome.error, slug: row.slug });
      lastHandledSlug = row.slug;
    }
  }

  const lastSlug = rows.at(-1)?.slug ?? null;
  const nextCursor = rateLimited
    ? null
    : budgetPaused
      ? lastHandledSlug
      : rows.length < batchLimit
        ? null
        : lastSlug;

  return {
    dryRun,
    failed,
    failedCount: failed.length,
    nextCursor,
    none,
    noneCount: none.length,
    rateLimited,
    resolved,
    resolvedCount: resolved.length,
    unmatchedParents,
  };
}
