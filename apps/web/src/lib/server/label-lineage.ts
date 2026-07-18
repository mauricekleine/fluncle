// The label-lineage resolve sweep (RFC label-lineage-remixer, U1): give every label its FOUNDING
// facts and its place in the imprint hierarchy from MusicBrainz. A bounded, idempotent,
// Worker-paced pass over the `labels` worklist — the label-images sweep's twin, walking a label's
// life-span + area + label-label relationships instead of its logo, and persisting:
//   - `founding_date`   — MusicBrainz `life-span.begin`, verbatim (a year or a full date).
//   - `founded_location`— MusicBrainz `area.name` ("London", "United Kingdom").
//   - `parent_label_id` — the label this one is a SUBLABEL / imprint of, matched to an EXISTING
//     `labels` row by MBID. This path NEVER mints a label; an unmatched parent is counted in the
//     summary, never created.
//
// ── WHY A DEDICATED SWEEP (not a rider on the image sweep) ────────────────────────────────────
// The image sweep is TERMINAL per label (a resolved/none label is never re-walked), so a label
// whose logo already resolved would never get its lineage. Lineage carries its OWN state machine
// (`lineage_state` / `lineage_attempted_at` / `lineage_failures`) so it reaches EVERY label —
// existing and crawler-minted — exactly once. It reuses the machinery it can: the shared 1 req/s
// MusicBrainz client (musicbrainz.ts), the exact-fold identity search (`searchMbLabelId`,
// label-images.ts) and its non-clobbering MBID persist (`setLabelMbLabelId`), so the two sweeps
// resolve a label's MBID the same way and never keep two divergent copies.
//
// ── RELIABILITY (the label-images convention, cloned) ─────────────────────────────────────────
// Per-label state on the row: a resolved/none label is terminal and skipped forever; a transient
// failure backs off on a cooldown and is retried; a persistent one gives up (→ `none`). MusicBrainz
// reports `rateLimited` honestly and the pass CIRCUIT-BREAKS on it — it STOPS rather than marching
// the next label into the same wall. Idempotent by construction — a second run over a fully-walked
// archive fetches nothing.

import { searchMbLabelId, setLabelMbLabelId } from "./label-images";
import { getDb, typedRows } from "./db";
import { logEvent } from "./log";
import { mbFetch } from "./musicbrainz";

// One bounded pass walks at most this many eligible labels. A label costs at most two serialized
// ~1.1s MusicBrainz calls (an identity search when no MBID is stored yet, then the label-rels
// fetch), so ~8 labels ≈ 18s stays comfortably inside the Worker/gateway request budget; a label
// whose MBID the crawler already persisted costs a single call.
const MAX_BATCH = 8;

// A label attempted within this window is skipped (the cooldown floor between two attempts on the
// SAME label). Only a transiently-failed `pending` label ever carries a recent stamp; a
// resolved/none label is terminal and excluded regardless.
const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h

// After this many consecutive failures a label GIVES UP (→ `lineage_state='none'`), so a
// persistently-failing label is never retried forever.
const MAX_FAILURES = 5;

// Wall-clock response budget for one pass. `mbFetch`'s serializer is ONE shared chain per isolate,
// so under cross-sweep contention (the crawler, recording-mbids, the artist sweep) each of this
// pass's calls can queue for minutes behind another sweep's backlog — long enough to push a full
// batch past the box CLI's 5-minute fetch timeout while the walk keeps running server-side
// (observed 2026-07-18: the tick reported "timed out" yet the labels came back stamped). Spending
// the budget is a pause, not a failure: the pass returns what it handled with a resume cursor, and
// the CLI's drain loop issues a fresh request (with a fresh budget) for the rest.
const RESPONSE_BUDGET_MS = 60_000;

// The MusicBrainz label-label relationship TYPES that express a parent (this label is the child /
// imprint / owned entity). Verified against real MB data (Med School → Hospital Records is `label
// ownership`; Hospital Records → M*A*S*H is `imprint`): when we look up the CHILD, the parent
// relation carries `direction: "backward"`, so `direction === "backward"` + one of these types IS
// the parent edge. A `direction: "forward"` relation is a CHILD of ours — skipped, since the
// child stores US as its parent and the sublabels are the reverse read.
const PARENT_REL_TYPES = new Set(["label ownership", "imprint"]);

