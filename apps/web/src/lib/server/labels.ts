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
  type MergeLabelResult,
} from "@fluncle/contracts";
import { labelFold, slugify } from "@fluncle/contracts/util/galaxy-slug";
import { bestAlbumCoverUrl, labelLogoUrl } from "../media";
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

/** A parent or sublabel edge — the name + slug the graph JSON-LD + the visible line read. */
export type LabelLineageEdge = { name: string; slug: string };

/** The canonical label identity record the public page + JSON-LD read. */
export type LabelRecord = {
  /**
   * The label's voiced public bio (the entity sibling of a finding's `note`), or undefined
   * when none is authored yet. Optional so the callers that mint a bare `LabelRecord`
   * (e.g. `getLabelForAlbum`) need not carry it; the surfacing PR reads it off
   * `getLabelBySlug`. See lib/server/bio.ts.
   */
  bio?: string;
  /**
   * The Discogs label id (`labels.discogs_label_id`), or undefined — the off-site identity anchor
   * the public Organization JSON-LD emits into `sameAs` (`discogs.com/label/<id>`).
   */
  discogsLabelId: number | undefined;
  /**
   * The label's founding place (`labels.founded_location`, MusicBrainz `area.name`), or undefined.
   * Emitted as the Organization's `location` Place + the visible "Founded … · <place>" line.
   * Optional — only `getLabelBySlug` carries lineage; a bare edge (`getLabelForAlbum`) omits it.
   */
  foundedLocation?: string;
  /**
   * The label's founding date (`labels.founding_date`, MusicBrainz `life-span.begin` verbatim — a
   * year or a full date), or undefined. Emitted as the Organization's `foundingDate` + the visible
   * "Founded <date> …" line.
   */
  foundingDate?: string;
  id: string;
  /**
   * The label's OWN logo (its resolved Discogs/Wikidata image on R2), or undefined when it has
   * none yet — the caller then falls back to the freshest finding's cover. See label-images.ts.
   */
  logoImageUrl: string | undefined;
  /**
   * The MusicBrainz label MBID (`labels.mb_label_id`), or undefined — the off-site identity anchor
   * the public Organization JSON-LD emits into `sameAs` (`musicbrainz.org/label/<mbid>`).
   */
  mbLabelId: string | undefined;
  name: string;
  /**
   * The label this one is a SUBLABEL / imprint of (`labels.parent_label_id`), resolved to its
   * name + slug, or undefined. Emitted as the Organization's `parentOrganization` `@id` edge.
   */
  parentLabel?: LabelLineageEdge;
  slug: string;
  /**
   * The labels that are sublabels / imprints OF this one (the `parent_label_id` reverse read),
   * name + slug each — the Organization's `subOrganization` `@id` edges. Empty/undefined for a
   * label with no children (or a bare edge record).
   */
  subLabels?: LabelLineageEdge[];
};

/**
 * A row in the `/labels` editorial index — exactly the four fields the tile renders and nothing
 * more. The catalogue count and the freshest-finding `lastmod` used to ride along "for the
 * sitemap"; the sitemap has driven off `listLabelSitemapRows` for a while now, so both were dead
 * weight — and the catalogue count in particular was a CATALOGUE-SCALE correlated subquery
 * running once per editorial row on every `/labels` render.
 */
export type LabelIndexEntry = {
  /**
   * The label's cover — the freshest finding's album art, preferring that album's OWNED master
   * through the Cloudflare Images ladder (the fallback for the logo).
   */
  coverImageUrl: string | undefined;
  findingCount: number;
  /** The label's OWN logo (its resolved Discogs/Wikidata image on R2), or undefined. */
  logoImageUrl: string | undefined;
  name: string;
  slug: string;
};

// The most sublabels a `/label/<slug>` page's `subOrganization` edges will ever carry. Real imprint
// families are a handful; the cap defends the page + JSON-LD against a pathological crawl folding
// hundreds of children onto one parent. An indexed seek on `labels_parent_label_id_idx`, never a scan.
const LABEL_SUBLABELS_LIMIT = 50;

/**
 * The lineage EDGES for one label — its parent (the imprint it belongs to) resolved to name + slug,
 * and the sublabels that point back at it. Two indexed seeks (`labels` PK for the parent,
 * `labels_parent_label_id_idx` for the children), bounded by {@link LABEL_SUBLABELS_LIMIT}. Called
 * only by the page read, so it is one extra round trip on a single-label render, never a catalogue scan.
 */
async function getLabelLineageEdges(
  labelId: string,
  parentLabelId: string | null,
): Promise<{ parentLabel?: LabelLineageEdge; subLabels: LabelLineageEdge[] }> {
  const db = await getDb();

  const parentResult = parentLabelId
    ? await db.execute({
        args: [parentLabelId],
        sql: `select name, slug from labels where id = ? limit 1`,
      })
    : undefined;
  const parentRow = parentResult
    ? typedRows<{ name: string; slug: string }>(parentResult.rows)[0]
    : undefined;

  const childrenResult = await db.execute({
    args: [labelId, LABEL_SUBLABELS_LIMIT],
    sql: `select name, slug from labels where parent_label_id = ? order by name collate nocase asc limit ?`,
  });

  return {
    parentLabel: parentRow ? { name: parentRow.name, slug: parentRow.slug } : undefined,
    subLabels: typedRows<{ name: string; slug: string }>(childrenResult.rows).map((child) => ({
      name: child.name,
      slug: child.slug,
    })),
  };
}

