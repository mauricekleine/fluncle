// The label entity's backing functions — the `artists.ts` / `galaxies-map.ts` twin,
// consumed by the oRPC handlers (`./orpc/admin-labels.ts`), the `/admin/labels`
// route loader, the attention queue's read, and the publish path's upsert.
//
// ── THE ONE RULE: `seed_state` IS CRAWL SCOPE, NEVER STORAGE ────────────────────
// A label's seed state answers exactly one question — MAY THE FUTURE CATALOGUE
// CRAWLER SEED FROM THIS LABEL? Disabling a label removes it from the NEXT crawl's
// seed set and touches nothing already stored: no deletion, no hiding, no
// retroactive effect on tracks, on findings, or on anything a previous crawl
// brought in. There is deliberately NO function in this module that reads
// `seed_state` to decide what is shown, kept, or removed — and there must never be
// one. `listSeedLabels("enabled")` is the ONLY consumer shape: the seed set the
// crawler will read when it exists. See docs/label-entity.md.
//
// Identity is the SLUG, not the name. `tracks.label` stays the raw captured string
// forever (the audit trail and the re-normalization input); a label row is related
// to it by `slugify(tracks.label) = labels.slug`, which is what folds `Pilot.` and
// `Pilot` into one label without a destructive rewrite of the findings. SQLite has
// no `slugify`, so the fold happens here in TS over a bounded `GROUP BY label` read
// (one row per DISTINCT label, never a row per track).

import { randomUUID } from "node:crypto";
import { type LabelAdminItem, type LabelSeedState } from "@fluncle/contracts";
import { slugify } from "@fluncle/contracts/util/galaxy-slug";
import { getDb, typedRows } from "./db";

/** A row from the `labels` table (snake_case columns). */
type LabelRow = {
  created_at: string;
  id: string;
  name: string;
  ruled_at: string | null;
  seed_state: LabelSeedState;
  slug: string;
  updated_at: string;
};

/** One `(label, count)` pair from the bounded distinct-label read over `tracks`. */
type LabelCountRow = { label: string; n: number };

/**
 * The join key between a raw `tracks.label` string and a `labels` row. Returns
 * `undefined` for a blank or all-punctuation label (e.g. `"."`), which is exactly
 * the set of strings that must NOT mint a label row.
 */
export function labelSlug(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }

  const slug = slugify(raw.trim());

  return slug === "" ? undefined : slug;
}

function toLabelItem(row: LabelRow, findingCount: number): LabelAdminItem {
  return {
    createdAt: row.created_at,
    findingCount,
    id: row.id,
    name: row.name,
    ruledAt: row.ruled_at,
    seedState: row.seed_state,
    slug: row.slug,
    updatedAt: row.updated_at,
  };
}

const LABEL_COLUMNS = "id, name, slug, seed_state, ruled_at, created_at, updated_at";

/**
 * Every distinct `tracks.label`, folded to its slug, with how many findings carry
 * it. Bounded by construction: the `GROUP BY` returns one row per DISTINCT label
 * (tens of rows), never a row per track, so this stays a cheap read as the archive
 * grows. Two raw spellings that fold to the same slug (`Pilot.` / `Pilot`) sum.
 */
async function findingCountsBySlug(): Promise<Map<string, number>> {
  const db = await getDb();
  const result = await db.execute({
    args: [],
    sql: `select label, count(*) as n
          from tracks
          where label is not null and trim(label) <> ''
          group by label`,
  });

  const counts = new Map<string, number>();

  for (const row of typedRows<LabelCountRow>(result.rows)) {
    const slug = labelSlug(row.label);

    if (slug) {
      counts.set(slug, (counts.get(slug) ?? 0) + Number(row.n));
    }
  }

  return counts;
}

/**
 * Ensure a `labels` row exists for one raw label string. A brand-new label enters
 * as `undecided` (the DDL default) — never silently crawled, never silently
 * dropped — and lands in the operator's attention queue as a label to rule on.
 *
 * Idempotent and NON-CLOBBERING: an existing row keeps its `seed_state`, its
 * `ruled_at`, and its display `name` (the first spelling seen wins). A blank or
 * all-punctuation label mints nothing. Called best-effort from the publish path, so
 * a failure here must never block an add — the deploy-time reconcile backstops it.
 */
export async function ensureLabel(raw: string | null | undefined): Promise<void> {
  const slug = labelSlug(raw);

  if (!slug || typeof raw !== "string") {
    return;
  }

  const db = await getDb();
  const now = new Date().toISOString();

  await db.execute({
    args: [`lbl_${randomUUID()}`, raw.trim(), slug, now, now],
    sql: `insert into labels (id, name, slug, created_at, updated_at)
          values (?, ?, ?, ?, ?)
          on conflict (slug) do nothing`,
  });
}

