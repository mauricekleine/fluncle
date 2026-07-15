// The label entity's backing functions — the `artists.ts` / `galaxies-map.ts` twin,
// consumed by the oRPC handlers (`./orpc/admin-labels.ts`), the `/admin/labels`
// route loader, the attention queue's read, and the publish path's upsert.
//
// ── THE ONE RULE: `seed_state` IS CRAWL SCOPE, NEVER STORAGE ────────────────────
// A label's seed state answers exactly one question — MAY THE CATALOGUE CRAWLER
// SEED FROM THIS LABEL? Disabling a label removes it from the NEXT crawl's
// seed set and touches nothing already stored: no deletion, no hiding, no
// retroactive effect on tracks, on findings, or on anything a previous crawl
// brought in. There is deliberately NO function in this module that reads
// `seed_state` to decide what is shown, kept, or removed — and there must never be
// one. `listLabels("enabled")` is the ONLY consumer shape: the seed set the
// crawler reads (crawl.ts). See docs/label-entity.md.
//
// Identity is the SLUG, not the name. `tracks.label` stays the raw captured string
// forever (the audit trail and the re-normalization input); a label row is related
// to it by `slugify(tracks.label) = labels.slug`, which is what folds `Pilot.` and
// `Pilot` into one label without a destructive rewrite of the findings. SQLite has
// no `slugify`, so the fold happens here in TS over a bounded `GROUP BY label` read
// (one row per DISTINCT label, never a row per track).

import { randomUUID } from "node:crypto";
import {
  type LabelAdminItem,
  type LabelAliasCandidate,
  type LabelSeedState,
} from "@fluncle/contracts";
import { labelFold, slugify } from "@fluncle/contracts/util/galaxy-slug";
import { labelLogoUrl } from "../media";
import { getDb, typedRows } from "./db";

// Re-exported so the label module is the one home for label string identity: the crawler
// (`crawl.ts`) folds MB label names with it, and the alias derivation folds Apple recordLabels
// with it, so the two agree by construction. `labelFold` is more aggressive than `labelSlug`:
// it drops ALL non-alphanumerics ("Med School" ⇄ "Medschool"), where the slug keeps the fold's
// hyphen boundary ("med-school" ≠ "medschool"). See @fluncle/contracts/util/galaxy-slug.
export { labelFold };

// The thin-content gate for label pages: a `/label/<slug>` page indexes (and enters the
// sitemap) only with this many RENDERABLE tracks or more — its findings plus the quieter
// rows beneath them, because both are real content on the page. Below it the page still
// serves 200 (deep links + link equity) but is `noindex, follow` and stays out of the
// sitemap. Same value and same job as `ARTIST_INDEX_MIN_FINDINGS`; see
// `ALBUM_INDEX_MIN_TRACKS` for why the count is over renderable tracks rather than
// findings alone.
export const LABEL_INDEX_MIN_TRACKS = 3;

// The distributor denylist (U2a) lives in a client-safe module so the deploy-time derivation
// shares one source of truth; re-exported here as the runtime home the label consumers reach.
export { DISTRIBUTOR_DENYLIST, isDistributorLabel } from "../label-distributors";

/** A row from the `labels` table (snake_case columns). */
type LabelRow = {
  created_at: string;
  id: string;
  image_key: string | null;
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
    logoImageUrl: labelLogoUrl(row.image_key),
    name: row.name,
    ruledAt: row.ruled_at,
    seedState: row.seed_state,
    slug: row.slug,
    updatedAt: row.updated_at,
  };
}

const LABEL_COLUMNS = "id, name, slug, seed_state, ruled_at, created_at, updated_at, image_key";

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
    sql: `select tracks.label as label, count(*) as n
          from findings join tracks on tracks.track_id = findings.track_id
          where tracks.label is not null and trim(tracks.label) <> ''
          group by tracks.label`,
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
 * The CONFIRMED-ALIAS choke point: does a slug resolve to an existing label through a spelling
 * the operator has already folded in? Returns the canonical `label_id`, or `undefined` when the
 * slug is nobody's confirmed alias. One indexed read on `label_aliases_alias_slug_idx`.
 *
 * This is the correctness trap the whole unit exists for. `tracks.label` is immutable, so a raw
 * string whose spelling an operator folded into another label (via a confirmed alias) would, on
 * the next `ensureLabel` or deploy `reconcileLabels`, re-mint its own slug as a NEW label —
 * un-doing the fold every deploy. Consulting confirmed aliases BEFORE minting closes that.
 */