/** Resolve one label by its public slug (undefined = no such label). */
export async function getLabelBySlug(slug: string): Promise<LabelRecord | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [slug],
    sql: `select ${LABEL_COLUMNS}, bio, mb_label_id, discogs_label_id,
                 founding_date, founded_location, parent_label_id
          from labels where slug = ? limit 1`,
  });

  const row = typedRows<
    LabelRow & {
      bio: string | null;
      discogs_label_id: number | null;
      founded_location: string | null;
      founding_date: string | null;
      mb_label_id: string | null;
      parent_label_id: string | null;
    }
  >(result.rows)[0];

  if (!row) {
    return undefined;
  }

  const lineage = await getLabelLineageEdges(row.id, row.parent_label_id);

  return {
    bio: typeof row.bio === "string" && row.bio.trim() ? row.bio : undefined,
    discogsLabelId: typeof row.discogs_label_id === "number" ? row.discogs_label_id : undefined,
    foundedLocation:
      typeof row.founded_location === "string" && row.founded_location.trim()
        ? row.founded_location
        : undefined,
    foundingDate:
      typeof row.founding_date === "string" && row.founding_date.trim()
        ? row.founding_date
        : undefined,
    id: row.id,
    logoImageUrl: labelLogoUrl(row.image_key),
    mbLabelId: typeof row.mb_label_id === "string" && row.mb_label_id ? row.mb_label_id : undefined,
    name: row.name,
    parentLabel: lineage.parentLabel,
    slug: row.slug,
    subLabels: lineage.subLabels,
  };
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

  // The album → label edge closes the graph in JSON-LD (recordLabel) — a name/slug pointer, never
  // the label's own identity anchors or image — so the logo and the MB/Discogs ids are left
  // undefined here (they belong to the label PAGE's Organization node, not this edge).
  return row
    ? {
        discogsLabelId: undefined,
        id: row.id,
        logoImageUrl: undefined,
        mbLabelId: undefined,
        name: row.name,
        slug: row.slug,
      }
    : undefined;
}

// ── THE EDITORIAL HALF OF A HUB (the findings-bounded top section) ────────────────────────────
//
// `/albums`, `/labels`, and `/artists` each open with Fluncle's own list — the entities he has
// pulled a banger off — above the crawler's quieter long tail. That list is bounded by the
// ARCHIVE rather than the catalogue, so it grows a row a day rather than a row a crawl. It still
// grows without limit, though, and it used to SSR whole: ~80–120 tiles of markup, each carrying a
// per-row correlated subquery, on every render of every page. So it is now WINDOWED on the same
// 48-tile page the catalogue half uses, behind the SAME `?page=N` param — one pager for the whole
// hub, no second interaction to learn: page N is slice N of both sections, and once the editorial
// list runs out the deeper pages are pure long tail.
//
// The total is a SECOND, deliberately separate statement: `count(*) over ()` would report zero on
// a page past the editorial list's end (the header's "N logged" and the pager's reach both need
// the honest figure). It is a bare grouped count over the findings join — archive-bounded, no
// correlated subqueries — so it costs a fraction of the slice it accompanies.

/** One windowed page of a hub's editorial (findings-bounded) section. */
export type EditorialHubPage<Entry> = {
  items: Entry[];
  page: number;
  pageCount: number;
  /** Every entity in the editorial list, counted in SQL — the header's figure and the pager's key. */
  total: number;
};

/** The `limit ? offset ?` args for one editorial page (the shared 48-tile window). */
export function editorialArgs(page: number): number[] {
  return [CATALOGUE_HUB_DEFAULT_LIMIT, (Math.max(page, 1) - 1) * CATALOGUE_HUB_DEFAULT_LIMIT];
}

/** Count an editorial set from its grouped row source (`select 1 … group by …`), in SQL. */
export async function countEditorial(groupedRows: string): Promise<number> {
  const db = await getDb();
  const result = await db.execute(`select count(*) as total from (${groupedRows})`);

  return Number(typedRows<{ total: number }>(result.rows)[0]?.total ?? 0);
}

/** Assemble the editorial page envelope; page 1 of an empty list is a real (empty) page. */
export function editorialPage<Entry>(
  items: Entry[],
  page: number,
  total: number,
): EditorialHubPage<Entry> {
  return {
    items,
    page,
    pageCount: Math.max(Math.ceil(total / CATALOGUE_HUB_DEFAULT_LIMIT), 1),
    total,
  };
}

/**
 * The cover columns of ONE representative track, packed into a single correlated subquery.
 *
 * A cover now has two possible sources — the album's OWNED ≤1200² master on Fluncle's R2 (served
 * through the Cloudflare Images ladder) and the raw provider URL the track was captured with — and
 * `bestAlbumCoverUrl` needs FOUR columns to choose between them. Four separate correlated
 * subqueries could each land on a different track, pairing one record's master with another's
 * fallback; `json_object` keeps them on one picked row by construction, at one subquery's cost.
 *
 * `from`, `where`, and `order` are CONSTANT fragments from the call sites in this file (never
 * reader input). The album join is `left`, so a track with no album entity still yields its raw
 * cover.
 */
