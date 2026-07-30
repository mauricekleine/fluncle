// THE BIO REVIEW — the reader the final-attempt bypass never had.
//
// The entity-bio sweep gives an entity three authoring attempts and the THIRD draft LANDS even
// when the voice scan refuses it (`--final-attempt` → `acceptFinalDraftBio`, ./bio.ts). That is an
// explicit operator ruling and it is not reversed here. What it cost was supervision: the
// acceptance announced itself as a `FINAL-ATTEMPT ACCEPTANCE` line in the cron's stderr and as a
// `gateBypassed` field on the write response, and three separate comments called that "the operator
// review flag" — but the only consumer was a human remembering to grep, so a paragraph the gate said
// NO to sat live on `/artist/<slug>`, in its JSON-LD, and on the unauthenticated `/mcp` surface with
// nothing surfacing it.
//
// This module is that consumer. It is deliberately the `label-review` mechanism and not a second
// one: a state column on the entity (`bio_gate_bypassed_at`, the exact shape of
// `labels.seed_state = 'undecided'`) raises one row on the `/admin` attention queue, and the
// operator's ruling clears the column. No ledger table, no parallel inbox, no new notification path.
//
// THE TWO RULINGS (`resolveBioReview`):
//   - `keep`    — he read the paragraph, the gate was over-strict, the bio stands. Clears the flag
//                 and nothing else.
//   - `rewrite` — the gate was right. Clears the BIO as well (and its provenance, and
//                 `bio_status` back to `pending`), which returns the entity to the sweep's own
//                 `describe --queue` worklist with a FRESH three-attempt budget — the on-box
//                 attempt ledger already dropped its line when the bio landed
//                 (`clearAttempts` on the `authored` outcome), so nothing on the box needs
//                 re-arming for the next tick to pick it up.
//
// Both rulings carry `and bio_gate_bypassed_at is not null` in the SQL rather than a JS
// check-then-act, which is what makes `rewrite` incapable of wiping a bio that is not actually
// under review — a second, racing, or replayed ruling matches no row and reports it.

import { getDb, typedRows } from "./db";
import { type EntityKind } from "./bio";

/** One bypassed bio waiting on the operator's eye — the `bio-review` attention row's raw shape. */
export type BioReviewRow = {
  /** When the acceptance happened — the queue's oldest-first anchor. */
  anchorAt: string;
  kind: EntityKind;
  /** The entity's display name (the row's title). */
  name: string;
  slug: string;
  /** The voice-gate reasons that were ACCEPTED, verbatim. Empty only on a corrupt column. */
  violations: string[];
};

/** The operator's two rulings on a bypassed bio. */
export type BioReviewResolution = "keep" | "rewrite";

/**
 * The most bio-review rows the attention queue will ever carry, per entity kind.
 *
 * Matching {@link LABEL_REVIEW_QUEUE_LIMIT}'s discipline: the queue's job is to be actionable, not
 * exhaustive, and a source that can grow without bound would drown the other fourteen. In practice
 * the lit slice is tiny — a row exists only where an entity burned all three attempts AND the third
 * draft still failed the scan — but the cap is what makes that a property of the READ rather than a
 * hope about the data.
 */
export const BIO_REVIEW_QUEUE_LIMIT = 25;

/** The physical table behind an entity kind. A literal per branch — never an interpolated name. */
function tableFor(kind: EntityKind): "artists" | "labels" | "albums" {
  return kind === "artist" ? "artists" : kind === "label" ? "labels" : "albums";
}

/**
 * Parse the stored `bio_voice_violations` JSON back into reasons.
 *
 * TOTAL by design: a malformed or truncated column degrades to "no reasons recorded", never a throw.
 * The row's whole purpose is to be SEEN, and a queue that disappears when one column is corrupt is
 * exactly the failure this module was built to end.
 */