async function resolveConfirmedAliasLabelId(slug: string): Promise<string | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [slug],
    sql: `select label_id from label_aliases where alias_slug = ? and status = 'confirmed' limit 1`,
  });

  return typedRows<{ label_id: string }>(result.rows)[0]?.label_id;
}

/**
 * Ensure a `labels` row exists for one raw label string, and return its id. A brand-new
 * label enters as `undecided` (the DDL default) — never silently crawled, never silently
 * dropped — and lands in the operator's attention queue as a label to rule on.
 *
 * Idempotent and NON-CLOBBERING: an existing row keeps its `seed_state`, its
 * `ruled_at`, and its display `name` (the first spelling seen wins). A blank or
 * all-punctuation label mints nothing. Called best-effort from the publish path, so
 * a failure here must never block an add — the deploy-time reconcile backstops it.
 *
 * TWO IDENTITIES, resolved in priority order (the `ensureAlbum` twin — read that first):
 *
 *   1. THE MUSICBRAINZ LABEL MBID (`mb_label_id`), when the caller has one — the catalogue
 *      crawler does, off MusicBrainz's release `label-info[].label.id`. It is the STABLE fold
 *      key: two spellings of one label that slugify apart ("Med School" ⇄ "Medschool") resolve
 *      to the SAME row. Resolved FIRST, so a label already folded on this MBID is reused outright.
 *   2. THE CONFIRMED ALIAS (`resolveConfirmedAliasLabelId`) — a spelling the operator has folded
 *      into another label. Then THE SLUG (`slugify(name)`) — the display identity, and the
 *      fallback fold when no MBID exists (the publish path passes none; a discovered label whose
 *      release carries no label MBID has none).
 *
 * When a caller carries an MBID and the row it lands on (minted this call, or pre-existing off the
 * slug/alias because a finding minted it first) has none yet, the MBID is ADOPTED onto that row —
 * fill-empty-only, so a row already folded on a DIFFERENT MBID is never rewritten and the unique
 * index guards a genuine collision. That is what lets a publish-minted label and the crawler's
 * later discovery collapse into one row instead of duplicating. It mirrors the SEED path, which
 * stamps the same column via `setLabelMbLabelId` (label-images.ts) — the two write fill-empty-only,
 * so they never fight.
 *
 * ── ALIAS-AWARE (RFC musickit-second-authority, U2a) ────────────────────────────
 * The crawler reaches this same choke point (`crawl.ts` calls `ensureLabel` on a discovered
 * label), so its discovery path is covered by both the MBID fold and the confirmed-alias fold.
 */
export async function ensureLabel(
  raw: string | null | undefined,
  mbLabelId?: null | string,
): Promise<string | undefined> {
  const db = await getDb();
  const mbid = typeof mbLabelId === "string" && mbLabelId.trim() ? mbLabelId.trim() : null;

  // 1. mbid-first: a label already folded on this MusicBrainz MBID wins, whatever its slug.
  if (mbid) {
    const byMbid = await db.execute({
      args: [mbid],
      sql: `select id from labels where mb_label_id = ? limit 1`,
    });
    const existingId = typedRows<{ id: string }>(byMbid.rows)[0]?.id;

    if (existingId) {
      return existingId;
    }
  }

  // 2. the alias/slug path — mint (or reuse) by the operator's fold, then the display identity.
  const slug = labelSlug(raw);

  if (!slug || typeof raw !== "string") {
    return undefined;
  }

  const aliasLabelId = await resolveConfirmedAliasLabelId(slug);

  if (aliasLabelId) {
    await adoptLabelMbLabelId(aliasLabelId, mbid);

    return aliasLabelId;
  }

  const now = new Date().toISOString();

  await db.execute({
    args: [`lbl_${randomUUID()}`, raw.trim(), slug, mbid, now, now],
    sql: `insert into labels (id, name, slug, mb_label_id, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?)
          on conflict (slug) do nothing`,
  });

  const result = await db.execute({
    args: [slug],
    sql: `select id, mb_label_id from labels where slug = ? limit 1`,
  });
  const row = typedRows<{ id: string; mb_label_id: null | string }>(result.rows)[0];

  if (!row) {
    return undefined;
  }

  // Adopt the MBID onto a pre-existing slug row that has none — fill-empty-only.
  if (!row.mb_label_id) {
    await adoptLabelMbLabelId(row.id, mbid);
  }

  return row.id;
}