function coverJsonSelect(from: string, where: string, order: string): string {
  return `(select json_object('u', t2.album_image_url, 'k', a2.image_key,
                              's', a2.image_state, 'v', a2.image_updated_at)
             from ${from}
             left join albums a2 on a2.id = t2.album_id
            where ${where}
            order by ${order}
            limit 1)`;
}

/** Any track on the entity, freshest release first — the CATALOGUE tile's cover. */
const CATALOGUE_COVER_ORDER = `t2.release_date is null asc, t2.release_date desc, t2.track_id asc`;

/** The freshest CERTIFIED finding on a label — the editorial `/labels` tile's cover. */
const LABEL_FINDING_COVER_JSON = coverJsonSelect(
  `findings f2 join tracks t2 on t2.track_id = f2.track_id`,
  `t2.label_id = labels.id and f2.log_id is not null`,
  `f2.added_at desc`,
);

/** Any track on a label — the catalogue `/labels` tile's cover. */
const LABEL_CATALOGUE_COVER_JSON = coverJsonSelect(
  `tracks t2`,
  `t2.label_id = labels.id and t2.album_image_url is not null`,
  CATALOGUE_COVER_ORDER,
);

// An ALBUM needs no packed subquery: it OWNS its master columns (`albums.image_key` and friends
// sit on the row the hub already selects), so albums.ts pairs them with a plain `album_image_url`
// subquery and calls `bestAlbumCoverUrl` directly. Only labels — whose cover is borrowed from
// whichever record a track happens to sit on — need the four columns kept on one picked row.

/** The four cover columns `coverJsonSelect` packs, as they come back off the wire. */
type CoverJson = {
  k?: null | string;
  s?: null | string;
  u?: null | string;
  v?: null | string;
};

/** Resolve a `coverJsonSelect` column to the best cover URL — the owned master when resolved. */
export function coverFromJson(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw === "") {
    return undefined;
  }

  let parsed: CoverJson;

  try {
    parsed = JSON.parse(raw) as CoverJson;
  } catch {
    return undefined;
  }

  return bestAlbumCoverUrl({
    imageKey: parsed.k,
    imageState: parsed.s,
    imageUpdatedAt: parsed.v,
    spotifyUrl: parsed.u,
  });
}

/**
 * One windowed page of every label with at least one coordinate-bearing finding, with its finding
 * count and its cover (the freshest finding's album art, preferring that album's owned master).
 * Alphabetical by name — the `/labels` index order.
 *
 * The PUBLIC index read, and it is deliberately blind to `seed_state`: a skipped label's
 * findings render exactly as they always did (crawl scope, never storage — the rule at the
 * top of this file). It drives from the findings join, so it is bounded by the archive
 * rather than by the catalogue. The sitemap is a separate read (`listLabelSitemapRows`).
 */
/**
 * Just the NAMES of the labels Fluncle has pulled a banger off — the typeahead pool for the
 * `/tracks` filter's label combobox. The same findings-bounded set `listLabelsWithFindingCounts`
 * returns (a label he never certified on is rightly absent), and the same alphabetical order, but
 * without the per-group cover/date subqueries that read carries — strictly a lighter pass over the
 * SAME already-shipping join, so it inherits its proven shape while staying archive-bounded (~the
 * label count, not the catalogue). The control still compiles a free-typed string that matches no
 * known name, so this is a suggestion pool, never a closed set.
 */
export async function listKnownLabelNames(): Promise<string[]> {
  const db = await getDb();
  const result = await db.execute({
    // `trim(labels.name) <> ''` drops a blank/whitespace-only (or null) name at the source, so the
    // filter combobox never offers an empty "Any label"-looking row. `trim(null)` is null and
    // `null <> ''` is not true, so a null name falls out the same way.
    sql: `select labels.name as name
          from labels
          join tracks on tracks.label_id = labels.id
          join findings on findings.track_id = tracks.track_id
          where findings.log_id is not null
            and trim(labels.name) <> ''
          group by labels.id
          order by labels.name collate nocase asc`,
  });

  return typedRows<{ name: string }>(result.rows).map((row) => row.name);
}