/** One label's lineage-resolve outcome — the state machine the pass folds each label into. */
type ResolveOutcome =
  | {
      kind: "resolved";
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
  // Slugs whose lineage was walked this pass (or, in a dry run, the eligible worklist it WOULD walk).
  resolved: string[];
  resolvedCount: number;
  // Slugs with no MusicBrainz identity to walk — terminal `lineage_state='none'`.
  none: string[];
  noneCount: number;
  failed: Array<{ error: string; slug: string }>;
  failedCount: number;
  // Backward parent edges MusicBrainz named but NO label in the archive carries by MBID — noted so
  // the operator can enable/crawl the parent later; NEVER minted from this path.
  unmatchedParents: number;
  // The slug cursor to resume from, or null once the worklist is drained (or a throttle-stop).
  nextCursor: string | null;
  // True when the pass STOPPED on the MusicBrainz rate-limit circuit breaker.
  rateLimited: boolean;
};

// ── MusicBrainz label lineage walk ────────────────────────────────────────────────────────────

type MbLabelRelation = {
  direction?: string;
  label?: { id?: string; name?: string };
  type?: string;
};
type MbLabelLineageDetail = {
  area?: { name?: string } | null;
  "life-span"?: { begin?: string | null } | null;
  relations?: MbLabelRelation[];
};

/**
 * One MusicBrainz label lookup with `inc=label-rels` → its founding date (`life-span.begin`),
 * founding place (`area.name`), and the MBIDs of its parent labels (the `backward` `label
 * ownership` / `imprint` relations). Returns `rateLimited: true` when MusicBrainz is throttling so
 * the caller can circuit-break.
 */
async function fetchMbLabelLineage(mbid: string): Promise<{
  foundedLocation: string | null;
  foundingDate: string | null;
  parentMbids: string[];
  rateLimited: boolean;
}> {
  const { data, rateLimited } = await mbFetch<MbLabelLineageDetail>(
    `/label/${encodeURIComponent(mbid)}?inc=label-rels`,
  );

  if (rateLimited) {
    return { foundedLocation: null, foundingDate: null, parentMbids: [], rateLimited: true };
  }

  const begin = data?.["life-span"]?.begin;
  const areaName = data?.area?.name;
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
    foundedLocation: typeof areaName === "string" && areaName.trim() ? areaName : null,
    foundingDate: typeof begin === "string" && begin.trim() ? begin : null,
    parentMbids,
    rateLimited: false,
  };
}

// ── DB layer ─────────────────────────────────────────────────────────────────────────────────

type LabelWorkRow = {
  lineage_failures: number;
  mb_label_id: string | null;
  name: string;
  slug: string;
};

/**
 * One bounded page of the lineage worklist: `pending` labels not currently cooling down,
 * slug-cursored (the shared opaque-cursor convention). Rides the partial `labels_lineage_queue_idx`
 * (`lineage_state = 'pending'`), so the cost shrinks as the backlog drains rather than scanning the
 * whole labels table. Self-draining: as labels resolve they leave `pending`.
 */
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

/** Resolve a parent MB label MBID to an EXISTING `labels` row id (never mints), or undefined. */
async function findLabelIdByMbid(mbid: string): Promise<string | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [mbid],
    sql: `select id from labels where mb_label_id = ? limit 1`,
  });

  return typedRows<{ id: string }>(result.rows)[0]?.id;
}

/**
 * Persist a walked label's lineage. Fill-empty-only via `coalesce` on each field (never clobber a
 * value already there), and it bumps `updated_at` because the founding line is a VISIBLE change to
 * the page. `lineage_state='resolved'` is terminal — the label is never re-walked.
 */
async function markResolved(
  slug: string,
  foundingDate: string | null,
  foundedLocation: string | null,
  parentLabelId: string | null,
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();

  await db.execute({
    args: [foundingDate, foundedLocation, parentLabelId, now, now, slug],
    sql: `update labels
          set founding_date = coalesce(founding_date, ?),
              founded_location = coalesce(founded_location, ?),
              parent_label_id = coalesce(parent_label_id, ?),
              lineage_state = 'resolved', lineage_failures = 0,
              lineage_attempted_at = ?, updated_at = ?
          where slug = ?`,
  });
}