/**
 * Adopt a MusicBrainz label MBID onto a row that has none — fill-empty-only (`where mb_label_id
 * is null`). A rare concurrent adoption of the same MBID onto two slugs loses the unique-index
 * race harmlessly; the id is already in the caller's hand, so a throw here must not lose it (the
 * `.catch()` keeps it). A no-op when there is no MBID to adopt.
 */
async function adoptLabelMbLabelId(labelId: string, mbid: null | string): Promise<void> {
  if (!mbid) {
    return;
  }

  const db = await getDb();

  await db
    .execute({
      args: [mbid, new Date().toISOString(), labelId],
      sql: `update labels set mb_label_id = ?, updated_at = ?
            where id = ? and mb_label_id is null`,
    })
    .catch(() => undefined);
}

/**
 * The publish path's one call: mint the label entity for the label Deezer handed back, and
 * stamp the track's `label_id` pointer at it — the indexed edge the public `/label/<slug>`
 * page reads by (schema.ts, `tracks.label_id`). Best-effort and purely additive; the
 * deploy-time reconcile backstops a failure.
 *
 * This writes a POINTER, never a ruling: it can mint an `undecided` label, and it can
 * never move a `seed_state`.
 */
export async function linkTrackToLabel(
  trackId: string,
  raw: string | null | undefined,
): Promise<void> {
  const labelId = await ensureLabel(raw);

  if (!labelId) {
    return;
  }

  const db = await getDb();

  await db.execute({
    args: [labelId, trackId],
    sql: `update tracks set label_id = ? where track_id = ?`,
  });
}

/** The canonical label identity record the public page + JSON-LD read. */
export type LabelRecord = {
  /**
   * The label's voiced public bio (the entity sibling of a finding's `note`), or undefined
   * when none is authored yet. Optional so the callers that mint a bare `LabelRecord`
   * (e.g. `getLabelForAlbum`) need not carry it; the surfacing PR reads it off
   * `getLabelBySlug`. See lib/server/bio.ts.
   */
  bio?: string;
  id: string;
  /**
   * The label's OWN logo (its resolved Discogs/Wikidata image on R2), or undefined when it has
   * none yet — the caller then falls back to the freshest finding's cover. See label-images.ts.
   */
  logoImageUrl: string | undefined;
  name: string;
  slug: string;
};

/** A row in the `/labels` index + a thin-gated sitemap candidate. */
export type LabelIndexEntry = {
  /**
   * Uncertified tracks linked to this label — the quieter rows the page will render. It is
   * NOT shown in the index (the tier has no public name and is never counted aloud); it
   * exists so the SITEMAP can apply the same renderable-track gate the PAGE applies, and an
   * indexable page is therefore never orphaned from the sitemap. Zero until the catalogue
   * lands.
   */
  catalogueCount: number;
  /** The label's cover — its freshest finding's Spotify album art (the fallback for the logo). */
  coverImageUrl: string | undefined;
  findingCount: number;
  /** The label's OWN logo (its resolved Discogs/Wikidata image on R2), or undefined. */
  logoImageUrl: string | undefined;
  /** ISO of the label's freshest finding — the sitemap `lastmod`. */
  lastmod: string | undefined;
  name: string;
  slug: string;
};

/** Resolve one label by its public slug (undefined = no such label). */
export async function getLabelBySlug(slug: string): Promise<LabelRecord | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [slug],
    sql: `select ${LABEL_COLUMNS}, bio from labels where slug = ? limit 1`,
  });

  const row = typedRows<LabelRow & { bio: string | null }>(result.rows)[0];

  return row
    ? {
        bio: typeof row.bio === "string" && row.bio.trim() ? row.bio : undefined,
        id: row.id,
        logoImageUrl: labelLogoUrl(row.image_key),
        name: row.name,
        slug: row.slug,
      }
    : undefined;
}