export async function listLabelsWithFindingCounts(
  page: number,
): Promise<EditorialHubPage<LabelIndexEntry>> {
  const db = await getDb();
  const [slice, total] = await Promise.all([
    db.execute({
      args: editorialArgs(page),
      sql: `select labels.name as name, labels.slug as slug, labels.image_key as image_key,
                   count(*) as finding_count,
                   ${LABEL_FINDING_COVER_JSON} as cover_json
            from labels
            join tracks on tracks.label_id = labels.id
            join findings on findings.track_id = tracks.track_id
            where findings.log_id is not null
            group by labels.id
            order by labels.name collate nocase asc
            limit ? offset ?`,
    }),
    countEditorial(`select 1
                    from labels
                    join tracks on tracks.label_id = labels.id
                    join findings on findings.track_id = tracks.track_id
                    where findings.log_id is not null
                    group by labels.id`),
  ]);

  const items = typedRows<{
    cover_json: string | null;
    finding_count: number;
    image_key: string | null;
    name: string;
    slug: string;
  }>(slice.rows).map((row) => ({
    coverImageUrl: coverFromJson(row.cover_json),
    findingCount: Number(row.finding_count),
    logoImageUrl: labelLogoUrl(row.image_key),
    name: row.name,
    slug: row.slug,
  }));

  return editorialPage(items, page, total);
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

// ── "ALSO IN THE CATALOGUE": the hub's findings-free second section ─────────────────────────
//
// The three hubs (`/labels`, `/albums`, `/artists`) lead with Fluncle's editorial list (the
// findings-joined reads above) and carry a SECOND section below it: the INDEXABLE findings-free
// entities — the ones the crawler minted a page for on crawled content alone. It is the hub-shaped
// twin of the SITEMAP read: same grouped scan, same renderable-track floor in SQL, but keyed to
// exactly the entities the editorial section leaves out (ZERO certified findings). ONE navigation
// model serves humans and crawlers alike — every page SSRs one OFFSET slice behind a `?page=N`
// pager (below), so every tile is reachable as a real <a> and nothing depends on running JS.

/** The hub read's page size, shared by all three "also in the catalogue" sections. */
export const CATALOGUE_HUB_DEFAULT_LIMIT = 48;

/** A label tile in the "also in the catalogue" section — the quiet, unlit twin of a hub row. */
export type LabelCatalogueEntry = {
  /** A representative cover from any of the label's tracks (finding-free labels have no finding cover). */
  coverImageUrl: string | undefined;
  /** The label's OWN logo (its resolved Discogs/Wikidata image on R2), preferred over the cover. */
  logoImageUrl: string | undefined;
  name: string;
  slug: string;
  /** Renderable tracks on the label (all catalogue here, since it carries no findings). */
  trackCount: number;
};

// ── THE ?page=N PAGED SECTION: the hub's long tail becomes internal links ─────────────────────────
//
// Every page SSRs one OFFSET slice of the findings-free set behind a `?page=N` URL so every tile is
// reachable as a real <a> — no crawlable-link gap, no dependence on running JS, and the footer stays
// reachable at every catalogue size. One operation, three tables — the generic below takes the
// entity-specific SQL FRAGMENTS as constants (never reader input; every value is bound), exactly as
// `catalogue-groups.ts`'s `fetchGroupTracks` does, so the labels/albums/artists reads cannot drift
// apart.
//
// ── SCALE ──────────────────────────────────────────────────────────────────────────────────────
// This composes two shapes already proven against hosted Turso: the sitemap read's grouped
// having-scan (the findings-free, floor-gated set, above) and catalogue-groups.ts's
// `count(*) over ()` + `limit ? offset ?` window (the entity graph pages, hosted-proven by
// catalogue-scale.integration.test.ts). The window count runs AFTER `having`, so `total` is the
// findings-free floor-clearing count; each page's `offset` walks one bounded slice of that grouped
// scan — the tradeoff a numbered pager requires, and never a whole-table rank in the isolate.

/** The `certified` / `renderable` aggregates, shared by every hub read so the gate has one home. */
const HUB_CERTIFIED = `sum(case when findings.log_id is not null then 1 else 0 end)`;
const HUB_RENDERABLE = `${HUB_CERTIFIED} + sum(case when findings.track_id is null then 1 else 0 end)`;

/** A raw hub TILE row — the union of every tile column the three entity kinds select. */
type CatalogueHubRow = {
  cover_json?: string | null;
  cover_url?: string | null;
  image_key?: string | null;
  image_state?: string | null;
  image_updated_at?: string | null;
  image_url?: string | null;
  name: string;
  slug: string;
  track_count: number;
};

/**
 * The entity-specific SQL for ONE hub, as CONSTANT fragments (never reader input).
 *
 * `from` is the entity table joined to `tracks` — the shape the GATED SCAN walks; the generic
 * appends the shared `left join findings`, the `group by`, the floor `having`, and the slug order.
 * `entity` is the bare entity table (with its alias, if any) the TILE LOOKUP reads: the gated scan
 * yields slugs, and the tile columns are then fetched for those ≤48 slugs alone. `select` adds
 * those tile columns, `mapRow` reads them.
 */
export type CatalogueHubQuery<Entry> = {
  entity: string;
  floor: number;
  from: string;
  groupBy: string;
  mapRow: (row: CatalogueHubRow) => Entry;
  select: string;
  slugExpr: string;
};

/** One NUMBERED page of a hub's findings-free section — the crawlable `?page=N` variant's payload. */
export type CatalogueHubNumberedPage<Entry> = {
  items: Entry[];
  /**
   * Each present first letter → the page its first entity lands on (the A–Z fast lane). Absent
   * when the reader did not ask for a lane (`/albums` has none) or on a hub that carries its own
   * (`/tracks` has a YEAR lane instead).
   */
  letters?: CatalogueHubLetter[];
  page: number;
  pageCount: number;
  /** Every findings-free, floor-clearing entity the hub carries, counted in SQL — the pager's key. */
  total: number;
};

/** A present first letter of a name-sorted hub, mapped to the page its first entity lands on. */
export type CatalogueHubLetter = { letter: string; page: number };

/**
 * A page past the end of a pager does not exist, and says so — the twin of
 * `CataloguePageOutOfRangeError` (catalogue-groups.ts), same semantics: a `?page=99` on a 3-page hub
 * is NOT clamped to page 1 (that would be a second URL for page 1's tiles, an infinite supply of
 * them for a crawler), it throws so the route can 404. Kept a hub-local class to keep labels.ts free
 * of a catalogue-groups import (which would close an artists→labels→catalogue-groups cycle).
 *
 * The three ENTITY hubs no longer raise it — they each carry an editorial section too, so only the
 * ROUTE can tell whether a page is past the end of everything. `/tracks` (one section, one read)
 * still does.
 */
export class CatalogueHubPageOutOfRangeError extends Error {}

/**
 * One OFFSET page of a hub's findings-free section, plus its total and (optionally) its A–Z lane —
 * from ONE pass over the gated set.
 *
 * ── WHY ONE PASS ────────────────────────────────────────────────────────────────────────────────
 * `/artists` and `/labels` used to run this read AND a separate letter-lane read on every render:
 * two catalogue-scale grouped `having` scans per request, the second one purely to count entities
 * per initial. The gated set is now a MATERIALIZED CTE walked once and consumed by three arms of
 * one compound select — the total, the page's slice, and the per-initial counts. `materialized` is
 * load-bearing: a plain CTE is flattened and RE-EXECUTED per `union all` branch (the trap AGENTS.md
 * records), which is exactly the two-scan cost this removes.
 *
 * ── WHY THE TILES ARE A SECOND STATEMENT ────────────────────────────────────────────────────────
 * The gated scan carries only slug + renderable count. The tile columns (name, cover, owned-master
 * key) come off a plain indexed `where slug in (…)` lookup of the ≤48 slugs the page actually
 * shows, so the per-row cover subqueries run 48 times rather than once per entity in the gated set.
 *
 * A page past the end is NOT an error here: it returns an empty slice with the honest `total` and
 * `pageCount`, and the ROUTE decides the 404 — it also carries an editorial section, which may
 * still have rows on a page the catalogue half has run out on. Nothing is ever clamped to page 1.
 *
 * The fragments are constants from the callers; only the floor, page size, and offset are bound.
 */
export async function listCatalogueHubPage<Entry>(
  query: CatalogueHubQuery<Entry>,
  page: number,
  withLetters = false,
): Promise<CatalogueHubNumberedPage<Entry>> {
  const db = await getDb();
  const limit = CATALOGUE_HUB_DEFAULT_LIMIT;
  // Arm 1 is the total (always exactly one row, so an empty page still reports an honest size);
  // arm 2 is the page's slice; arm 3 is the A–Z lane's per-initial counts. `kind` discriminates,
  // and `slug`/`n` carry the letter arm's payload — one column shape across all three arms.
  const letterArm = withLetters
    ? `union all
       select 'letter' as kind, substr(g.slug, 1, 1) as slug, count(*) as n
       from gated g group by substr(g.slug, 1, 1)`
    : "";

  const result = await db.execute({
    args: [query.floor, limit, (page - 1) * limit],
    sql: `with gated as materialized (
            select ${query.slugExpr} as slug, ${HUB_RENDERABLE} as track_count
            from ${query.from}
            left join findings on findings.track_id = tracks.track_id
            group by ${query.groupBy}
            having ${HUB_CERTIFIED} = 0 and ${HUB_RENDERABLE} >= ?
          )
          select 'total' as kind, '' as slug, (select count(*) from gated) as n
          union all
          select * from (
            select 'row' as kind, g.slug as slug, g.track_count as n
            from gated g order by g.slug asc limit ? offset ?
          )
          ${letterArm}`,
  });

  const rows = typedRows<{ kind: string; n: number; slug: string }>(result.rows);
  const total = Number(rows.find((row) => row.kind === "total")?.n ?? 0);
  // A compound select gives no cross-arm order guarantee, so the arms are split and re-sorted
  // here — over 48 slugs and ~27 letters, never a growing set.
  const sliced = rows
    .filter((row) => row.kind === "row")
    .sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0));
  const letters = letterPages(
    rows
      .filter((row) => row.kind === "letter")
      .map((row) => ({ letter: row.slug, n: Number(row.n) }))
      .sort((left, right) => (left.letter < right.letter ? -1 : 1)),
    limit,
  );

  return {
    items: await hubTiles(query, sliced),
    letters,
    page,
    pageCount: Math.max(Math.ceil(total / limit), 1),
    total,
  };
}