export function parseBioViolations(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The two column values every bio write lands, so the flag and the bio can never disagree.
 *
 * A clean write passes no violations and gets `[null, null]` — which is why a later bio that CLEARS
 * the gate wipes the review flag by construction rather than by a follow-up statement somebody has
 * to remember. The stamp and the reasons always move together: a reason with no timestamp is not
 * evidence, and a timestamp with no reasons is not actionable.
 */
export function bioBypassColumns(
  violations: readonly string[] | null | undefined,
  nowIso: string,
): [string | null, string | null] {
  return violations && violations.length > 0
    ? [nowIso, JSON.stringify([...violations])]
    : [null, null];
}

type BioReviewSqlRow = {
  bypassed_at: string;
  kind: EntityKind;
  name: string;
  slug: string;
  violations: string | null;
};

/** One kind's arm of the union — index-bounded on its own partial index, capped on its own. */
function reviewArm(kind: EntityKind): string {
  return `select * from (
            select '${kind}' as kind, slug, name,
                   bio_gate_bypassed_at as bypassed_at, bio_voice_violations as violations
            from ${tableFor(kind)}
            where bio_gate_bypassed_at is not null
            order by bio_gate_bypassed_at asc
            limit ?
          )`;
}

/**
 * Every entity whose bio landed ONLY because it was the final attempt, oldest acceptance first.
 *
 * Three arms, one round trip. Each arm is a seek of its table's PARTIAL
 * `<table>_bio_review_queue_idx` (which indexes only the lit rows) and carries its OWN
 * `BIO_REVIEW_QUEUE_LIMIT` inside a subquery, so no arm can materialise more than the cap even if
 * a broken prompt somehow lit thousands of rows — the outer `order by` then sorts at most 3× the
 * cap. `kind, slug` break the timestamp tie so paging is deterministic.
 */
export async function listBioReviewRows(): Promise<BioReviewRow[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [
      BIO_REVIEW_QUEUE_LIMIT,
      BIO_REVIEW_QUEUE_LIMIT,
      BIO_REVIEW_QUEUE_LIMIT,
      BIO_REVIEW_QUEUE_LIMIT,
    ],
    sql: `${reviewArm("artist")}
          union all
          ${reviewArm("label")}
          union all
          ${reviewArm("album")}
          order by bypassed_at asc, kind asc, slug asc
          limit ?`,
  });

  return typedRows<BioReviewSqlRow>(result.rows).map((row) => ({
    anchorAt: row.bypassed_at,
    kind: row.kind,
    name: row.name,
    slug: row.slug,
    violations: parseBioViolations(row.violations),
  }));
}

/**
 * Rule on one bypassed bio. Returns `false` when nothing was under review for that entity — an
 * unknown slug, or a review a previous (or concurrent) ruling already settled. The caller turns
 * that into a 404 rather than reporting a ruling that did not happen.
 *
 * `keep` clears the flag only. `rewrite` additionally empties the bio, drops its prompt provenance,
 * and resets `bio_status` to `pending`, which puts the entity back on the sweep's worklist — the
 * fill-empty-only write is only "fill-empty-only", so emptying the bio IS how a re-author is
 * authorised, and it is deliberately an operator act.
 */
export async function resolveBioReview(input: {
  kind: EntityKind;
  resolution: BioReviewResolution;
  slug: string;
}): Promise<boolean> {
  const db = await getDb();
  const clear = `bio_gate_bypassed_at = null, bio_voice_violations = null`;
  const wipe =
    input.resolution === "rewrite"
      ? `bio = null, bio_prompt_version = null, bio_status = 'pending', `
      : "";
  const result = await db.execute({
    args: [new Date().toISOString(), input.slug],
    // The `bio_gate_bypassed_at is not null` predicate lives HERE, not in a prior read: it is what
    // makes `rewrite` unable to empty a bio nobody flagged, however this op is replayed or raced.
    sql: `update ${tableFor(input.kind)}
            set ${wipe}${clear}, updated_at = ?
          where slug = ?
            and bio_gate_bypassed_at is not null`,
  });

  return result.rowsAffected > 0;
}