/**
 * The label an album came out on — the album → label edge of the graph, and the one place the
 * graph CLOSES (it is stamped into the `MusicAlbum` JSON-LD as `albumRelease.recordLabel`).
 * An album's tracks can in principle disagree (a compilation, a re-press); the MOST COMMON
 * label wins, which is the honest answer and a stable one. Undefined when no finding on the
 * album carries a label.
 *
 * Only CERTIFIED tracks vote, and it is now the HONEST reason carrying this alone: this edge
 * says "the label Fluncle's finding came out on", and a crawled row that merely shares a
 * release is not evidence about that. Let the whole catalogue vote and a compilation's thirty
 * crawled rows outvote the one finding the page is ABOUT.
 *
 * It used to have a second, structural reason — a zero-finding label 404'd, so an uncertified
 * winner would point the link (and an `@id` in the schema.org graph) at a page that was not
 * there. That reason is GONE: a label earns a page on its content now, so an uncertified
 * winner would resolve fine. The findings-only vote stays anyway, because it was always the
 * better answer on the merits; it just no longer has a safety net under it.
 */
export async function getLabelForAlbum(albumId: string): Promise<LabelRecord | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [albumId],
    sql: `select labels.id, labels.name, labels.slug, count(*) as n
          from tracks
          join labels on labels.id = tracks.label_id
          join findings on findings.track_id = tracks.track_id
          where tracks.album_id = ? and findings.log_id is not null
          group by labels.id
          order by n desc, labels.name collate nocase asc
          limit 1`,
  });

  const row = typedRows<{ id: string; name: string; slug: string }>(result.rows)[0];

  // The album → label edge closes the graph in JSON-LD (recordLabel) — a name/slug pointer,
  // never an image — so the logo is deliberately left undefined here.
  return row ? { id: row.id, logoImageUrl: undefined, name: row.name, slug: row.slug } : undefined;
}

/**
 * Every label with at least one coordinate-bearing finding, with its finding count, its
 * cover (the freshest finding's album art), and that finding's date (the sitemap
 * `lastmod`). Alphabetical by name — the `/labels` index order.
 *
 * The PUBLIC index read, and it is deliberately blind to `seed_state`: a skipped label's
 * findings render exactly as they always did (crawl scope, never storage — the rule at the
 * top of this file). It drives from the findings join, so it is bounded by the archive
 * rather than by the catalogue. The sitemap filters it further by the thin-content gate.
 */
export async function listLabelsWithFindingCounts(): Promise<LabelIndexEntry[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: `select labels.name as name, labels.slug as slug, labels.image_key as image_key,
                 count(*) as finding_count,
                 (select count(*) from tracks t3
                    left join findings f3 on f3.track_id = t3.track_id
                    where t3.label_id = labels.id and f3.track_id is null) as catalogue_count,
                 max(findings.added_at) as lastmod,
                 (select t2.album_image_url
                    from findings f2 join tracks t2 on t2.track_id = f2.track_id
                    where t2.label_id = labels.id and f2.log_id is not null
                    order by f2.added_at desc limit 1) as cover_url
          from labels
          join tracks on tracks.label_id = labels.id
          join findings on findings.track_id = tracks.track_id
          where findings.log_id is not null
          group by labels.id
          order by labels.name collate nocase asc`,
  });

  return typedRows<{
    catalogue_count: number;
    cover_url: string | null;
    finding_count: number;
    image_key: string | null;
    lastmod: string | null;
    name: string;
    slug: string;
  }>(result.rows).map((row) => ({
    catalogueCount: Number(row.catalogue_count),
    coverImageUrl: row.cover_url ?? undefined,
    findingCount: Number(row.finding_count),
    lastmod: row.lastmod ?? undefined,
    logoImageUrl: labelLogoUrl(row.image_key),
    name: row.name,
    slug: row.slug,
  }));
}

/** A sitemap candidate: an entity whose page clears the thin-content floor. */
export type EntitySitemapRow = {
  coverImageUrl: string | undefined;
  /** Freshest finding date on the entity, or undefined when it carries none. */
  lastmod: string | undefined;
  slug: string;
};