/**
 * The tile columns for one page's slugs — a bounded, index-driven `where slug in (…)` over the
 * entity table alone. Returns them in the slice's slug order (the lookup's own order is not
 * guaranteed), each carrying its renderable count off the gated scan.
 */
async function hubTiles<Entry>(
  query: CatalogueHubQuery<Entry>,
  slice: { n: number; slug: string }[],
): Promise<Entry[]> {
  if (slice.length === 0) {
    return [];
  }

  const db = await getDb();
  const slugs = slice.map((row) => row.slug);
  const result = await db.execute({
    args: slugs,
    sql: `select ${query.slugExpr} as slug, ${query.select}
          from ${query.entity}
          where ${query.slugExpr} in (${slugs.map(() => "?").join(", ")})`,
  });

  const bySlug = new Map(typedRows<CatalogueHubRow>(result.rows).map((row) => [row.slug, row]));

  return slice.flatMap((row) => {
    const tile = bySlug.get(row.slug);

    return tile ? [query.mapRow({ ...tile, track_count: Number(row.n) })] : [];
  });
}

/**
 * Fold per-first-char counts (slug-ordered) into one page number per DISPLAY letter. Pure, so
 * `labels.test.ts` pins it. Slugs are lowercase alphanumerics: an a–z lead keeps its letter, any
 * other lead (a digit) folds into "#". The FIRST (smallest-rank) occurrence of a display letter wins
 * its page — digits sort before letters, so "#" is contiguous at the front.
 */