/**
 * The deterministic reconcile: a `labels` row for every distinct `tracks.label`.
 * The self-healing backstop behind `ensureLabel` (a publish whose best-effort
 * upsert threw, a label written by a direct admin update, a row that predates the
 * table). Idempotent — an existing label is left completely alone. Returns how many
 * rows it minted. Driven by `scripts/backfill-labels.ts` on every deploy.
 */
export async function reconcileLabels(): Promise<number> {
  const db = await getDb();
  const result = await db.execute({
    args: [],
    sql: `select label, count(*) as n
          from tracks
          where label is not null and trim(label) <> ''
          group by label`,
  });

  // First spelling wins per slug — stable across runs because the row is only ever
  // inserted once (`on conflict do nothing`).
  const bySlug = new Map<string, string>();

  for (const row of typedRows<LabelCountRow>(result.rows)) {
    const slug = labelSlug(row.label);

    if (slug && !bySlug.has(slug)) {
      bySlug.set(slug, row.label.trim());
    }
  }

  let minted = 0;
  const now = new Date().toISOString();

  for (const [slug, name] of bySlug) {
    const inserted = await db.execute({
      args: [`lbl_${randomUUID()}`, name, slug, now, now],
      sql: `insert into labels (id, name, slug, created_at, updated_at)
            values (?, ?, ?, ?, ?)
            on conflict (slug) do nothing`,
    });

    minted += inserted.rowsAffected;
  }

  return minted;
}

/**
 * Every label with its finding count — the `/admin/labels` read and the CLI/agent
 * read. Optionally scoped to one seed state, which is how the future crawler will
 * ask for its seed set (`listLabels("enabled")`): the ONE sanctioned consumer of
 * `seed_state`. Name-sorted (the operator scans it alphabetically).
 */
export async function listLabels(seedState?: LabelSeedState): Promise<LabelAdminItem[]> {
  const db = await getDb();
  const result = seedState
    ? await db.execute({
        args: [seedState],
        sql: `select ${LABEL_COLUMNS} from labels where seed_state = ? order by name collate nocase`,
      })
    : await db.execute({
        args: [],
        sql: `select ${LABEL_COLUMNS} from labels order by name collate nocase`,
      });

  const counts = await findingCountsBySlug();

  return typedRows<LabelRow>(result.rows).map((row) => toLabelItem(row, counts.get(row.slug) ?? 0));
}

/** Thrown when an operator write targets a label id that isn't there. */
export class LabelNotFoundError extends Error {}

/**
 * The operator's ruling — the ONLY write that moves `seed_state`. Stamps `ruled_at`,
 * which is what tells the one-time D7 bootstrap (scripts/backfill-labels.ts) to keep
 * its hands off this row forever after.
 *
 * It changes what the NEXT crawl seeds from. It touches nothing already stored — no
 * finding, no track, no crawled row is read, hidden, or deleted here, and none ever
 * should be.
 */
export async function updateLabelSeedState(
  id: string,
  seedState: LabelSeedState,
): Promise<LabelAdminItem> {
  const db = await getDb();
  const now = new Date().toISOString();

  await db.execute({
    args: [seedState, now, now, id],
    sql: `update labels set seed_state = ?, ruled_at = ?, updated_at = ? where id = ?`,
  });

  const result = await db.execute({
    args: [id],
    sql: `select ${LABEL_COLUMNS} from labels where id = ? limit 1`,
  });
  const row = typedRows<LabelRow>(result.rows)[0];

  if (!row) {
    throw new LabelNotFoundError(`No label with id ${id}.`);
  }

  const counts = await findingCountsBySlug();

  return toLabelItem(row, counts.get(row.slug) ?? 0);
}

/** An unruled label, in the shape the attention queue's pure model derives from. */
export type LabelReviewRow = { anchorAt: string; labelId: string; name: string };

/**
 * The attention-queue source: every label still awaiting the operator's ruling.
 * Oldest-first (the queue's anchor is when the label first landed in the archive),
 * so a banger on an unseen label surfaces a cockpit row instead of quietly sitting
 * in a state nobody chose.
 */
export async function listLabelReviewRows(): Promise<LabelReviewRow[]> {
  const db = await getDb();
  const result = await db.execute({
    args: ["undecided"],
    sql: `select id, name, created_at
          from labels
          where seed_state = ?
          order by created_at asc`,
  });

  return typedRows<{ created_at: string; id: string; name: string }>(result.rows).map((row) => ({
    anchorAt: row.created_at,
    labelId: row.id,
    name: row.name,
  }));
}