/**
 * Every LABEL whose page clears the thin-content floor — findings or no findings.
 *
 * ── WHY THIS IS NOT `listLabelsWithFindingCounts` ───────────────────────────────────────
 * That read is the `/labels` HUB: Fluncle's own editorial list of the labels he has pulled a
 * banger off, so it drives from the findings join and a label he never certified on is
 * rightly absent. The SITEMAP asks a different question — "what pages exist and may be
 * indexed?" — and since a label page now exists on crawled content alone, answering it with
 * the hub's read would orphan every one of those pages from the sitemap. That orphaning is
 * precisely the invariant album-entity.md states ("an indexable page is never orphaned from
 * it"), so the two reads have to differ.
 *
 * ── THE FLOOR IS APPLIED IN SQL ─────────────────────────────────────────────────────────
 * `having` it, not filtering it in the isolate: a wide crawl mints a `labels` row per imprint
 * it walks past and most will sit on one or two rows, so filtering in TypeScript would drag
 * every one of those stubs across the wire to throw them away (AGENTS.md — never rank or
 * filter a growing table in the Worker). `minTracks` is the caller's constant, so the gate
 * has exactly one definition and the page and the sitemap cannot drift apart.
 *
 * The counts are conditional aggregates over ONE pass (`left join findings`), which is
 * strictly less work than the hub read it replaces here: that one did the same grouped scan
 * AND two correlated subqueries per row.
 */
export async function listLabelSitemapRows(minTracks: number): Promise<EntitySitemapRow[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [minTracks],
    // A finding counts only when it is coordinate-bearing (`log_id is not null`), because
    // that is exactly what the page renders in the grid; a catalogue row is the anti-join's
    // complement. Their sum is the RENDERABLE track count the page's `indexable` keys off,
    // so the two agree by construction.
    sql: `select labels.slug as slug,
                 max(findings.added_at) as lastmod,
                 (select t2.album_image_url
                    from findings f2 join tracks t2 on t2.track_id = f2.track_id
                    where t2.label_id = labels.id and f2.log_id is not null
                    order by f2.added_at desc limit 1) as cover_url
          from labels
          join tracks on tracks.label_id = labels.id
          left join findings on findings.track_id = tracks.track_id
          group by labels.id
          having sum(case when findings.log_id is not null then 1 else 0 end)
               + sum(case when findings.track_id is null then 1 else 0 end) >= ?
          order by labels.slug asc`,
  });

  return typedRows<{
    cover_url: string | null;
    lastmod: string | null;
    slug: string;
  }>(result.rows).map((row) => ({
    coverImageUrl: row.cover_url ?? undefined,
    lastmod: row.lastmod ?? undefined,
    slug: row.slug,
  }));
}

/**
 * The deterministic reconcile: a `labels` row for every distinct label carried by a
 * CERTIFIED finding. The self-healing backstop behind `ensureLabel` (a publish whose
 * best-effort upsert threw, a label written by a direct admin update, a row that
 * predates the table). Idempotent — an existing label is left completely alone. Returns
 * how many rows it minted. Driven by `scripts/backfill-labels.ts` on every deploy.
 *
 * It seeds from the finding join, NOT from a bare `tracks` scan, and that is deliberate:
 * a label earns a row — and a slot in the operator's `label-review` attention queue —
 * because Fluncle FOUND something on it. Minting off the raw catalogue would flood that
 * queue with the label of every track Fluncle has merely heard of, the moment the
 * catalogue epic lands. Same predicate as `findingCountsBySlug`, so the mint and the
 * count can never disagree.
 *
 * ── ALIAS-AWARE (RFC musickit-second-authority, U2a) ────────────────────────────
 * A confirmed alias's slug is NEVER re-minted: it already resolves to another label, and
 * `tracks.label` is immutable, so minting it here would re-open a fold the operator closed —
 * every deploy. The confirmed-alias slug set is preloaded once (the `findingCountsBySlug`
 * pattern) and any slug in it is skipped. NOTE: the deploy path is `scripts/backfill-labels.ts`
 * (which carries the same guard); this runtime twin is proven by the re-mint regression test.
 */