export function letterPages(
  counts: { letter: string; n: number }[],
  pageSize: number,
): CatalogueHubLetter[] {
  const byLetter = new Map<string, number>();
  let rank = 0;

  for (const { letter, n } of counts) {
    const display = /^[a-z]$/.test(letter) ? letter : "#";

    if (!byLetter.has(display)) {
      byLetter.set(display, Math.floor(rank / pageSize) + 1);
    }

    rank += Number(n);
  }

  return [...byLetter].map(([letter, page]) => ({ letter, page }));
}

/** The LABELS hub's `?page=N` + A–Z reads, over the findings-free, floor-gated set of labels. */
const LABELS_HUB_QUERY: CatalogueHubQuery<LabelCatalogueEntry> = {
  entity: "labels",
  floor: LABEL_INDEX_MIN_TRACKS,
  from: "labels join tracks on tracks.label_id = labels.id",
  groupBy: "labels.id",
  mapRow: (row) => ({
    coverImageUrl: coverFromJson(row.cover_json),
    logoImageUrl: labelLogoUrl(row.image_key ?? null),
    name: row.name,
    slug: row.slug,
    trackCount: Number(row.track_count),
  }),
  select: `labels.name as name, labels.image_key as image_key,
           ${LABEL_CATALOGUE_COVER_JSON} as cover_json`,
  slugExpr: "labels.slug",
};

/**
 * One numbered page of the `/labels` hub's findings-free section (the crawlable `?page=N` view),
 * carrying the A–Z fast lane: each present letter → the page its first label lands on.
 */