/** No MusicBrainz identity to walk — terminal `lineage_state='none'` (floors to no lineage). */
async function markNone(slug: string): Promise<void> {
  const db = await getDb();

  await db.execute({
    args: [new Date().toISOString(), slug],
    sql: `update labels
          set lineage_state = 'none', lineage_failures = 0, lineage_attempted_at = ?
          where slug = ?`,
  });
}

/**
 * Record a failed attempt: bump the failure streak + the attempt stamp (drives the cooldown
 * backoff). Past `MAX_FAILURES` the label GIVES UP (→ `none`). Touches only reliability columns.
 */
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

// ── The per-label resolve ──────────────────────────────────────────────────────────────────────

/**
 * Resolve ONE label's lineage. Resolves its MB identity (reusing a crawler-persisted MBID when
 * present, else the shared exact-fold search), fetches its life-span + area + label-rels, and
 * matches each backward parent MBID to an EXISTING label. Any exhausted vendor 429/503 returns
 * `rate-limited` so the pass can circuit-break. Never throws — a thrown error becomes `failed`.
 */
async function resolveOneLabel(row: LabelWorkRow): Promise<ResolveOutcome> {
  try {
    let mbid = row.mb_label_id;

    // 1. Identity: the MB label MBID (the crawler / image sweep may have already persisted it).
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

    // No identity to walk — terminal none (its lineage stays empty, the page degrades cleanly).
    if (!mbid) {
      return { kind: "none" };
    }

    // 2. Walk the life-span + area + label-rels.
    const lineage = await fetchMbLabelLineage(mbid);

    if (lineage.rateLimited) {
      return { kind: "rate-limited" };
    }

    // 3. Match the first backward parent that already exists in `labels` by MBID; count the rest as
    //    unmatched (named by MusicBrainz but no archive row carries them — noted, never minted).
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

// ── The pass ───────────────────────────────────────────────────────────────────────────────────

/**
 * One bounded, idempotent pass of the label-lineage resolve sweep. A dry run reports the eligible
 * worklist without any vendor call or write. Stops early on a MusicBrainz rate-limit (circuit
 * breaker) and returns `rateLimited: true` with a null cursor so the CLI stops looping this tick.
 */
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
        // Budget spent — pause, don't fail. The unwalked rest of this page resumes from the
        // cursor on the CLI's next request; the paused labels were NOT stamped, so no cooldown.
        budgetPaused = true;
        logEvent("info", "label-lineage.budget-pause", {
          handled: resolved.length + none.length + failed.length,
          pageSize: rows.length,
        });
        break;
      }

      const outcome = await resolveOneLabel(row);

      if (outcome.kind === "rate-limited") {
        // Circuit breaker: MusicBrainz is throttling. Stop; do NOT stamp this label (it was
        // throttled, not un-walkable) — the next tick retries it fresh.
        rateLimited = true;
        break;
      }

      if (outcome.kind === "resolved") {
        await markResolved(
          row.slug,
          outcome.foundingDate,
          outcome.foundedLocation,
          outcome.parentLabelId,
        );
        unmatchedParents += outcome.unmatchedParents;
        logEvent("info", "label-lineage.resolved", {
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

      // failed — back off (streak + cooldown), give up past MAX_FAILURES.
      await recordFailure(row.slug, row.lineage_failures);
      failed.push({ error: outcome.error, slug: row.slug });
      lastHandledSlug = row.slug;
    }
  }

  // Drained when the page came back short. On a throttle-stop, null the cursor so the CLI stops
  // looping this tick (the next tick resumes from the top; the cooldown re-skips this pass's
  // labels). On a budget pause, resume right after the last HANDLED label — the unwalked tail of
  // this page carries no stamp, so the very next request picks it up. A pause that handled nothing
  // (a >60s worklist query — pathological) nulls the cursor rather than hand the CLI the SAME
  // cursor back, which would loop it forever; the hourly tick retries.
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