export async function reconcileLabels(): Promise<number> {
  const db = await getDb();
  const result = await db.execute({
    args: [],
    sql: `select tracks.label as label, count(*) as n
          from findings join tracks on tracks.track_id = findings.track_id
          where tracks.label is not null and trim(tracks.label) <> ''
          group by tracks.label`,
  });

  // Every slug the operator has already folded into another label — preloaded once so the
  // mint loop below never re-mints one (the re-mint trap this unit closes).
  const confirmedAliasSlugs = await confirmedAliasSlugSet();

  // First spelling wins per slug — stable across runs because the row is only ever
  // inserted once (`on conflict do nothing`).
  const bySlug = new Map<string, string>();

  for (const row of typedRows<LabelCountRow>(result.rows)) {
    const slug = labelSlug(row.label);

    if (slug && !confirmedAliasSlugs.has(slug) && !bySlug.has(slug)) {
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
 * read. Optionally scoped to one seed state, which is how the crawler asks for
 * its seed set (`listLabels("enabled")`): the ONE sanctioned consumer of
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

// ── The voiced bio: fill-empty-only write + the worklist (the entity-bio engine) ──────
//
// The label bio is the entity sibling of a finding's `note` and inherits its cardinal
// safety guarantee: the agent NEVER overwrites an existing bio. The `and (bio is null or
// trim(bio) = '')` predicate lives in the SQL, so an operator bio (or a second agent tick)
// that lands between the handler's read and this write can never be clobbered — the loser
// matches no row (mirrors `fillEmptyNote` / `fillEmptyArtistBio`).

/**
 * Fill a label's bio ATOMICALLY, only when it is currently empty. The bio + its PROVENANCE
 * (`bio_prompt_version`) + `bio_status = 'resolved'` land in the SAME statement, gated by the
 * fill-empty-only predicate. Returns whether a row was written (false = a non-empty bio was
 * already there / the label is gone). `promptVersion` is undefined for an operator-typed bio
 * and null when the sweep fell back to its baked prompt — both store NULL. The caller has
 * already voice-gated the bio (`gateBioText`).
 */
export async function fillEmptyLabelBio(
  slug: string,
  bio: string,
  promptVersion?: number | null,
): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({
    args: [bio, promptVersion ?? null, new Date().toISOString(), slug],
    sql: `update labels
            set bio = ?, bio_prompt_version = ?, bio_status = 'resolved', updated_at = ?
          where slug = ?
            and (bio is null or trim(bio) = '')`,
  });

  return result.rowsAffected > 0;
}

/** One row of the bio worklist: a label with findings but no bio yet. */
export type LabelBioWorkItem = { id: string; name: string; slug: string };

/**
 * The bio worklist: labels that have at least one coordinate-bearing finding but NO bio
 * yet, oldest-first — the worklist the future `describe_label` cron drains. A bare read
 * (no writes), bounded by `limit`. A label earns a bio only once Fluncle has logged a track
 * on it, so the `exists` gate is the same certified-finding floor the label page uses.
 */
export async function listLabelsMissingBio(limit: number): Promise<LabelBioWorkItem[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [limit],
    sql: `select l.id, l.name, l.slug
          from labels l
          where (l.bio is null or trim(l.bio) = '')
            and exists (
              select 1 from tracks t
              join findings f on f.track_id = t.track_id
              where t.label_id = l.id and f.log_id is not null
            )
          order by l.created_at asc
          limit ?`,
  });

  return typedRows<{ id: string; name: string; slug: string }>(result.rows).map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
  }));
}

/** An unruled label, in the shape the attention queue's pure model derives from. */
export type LabelReviewRow = { anchorAt: string; labelId: string; name: string };

/**
 * The most unruled labels the attention queue will ever carry.
 *
 * The queue used to take ALL of them, which was right when a new label arrived only on a
 * publish — tens of rows, ever. The crawler changed the arithmetic: every imprint the walk
 * discovers mints an `undecided` row (that row IS the ruling queue — docs/catalogue-crawler.md,
 * "the widening loop"), so a wide crawl over 27 seed labels proposes HUNDREDS. Uncapped, that
 * is hundreds of `AttentionItem`s in the `/admin` SSR payload, in the react-query cache, and
 * printed one-per-line by `fluncle admin queue` and the Raycast menu bar — a cockpit you
 * cannot read is a cockpit that is off.
 *
 * So the queue takes a WORKING SET, oldest-first, and `/admin/labels` stays the station where
 * the full list is ruled on. Capping the queue never hides a label from the operator; it stops
 * one source from drowning the other five.
 */
export const LABEL_REVIEW_QUEUE_LIMIT = 25;

/**
 * The attention-queue source: the oldest labels still awaiting the operator's ruling, capped
 * at {@link LABEL_REVIEW_QUEUE_LIMIT}. Oldest-first (the queue's anchor is when the label
 * first landed in the archive), so a banger on an unseen label surfaces a cockpit row instead
 * of quietly sitting in a state nobody chose.
 */