export function listLabelsCataloguePage(
  page: number,
): Promise<CatalogueHubNumberedPage<LabelCatalogueEntry>> {
  return listCatalogueHubPage(LABELS_HUB_QUERY, page, true);
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
 * The bio worklist: bio-empty labels whose page is INDEXABLE, oldest-first — the worklist the
 * `describe_label` cron drains. A bare read (no writes), bounded by `limit`. Two ways in, matching
 * exactly the two ways a `/label/<slug>` page renders:
 *
 * - a CERTIFIED label (at least one coordinate-bearing finding) — the original floor, preserved
 *   verbatim, so a certified-but-thin label never regresses out of the queue; OR
 * - a findings-free CATALOGUE label whose page clears the thin-content floor
 *   ({@link LABEL_INDEX_MIN_TRACKS}) on renderable tracks alone — a crawl-minted page that is
 *   indexable earns a bio too, so it stops showing a bare tracklist with no dossier.
 *
 * The renderable count mirrors `listLabelSitemapRows` exactly: over the `tracks.label_id` join, a
 * track counts when its finding is coordinate-bearing (`log_id is not null`) OR when there is no
 * finding row (the anti-join's `track_id is null` complement). Bounding the findings-free arm to the
 * indexable floor caps the Firecrawl + `claude -p` cost — a wide crawl mints thousands of stub
 * labels, and only the ones with a real page should ever enter the sweep.
 */
export async function listLabelsMissingBio(limit: number): Promise<LabelBioWorkItem[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [LABEL_INDEX_MIN_TRACKS, limit],
    sql: `select l.id, l.name, l.slug
          from labels l
          where (l.bio is null or trim(l.bio) = '')
            and (
              exists (
                select 1 from tracks t
                join findings f on f.track_id = t.track_id
                where t.label_id = l.id and f.log_id is not null
              )
              or (
                select count(*)
                from tracks t2
                left join findings f2 on f2.track_id = t2.track_id
                where t2.label_id = l.id
                  and (f2.log_id is not null or f2.track_id is null)
              ) >= ?
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

/**
 * The confirmed-alias REDIRECT lookup: does this slug resolve to a canonical label through a
 * confirmed alias (the spelling of a label the operator merged away)? Returns the owning label's
 * slug, or undefined. The `/label/<slug>` loader uses it to 301 a merged-away slug to its canonical
 * page. One indexed read on `label_aliases_alias_slug_idx`, joined to `labels` for the target slug.
 */
export async function resolveLabelAliasRedirect(slug: string): Promise<string | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [slug],
    sql: `select labels.slug as slug
          from label_aliases
          join labels on labels.id = label_aliases.label_id
          where label_aliases.alias_slug = ? and label_aliases.status = 'confirmed'
          limit 1`,
  });

  return typedRows<{ slug: string }>(result.rows)[0]?.slug;
}

// ── LABEL MERGE: fold a slug-split twin into its canonical row (RFC musickit-second-authority U2b) ──
// The cleanup for a PRE-EXISTING split — two `labels` rows that mean one label (the Med School /
// Medschool class U2a stopped going FORWARD). The operator merges the LOSING row into the CANONICAL
// one, in ONE transaction: re-point every FK that references the loser, reconcile the loser's
// identity + facts onto the canonical CANONICAL-WINS, land the losing NAME as a confirmed alias
// (so the immutable `tracks.label` free-text can never re-mint the merged-away slug), and delete the
// loser. See docs/label-entity.md § merge.

/** Thrown when both rows carry an operator ruling and their seed states disagree — stop and ask. */
export class LabelMergeConflictError extends Error {}

/** Thrown when the two merge slugs resolve to the same row (nothing to merge). */
export class LabelMergeSameRowError extends Error {}

/** Every column the merge reads off a label row to re-point, reconcile, and resolve the ruling. */
type LabelMergeRow = {
  discogs_label_id: null | number;
  founded_location: null | string;
  founding_date: null | string;
  id: string;
  image_key: null | string;
  image_state: "none" | "pending" | "resolved";
  lineage_state: "none" | "pending" | "resolved";
  mb_label_id: null | string;
  name: string;
  parent_label_id: null | string;
  ruled_at: null | string;
  seed_state: LabelSeedState;
  slug: string;
};

async function getLabelMergeRow(slug: string): Promise<LabelMergeRow | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [slug],
    sql: `select id, slug, name, seed_state, ruled_at, mb_label_id, discogs_label_id,
                 image_key, image_state, founding_date, founded_location, parent_label_id, lineage_state
          from labels where slug = ? limit 1`,
  });

  return typedRows<LabelMergeRow>(result.rows)[0];
}

/**
 * Merge the LOSING label (`losingSlug`) into the CANONICAL one (`canonicalSlug`) atomically.
 *
 * ── WHAT IT DOES ────────────────────────────────────────────────────────────────
 * 1. RE-POINTS every FK that references the loser: `tracks.label_id`, the loser's SUBLABELS'
 *    `labels.parent_label_id`, and `label_aliases.label_id`. (`albums` carries no label FK — its
 *    label edge is derived at read time from the raw string, docs/album-entity.md.)
 * 2. RECONCILES the loser's identity + facts onto the canonical CANONICAL-WINS: for `mb_label_id`,
 *    `discogs_label_id`, `image_key`, `founding_date`, `founded_location`, `parent_label_id`, and
 *    `lineage_state`, the canonical's existing value ALWAYS stands and the loser's fills only an
 *    EMPTY canonical slot (coalesce). This is load-bearing: a loser whose MBID mis-resolved to the
 *    wrong label (the 2026-07-18 "Polydor Records" → J-Pop division miss) must never overwrite the
 *    canonical's correct identity.
 * 3. RESOLVES `seed_state` by `ruled_at` precedence (the more recent operator ruling wins). When
 *    BOTH rows carry a non-null `ruled_at` AND their seed states disagree it throws
 *    {@link LabelMergeConflictError} — it never silently picks a side.
 * 4. Writes the losing NAME to `label_aliases` as `confirmed` (source `operator`), so a later
 *    `ensureLabel`/`reconcileLabels` over the immutable `tracks.label` resolves the merged-away
 *    slug to the canonical instead of re-minting it.
 * 5. DELETES the losing row (the alias carries the memory; the losing slug then 301s via
 *    {@link resolveLabelAliasRedirect}).
 *
 * ── ATOMICITY ───────────────────────────────────────────────────────────────────
 * All of it runs in one `db.batch(_, "write")` (libSQL's one-implicit-transaction batch, the
 * `updateGalaxyMap` precedent), so a crash can never half-apply a merge. The loser row is DELETED
 * first so its unique `slug`/`mb_label_id` are free before the canonical adopts them; the FK
 * re-points match the loser's id VALUE (a plain string column, no cascade), so they still land.
 */
export async function mergeLabel(
  losingSlug: string,
  canonicalSlug: string,
): Promise<MergeLabelResult> {
  const db = await getDb();

  const [loser, canonical] = await Promise.all([
    getLabelMergeRow(losingSlug),
    getLabelMergeRow(canonicalSlug),
  ]);

  if (!loser) {
    throw new LabelNotFoundError(`No label with slug ${losingSlug}.`);
  }

  if (!canonical) {
    throw new LabelNotFoundError(`No label with slug ${canonicalSlug}.`);
  }

  if (loser.id === canonical.id) {
    throw new LabelMergeSameRowError(`${losingSlug} and ${canonicalSlug} are the same label.`);
  }

  // ── seed_state by ruled_at precedence; refuse an operator-vs-operator disagreement ──
  if (loser.ruled_at && canonical.ruled_at && loser.seed_state !== canonical.seed_state) {
    throw new LabelMergeConflictError(
      `Both labels carry an operator ruling and they disagree: ${canonicalSlug} is ${canonical.seed_state} (ruled ${canonical.ruled_at}) and ${losingSlug} is ${loser.seed_state} (ruled ${loser.ruled_at}). Re-rule one to match, then merge.`,
    );
  }

  let seedState = canonical.seed_state;
  let ruledAt = canonical.ruled_at;

  if (loser.ruled_at && (!canonical.ruled_at || loser.ruled_at > canonical.ruled_at)) {
    // The loser's ruling is the more recent (or the only) one — it wins.
    seedState = loser.seed_state;
    ruledAt = loser.ruled_at;
  }

  // ── identity + facts, CANONICAL-WINS (fill an EMPTY canonical slot from the loser only) ──
  const reconciled: string[] = [];
  const take = <T extends number | string>(
    field: string,
    canonValue: null | T,
    loserValue: null | T,
  ): null | T => {
    if (canonValue == null && loserValue != null) {
      reconciled.push(field);

      return loserValue;
    }

    return canonValue;
  };

  const mbLabelId = take("mbLabelId", canonical.mb_label_id, loser.mb_label_id);
  const discogsLabelId = take("discogsLabelId", canonical.discogs_label_id, loser.discogs_label_id);
  const foundingDate = take("foundingDate", canonical.founding_date, loser.founding_date);
  const foundedLocation = take(
    "foundedLocation",
    canonical.founded_location,
    loser.founded_location,
  );

  // The logo and its resolve state travel together: a stored `image_key` with a non-`resolved`
  // state would be re-walked by the image sweep, so image_state follows whichever row's key wins.
  const imageKey = take("imageKey", canonical.image_key, loser.image_key);
  const imageState =
    canonical.image_key != null
      ? canonical.image_state
      : loser.image_key != null
        ? loser.image_state
        : canonical.image_state;

  // The parent edge is canonical-wins, but must never point at the (deleted) loser or at the
  // canonical itself. A canonical whose parent WAS the loser adopts the loser's parent instead.
  const canonParent = canonical.parent_label_id === loser.id ? null : canonical.parent_label_id;
  let parentLabelId: null | string = canonParent;

  if (parentLabelId == null && loser.parent_label_id != null) {
    const loserParent = loser.parent_label_id === canonical.id ? null : loser.parent_label_id;

    if (loserParent != null) {
      parentLabelId = loserParent;
      reconciled.push("parentLabelId");
    }
  }

  // `pending` is the un-walked "empty" lineage state — adopt the loser's resolved/none when the
  // canonical has never been walked, so the coalesced founding facts are not re-walked away.
  let lineageState = canonical.lineage_state;

  if (canonical.lineage_state === "pending" && loser.lineage_state !== "pending") {
    lineageState = loser.lineage_state;
    reconciled.push("lineageState");
  }

  const now = new Date().toISOString();

  const statements: Array<{ args: Array<null | number | string>; sql: string }> = [
    // 0: DELETE the loser FIRST — frees its slug + UNIQUE mb_label_id before the canonical update
    //    can adopt them. The FK re-points below match the loser's id VALUE (a plain string column,
    //    no cascade), so they still land after the row is gone.
    { args: [loser.id], sql: `delete from labels where id = ?` },
    // 1: re-point every finding/catalogue track off the loser onto the canonical.
    { args: [canonical.id, loser.id], sql: `update tracks set label_id = ? where label_id = ?` },
    // 2: re-point the loser's SUBLABELS onto the canonical — never the canonical itself (that would
    //    make it its own parent; the canonical's own parent is set in statement 5).
    {
      args: [canonical.id, now, loser.id, canonical.id],
      sql: `update labels set parent_label_id = ?, updated_at = ? where parent_label_id = ? and id <> ?`,
    },
    // 3: re-point the loser's OWN aliases onto the canonical. `or ignore` skips a row that would
    //    collide with an alias the canonical already carries (the (label_id, alias_slug, source)
    //    unique index); statement 4 then drops those leftovers (duplicates of the canonical's).
    {
      args: [canonical.id, loser.id],
      sql: `update or ignore label_aliases set label_id = ? where label_id = ?`,
    },
    // 4: drop any loser-pointed alias that could not move (a duplicate of one the canonical holds).
    { args: [loser.id], sql: `delete from label_aliases where label_id = ?` },
    // 5: reconcile the identity + facts + the resolved seed state onto the canonical.
    {
      args: [
        mbLabelId,
        discogsLabelId,
        imageKey,
        imageState,
        foundingDate,
        foundedLocation,
        parentLabelId,
        lineageState,
        seedState,
        ruledAt,
        now,
        canonical.id,
      ],
      sql: `update labels
              set mb_label_id = ?, discogs_label_id = ?, image_key = ?, image_state = ?,
                  founding_date = ?, founded_location = ?, parent_label_id = ?, lineage_state = ?,
                  seed_state = ?, ruled_at = ?, updated_at = ?
            where id = ?`,
    },
    // 6: the losing NAME becomes a CONFIRMED alias on the canonical, so the immutable tracks.label
    //    free-text can never re-mint the merged-away slug on a later backfill. Idempotent insert.
    {
      args: [`lba_${randomUUID()}`, canonical.id, loser.name, loser.slug, now],
      sql: `insert into label_aliases (id, label_id, alias, alias_slug, source, kind, status, created_at)
            values (?, ?, ?, ?, 'operator', 'name', 'confirmed', ?)
            on conflict (label_id, alias_slug, source) do nothing`,
    },
  ];

  const results = await db.batch(statements, "write");

  return {
    aliasWritten: { alias: loser.name, aliasSlug: loser.slug },
    canonicalName: canonical.name,
    canonicalSlug: canonical.slug,
    losingName: loser.name,
    losingSlug: loser.slug,
    reconciled,
    repointed: {
      aliases: results[3]?.rowsAffected ?? 0,
      childLabels: results[2]?.rowsAffected ?? 0,
      tracks: results[1]?.rowsAffected ?? 0,
    },
    seedState,
  };
}