export async function listLabelReviewRows(): Promise<LabelReviewRow[]> {
  const db = await getDb();
  const result = await db.execute({
    args: ["undecided", LABEL_REVIEW_QUEUE_LIMIT],
    sql: `select id, name, created_at
          from labels
          where seed_state = ?
          order by created_at asc
          limit ?`,
  });

  return typedRows<{ created_at: string; id: string; name: string }>(result.rows).map((row) => ({
    anchorAt: row.created_at,
    labelId: row.id,
    name: row.name,
  }));
}

// ── LABEL ALIASES: two spellings, one label (RFC musickit-second-authority, U2a) ────────────
// A second metadata authority (Apple `recordLabel`, corroborated by MusicBrainz over a shared
// ISRC) proposes an alternate spelling of a label; the operator confirms or rejects it. A
// CONFIRMED alias (1) protects its slug from re-minting (above), and (2) joins the public
// `/label/<slug>` Organization JSON-LD as `alternateName` (decision C). See docs/label-entity.md.

/**
 * Every slug the operator has folded into another label via a CONFIRMED alias — preloaded once
 * for the reconcile's re-mint guard (the `findingCountsBySlug` pattern). Bounded: `label_aliases`
 * holds a handful of rows per label, never one per track.
 */
async function confirmedAliasSlugSet(): Promise<Set<string>> {
  const db = await getDb();
  const result = await db.execute(
    `select alias_slug from label_aliases where status = 'confirmed'`,
  );

  return new Set(typedRows<{ alias_slug: string }>(result.rows).map((row) => row.alias_slug));
}

/**
 * A label's CONFIRMED alternate spellings, name-sorted — the `alternateName` array the public
 * `/label/<slug>` Organization JSON-LD carries (decision C). `candidate`/`hint` never surface
 * publicly, so this filters to `status = 'confirmed'`. Empty for a label with no confirmed alias.
 */
export async function getConfirmedAliasNames(labelId: string): Promise<string[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [labelId],
    sql: `select alias from label_aliases
          where label_id = ? and status = 'confirmed'
          order by alias collate nocase asc`,
  });

  return typedRows<{ alias: string }>(result.rows).map((row) => row.alias);
}

/**
 * Every OPEN alias candidate (`status = 'candidate'`), joined to its canonical label, newest
 * first — the `/admin/labels` review section's read. Bounded by the alias table, which the
 * derivation keeps small (one row per corroborated/hinted spelling, `on conflict do nothing`).
 */
export async function listLabelAliasCandidates(): Promise<LabelAliasCandidate[]> {
  const db = await getDb();
  const result = await db.execute(
    `select la.id, la.alias, la.alias_slug, la.source, la.kind, la.created_at,
            labels.id as label_id, labels.name as label_name, labels.slug as label_slug
     from label_aliases la
     join labels on labels.id = la.label_id
     where la.status = 'candidate'
     order by la.created_at desc, la.alias collate nocase asc`,
  );

  return typedRows<{
    alias: string;
    alias_slug: string;
    created_at: string;
    id: string;
    kind: LabelAliasCandidate["kind"];
    label_id: string;
    label_name: string;
    label_slug: string;
    source: LabelAliasCandidate["source"];
  }>(result.rows).map((row) => ({
    alias: row.alias,
    aliasSlug: row.alias_slug,
    createdAt: row.created_at,
    id: row.id,
    kind: row.kind,
    labelId: row.label_id,
    labelName: row.label_name,
    labelSlug: row.label_slug,
    source: row.source,
  }));
}

/**
 * The operator's CONFIRM: rule a candidate the same label (`status → confirmed`). Only then does
 * it fold into resolution and the public `alternateName`. Idempotent — confirming an already-
 * confirmed or absent alias is a harmless no-op (the `/admin` board is a live surface; a double
 * tap or a stale row must never throw). Returns whether a row moved.
 */
export async function confirmLabelAlias(id: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({
    args: [id],
    sql: `update label_aliases set status = 'confirmed' where id = ? and status <> 'confirmed'`,
  });

  return result.rowsAffected > 0;
}

/**
 * The operator's REJECT: rule a candidate NOT the same label, and delete the row. It never
 * touched `tracks.label` or `labels.name`, so there is nothing to unwind. Idempotent — rejecting
 * an absent alias is a no-op. Returns whether a row was removed.
 */
export async function rejectLabelAlias(id: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({
    args: [id],
    sql: `delete from label_aliases where id = ?`,
  });

  return result.rowsAffected > 0;
}
