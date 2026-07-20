// THE DEMAND SIGNAL — demand-driven crawl/capture priority (docs/catalogue-crawler.md § Demand).
//
// The catalogue crawler and The Ear decide WHAT the archive knows and, within the operator's
// rulings, the order it is captured in. But the order is a machine's guess about taste; it has
// no idea which of those thousands of catalogue rows a real human actually came looking for.
// This module closes that gap with the one signal the site already collects: Simple Analytics
// pageviews. A nightly tick reads which `/artist/<slug>` and `/label/<slug>` pages people
// looked at over the trailing window and REORDERS the crawl frontier and the capture queue
// toward those entities' tracks.
//
// ── THE RATIFIED CONSTRAINTS (do not deviate) ────────────────────────────────────────────────
//   · RANK-ORDER ONLY, never magnitude, never an override. Demand reorders WITHIN an existing
//     tier; it never lifts a row across the `capture_priority` ladder, and the
//     `capture_priority >= 0` veto (a ruled-out label, a duplicate) still wins — a demanded row
//     on a disabled label is never resurrected. The seed-allowlist crawl gate is untouched: a
//     demanded label that is not a seed has no pending frontier nodes, so bumping it does nothing.
//   · TWO DEDICATED COLUMNS the derived sweeps never touch — `tracks.demand_score` (the capture
//     queue's SECONDARY sort, after `capture_priority`) and `crawl_frontier.demand_rank` (the
//     frontier pick's within-hop tiebreak). `rank_catalogue` overwrites `capture_priority` every
//     tick and the crawl orders purely by `(state, hop, …)`; demand lives beside both so neither
//     clobbers it.
//   · A BOUNDED, IDEMPOTENT, DETERMINISTIC REWRITE. Each run CLEARS every previous score/rank,
//     then re-sets from the fresh SA read. Re-running with the same analytics produces the same
//     columns; the window sliding is the only thing that moves them.
//
// ── THE SHAPE (the reach / funnel-snapshot precedent) ────────────────────────────────────────
// The WORKER holds the SA key and does the fetch; the box cron is a bare nightly trigger (no new
// box secret). Unprovisioned (no `SIMPLE_ANALYTICS_API_KEY`), the op is a CLEAN NO-OP — it writes
// nothing at all, so a transient missing key never wipes the demand columns. It certifies nothing
// and writes only two derived reorder columns on `tracks`/`crawl_frontier`, so it is AGENT tier
// (the `rank_catalogue` / `record_platform_stats` precedent).

import { type FetchImpl, readOptionalEnv } from "./env";
import { getDb, typedRows } from "./db";

/** How far back the demand window looks. Sustained interest, not a single spike. */
export const DEMAND_WINDOW_DAYS = 30;

/** The SA page cap. Demand is the HEAD of the distribution; the long tail contributes nothing. */
export const DEMAND_PAGE_LIMIT = 1000;

/** The registered Simple Analytics hostname is the APEX (www 404s "View not found"). */
const SA_HOSTNAME = "fluncle.com";

/** A few seconds is plenty for one stats read; a slow SA must not hang the nightly tick. */
const SA_TIMEOUT_MS = 20_000;

/** One `pages` row from the SA `version=5&fields=pages` response. */
type SimpleAnalyticsPage = {
  pageviews?: number;
  value?: string;
  visitors?: number;
};

type SimpleAnalyticsResponse = { pages?: SimpleAnalyticsPage[] };

/** One `referrers` row from the SA `version=5&fields=referrers` response — a referring host
 *  (`value`, e.g. `t.co`, `www.tiktok.com`) with its trailing-window pageviews/visitors. */
type SimpleAnalyticsReferrer = {
  pageviews?: number;
  value?: string;
  visitors?: number;
};

/** The social platforms whose referral host we count as a social→site arrival. Keyed by a stable
 *  slug (the platform the visitor came FROM); each value is the substrings that mark that host in
 *  SA's `referrers[].value` (a hostname or short-link domain). Matched by substring so `t.co`,
 *  `www.tiktok.com`, and `l.instagram.com` all resolve. Kept small + explicit — an unknown referrer
 *  is simply not a social arrival, never a wrong one (the demand-read discipline). */
const SOCIAL_REFERRER_HOSTS: Record<string, string[]> = {
  bluesky: ["bsky.app", "bsky.social"],
  facebook: ["facebook.com", "fb.com", "fb.me"],
  instagram: ["instagram.com"],
  reddit: ["reddit.com", "redd.it"],
  tiktok: ["tiktok.com"],
  x: ["t.co", "twitter.com", "x.com"],
  youtube: ["youtube.com", "youtu.be"],
};

/** One social platform's arrivals to the site over the window (pageviews from its referral host). */
export type SocialReferralArrival = { pageviews: number; platform: string };

/** The `readSocialReferrers` outcome — the site-side half of the reach picture (who clicked THROUGH
 *  from a social post to the site), the counterpart to the post-side Postiz per-post metrics. */
export type SocialReferralsResult = {
  /** Per-platform arrivals, highest-first; only platforms with a non-zero count are present. */
  arrivals: SocialReferralArrival[];
  /** True when the SA key is set and the read ran; false = a clean no-op (unprovisioned). */
  configured: boolean;
  /** Total social→site arrivals across every known social host this window. */
  total: number;
  /** The trailing window queried, inclusive `YYYY-MM-DD` bounds. */
  window: { end: string; start: string };
};

/** The op's honest per-run summary — what the CLI prints and the /status marker carries. */
export type RecordDemandSummary = {
  /** True when `SIMPLE_ANALYTICS_API_KEY` is set and the fetch ran; false = a clean no-op. */
  configured: boolean;
  /** Distinct demanded ARTISTS resolved to an `artists` row this run. */
  demandedArtists: number;
  /** Distinct demanded LABELS resolved to a `labels` row this run. */
  demandedLabels: number;
  /** Pending frontier nodes promoted to `demand_rank = 0` (a demanded entity's crawl subtree). */
  frontierPromoted: number;
  /** SA `pages` rows read (before the artist/label path filter). */
  pagesRead: number;
  /** The trailing window queried, inclusive `YYYY-MM-DD` bounds. */
  window: { end: string; start: string };
  /** Total pageviews across the demanded (resolved) entities — the reorder's fuel, for observability. */
  totalPageviews: number;
  /** Catalogue/finding tracks that received a `demand_score` this run (distinct). */
  tracksScored: number;
  /** Artist/label slugs seen in analytics that resolve to no entity — skipped silently. */
  unknownSlugs: number;
};

export type RecordDemandOptions = {
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: FetchImpl;
  /** Injected for tests; defaults to `new Date()` — anchors the trailing window. */
  now?: Date;
};

/** `YYYY-MM-DD` in UTC — the date format the SA `start`/`end` params take. */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Pull the `<kind>`/`<slug>` out of a path IFF it is exactly `/artist/<slug>` or `/label/<slug>`.
 * Everything else — `/admin*`, `/log/*`, a nested `/artist/<slug>/…`, the homepage — returns
 * undefined and is dropped. Query string and hash are stripped first; the slug is URL-decoded.
 */
export function extractEntityPath(
  rawValue: string,
): { kind: "artist" | "label"; slug: string } | undefined {
  const path = rawValue.split(/[?#]/)[0] ?? "";
  const match = path.match(/^\/(artist|label)\/([^/]+)$/);

  if (!match) {
    return undefined;
  }

  const kind = match[1] === "artist" ? "artist" : "label";
  let slug: string;

  try {
    slug = decodeURIComponent(match[2] ?? "");
  } catch {
    slug = match[2] ?? "";
  }

  return slug ? { kind, slug } : undefined;
}

/** Sum SA pageviews per slug for each entity kind (a slug can recur across paginated rows). */
export function summarizeDemand(pages: SimpleAnalyticsPage[]): {
  artists: Map<string, number>;
  labels: Map<string, number>;
} {
  const artists = new Map<string, number>();
  const labels = new Map<string, number>();

  for (const page of pages) {
    const entity = typeof page.value === "string" ? extractEntityPath(page.value) : undefined;

    if (!entity) {
      continue;
    }

    const pageviews = typeof page.pageviews === "number" && page.pageviews > 0 ? page.pageviews : 0;

    if (pageviews === 0) {
      continue;
    }

    const bucket = entity.kind === "artist" ? artists : labels;

    bucket.set(entity.slug, (bucket.get(entity.slug) ?? 0) + pageviews);
  }

  return { artists, labels };
}

/** The SA read leg — the Worker's own fetch (the box never holds the key). */
async function fetchDemandPages(
  key: string,
  window: { end: string; start: string },
  fetchImpl: FetchImpl,
): Promise<SimpleAnalyticsPage[]> {
  const url =
    `https://simpleanalytics.com/${SA_HOSTNAME}.json` +
    `?version=5&fields=pages&start=${window.start}&end=${window.end}&limit=${DEMAND_PAGE_LIMIT}`;

  const response = await fetchImpl(url, {
    headers: { "Api-Key": key },
    signal: AbortSignal.timeout(SA_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `Simple Analytics read failed (${response.status}): ${(await response.text()).slice(0, 200)}`,
    );
  }

  const body = (await response.json()) as SimpleAnalyticsResponse;

  return Array.isArray(body.pages) ? body.pages : [];
}

/** `IN (?, ?, …)` placeholders for a bound list. */
function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/**
 * One demand tick: read Simple Analytics, resolve the looked-at artist/label slugs to entities,
 * and REWRITE `tracks.demand_score` + `crawl_frontier.demand_rank` in one atomic pass. Clears
 * every prior value first, so the write is idempotent and a de-trending entity falls back to
 * baseline. Returns the run's honest summary.
 *
 * Unprovisioned (no key) it is a clean no-op — it does NOT clear the columns, because a missing
 * key is a config gap, not a signal that demand vanished.
 */
export async function recordDemand(
  options: RecordDemandOptions = {},
): Promise<RecordDemandSummary> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  const end = isoDate(now);
  const start = isoDate(new Date(now.getTime() - DEMAND_WINDOW_DAYS * 24 * 60 * 60 * 1000));
  const window = { end, start };

  const key = await readOptionalEnv("SIMPLE_ANALYTICS_API_KEY");

  if (!key) {
    return {
      configured: false,
      demandedArtists: 0,
      demandedLabels: 0,
      frontierPromoted: 0,
      pagesRead: 0,
      totalPageviews: 0,
      tracksScored: 0,
      unknownSlugs: 0,
      window,
    };
  }

  const pages = await fetchDemandPages(key, window, fetchImpl);
  const { artists: artistDemandBySlug, labels: labelDemandBySlug } = summarizeDemand(pages);

  const db = await getDb();

  // Resolve the looked-at slugs to real entities — one indexed read per kind (the `slug` unique
  // indexes carry it). An unknown slug (a deleted entity, a stale bookmark) simply isn't returned
  // and is skipped silently.
  const artistDemandById = new Map<string, { mbid: null | string; pageviews: number }>();
  const labelDemandBySlugResolved = new Map<string, number>();
  const demandedArtistMbids: string[] = [];

  if (artistDemandBySlug.size > 0) {
    const slugs = [...artistDemandBySlug.keys()];
    const rows = typedRows<{ id: string; mbid: null | string; slug: string }>(
      (
        await db.execute({
          args: slugs,
          sql: `select id, slug, mbid from artists where slug in (${placeholders(slugs.length)})`,
        })
      ).rows,
    );

    for (const row of rows) {
      const pageviews = artistDemandBySlug.get(row.slug) ?? 0;

      artistDemandById.set(row.id, { mbid: row.mbid, pageviews });

      if (typeof row.mbid === "string" && row.mbid) {
        demandedArtistMbids.push(row.mbid);
      }
    }
  }

  if (labelDemandBySlug.size > 0) {
    const slugs = [...labelDemandBySlug.keys()];
    const rows = typedRows<{ slug: string }>(
      (
        await db.execute({
          args: slugs,
          sql: `select slug from labels where slug in (${placeholders(slugs.length)})`,
        })
      ).rows,
    );

    for (const row of rows) {
      labelDemandBySlugResolved.set(row.slug, labelDemandBySlug.get(row.slug) ?? 0);
    }
  }

  // ── THE REWRITE, in one transaction ──────────────────────────────────────────────────────
  // 1. Clear every prior demand value (both columns) so the write is a full, idempotent reset.
  // 2. Additive per-entity bumps — a track on TWO demanded entities (an artist + its label)
  //    accumulates BOTH, so `demand_score` is the summed pageviews of everything it hangs off.
  // 3. Promote the demanded entities' PENDING frontier nodes to `demand_rank = 0` (a label's whole
  //    seed subtree via `label_slug`; an artist node matched by MBID). `state = 'pending'` keeps
  //    the promotion off already-expanded nodes.
  const writes: { args: (null | number | string)[]; sql: string }[] = [
    { args: [], sql: `update tracks set demand_score = null where demand_score is not null` },
    { args: [], sql: `update crawl_frontier set demand_rank = 1 where demand_rank <> 1` },
  ];

  for (const [artistId, demand] of artistDemandById) {
    writes.push({
      args: [demand.pageviews, artistId],
      sql: `update tracks set demand_score = coalesce(demand_score, 0) + ?
            where track_id in (select track_id from track_artists where artist_id = ?)`,
    });
  }

  for (const [slug, pageviews] of labelDemandBySlugResolved) {
    writes.push({
      args: [pageviews, slug],
      sql: `update tracks set demand_score = coalesce(demand_score, 0) + ?
            where label_id = (select id from labels where slug = ?)`,
    });
    writes.push({
      args: [slug],
      sql: `update crawl_frontier set demand_rank = 0 where state = 'pending' and label_slug = ?`,
    });
  }

  for (const mbid of demandedArtistMbids) {
    writes.push({
      args: [mbid],
      sql: `update crawl_frontier set demand_rank = 0
            where state = 'pending' and kind = 'artist' and external_id = ?`,
    });
  }

  await db.batch(writes, "write");

  // ── The summary counts — bounded, index-driven, never a full-table scan ────────────────────
  // `tracksScored` counts DISTINCT tracks the bumps touched, driven by `track_artists_artist_id_idx`
  // + `tracks_label_id_idx` over the (small) demanded sets — not a scan of the growing `tracks`.
  let tracksScored = 0;
  const demandedArtistIds = [...artistDemandById.keys()];
  const demandedLabelSlugs = [...labelDemandBySlugResolved.keys()];

  if (demandedArtistIds.length > 0 || demandedLabelSlugs.length > 0) {
    const scoredResult = await db.execute({
      args: [...demandedArtistIds, ...demandedLabelSlugs],
      sql: `select count(*) as n from (
              select track_id from track_artists
                where ${demandedArtistIds.length > 0 ? `artist_id in (${placeholders(demandedArtistIds.length)})` : "0 = 1"}
              union
              select track_id from tracks
                where ${demandedLabelSlugs.length > 0 ? `label_id in (select id from labels where slug in (${placeholders(demandedLabelSlugs.length)}))` : "0 = 1"}
            )`,
    });

    tracksScored = Number(typedRows<{ n: number }>(scoredResult.rows)[0]?.n ?? 0);
  }

  // `state = 'pending'` is the leading edge of `crawl_frontier_pick_idx`, so this count reads the
  // pending head, not the whole frontier.
  const promotedResult = await db.execute({
    args: [],
    sql: `select count(*) as n from crawl_frontier where state = 'pending' and demand_rank = 0`,
  });
  const frontierPromoted = Number(typedRows<{ n: number }>(promotedResult.rows)[0]?.n ?? 0);

  const requestedSlugs = artistDemandBySlug.size + labelDemandBySlug.size;
  const resolvedSlugs = artistDemandById.size + labelDemandBySlugResolved.size;
  const totalPageviews =
    [...artistDemandById.values()].reduce((sum, demand) => sum + demand.pageviews, 0) +
    [...labelDemandBySlugResolved.values()].reduce((sum, pageviews) => sum + pageviews, 0);

  return {
    configured: true,
    demandedArtists: artistDemandById.size,
    demandedLabels: labelDemandBySlugResolved.size,
    frontierPromoted,
    pagesRead: pages.length,
    totalPageviews,
    tracksScored,
    unknownSlugs: requestedSlugs - resolvedSlugs,
    window,
  };
}

/** Which social platform (if any) an SA referral host belongs to — the first `SOCIAL_REFERRER_HOSTS`
 *  entry whose substrings the host contains. `undefined` for a non-social referrer (a search engine,
 *  a blog, direct). Pure. */
export function classifySocialReferrer(rawValue: string): string | undefined {
  const host = rawValue.trim().toLowerCase();

  if (!host) {
    return undefined;
  }

  for (const [platform, needles] of Object.entries(SOCIAL_REFERRER_HOSTS)) {
    if (needles.some((needle) => host.includes(needle))) {
      return platform;
    }
  }

  return undefined;
}

/** Sum SA referrer pageviews per social platform (a platform can appear under several hosts —
 *  `t.co` + `twitter.com` + `x.com` all fold into `x`). Highest-first; zero-count platforms are
 *  dropped. Pure — unit-testable with no network. */
export function summarizeReferrers(referrers: SimpleAnalyticsReferrer[]): SocialReferralArrival[] {
  const byPlatform = new Map<string, number>();

  for (const referrer of referrers) {
    const platform =
      typeof referrer.value === "string" ? classifySocialReferrer(referrer.value) : undefined;

    if (!platform) {
      continue;
    }

    const pageviews =
      typeof referrer.pageviews === "number" && referrer.pageviews > 0 ? referrer.pageviews : 0;

    if (pageviews === 0) {
      continue;
    }

    byPlatform.set(platform, (byPlatform.get(platform) ?? 0) + pageviews);
  }

  return [...byPlatform.entries()]
    .map(([platform, pageviews]) => ({ pageviews, platform }))
    .sort((a, b) => b.pageviews - a.pageviews);
}

/**
 * Read Simple Analytics REFERRERS for the trailing window and fold them into per-platform
 * social→site arrivals — the site-side half of reach (who clicked THROUGH from a social post),
 * the counterpart to the post-side Postiz per-post metrics. Same SA v5 shape + key + hostname as
 * the demand `pages` read, just `fields=referrers`. Best-effort by contract: unprovisioned (no
 * `SIMPLE_ANALYTICS_API_KEY`) it is a clean no-op (`configured: false`, empty arrivals), and it
 * never throws on a slow/failed SA read — a null arrivals block never fails the sweep that carries
 * it. Aggregate-only (SA has no per-user tracking); it stores nothing.
 */
export async function readSocialReferrers(
  options: RecordDemandOptions = {},
): Promise<SocialReferralsResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  const end = isoDate(now);
  const start = isoDate(new Date(now.getTime() - DEMAND_WINDOW_DAYS * 24 * 60 * 60 * 1000));
  const window = { end, start };

  const key = await readOptionalEnv("SIMPLE_ANALYTICS_API_KEY");

  if (!key) {
    return { arrivals: [], configured: false, total: 0, window };
  }

  const url =
    `https://simpleanalytics.com/${SA_HOSTNAME}.json` +
    `?version=5&fields=referrers&start=${window.start}&end=${window.end}&limit=${DEMAND_PAGE_LIMIT}`;

  const response = await fetchImpl(url, {
    headers: { "Api-Key": key },
    signal: AbortSignal.timeout(SA_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `Simple Analytics referrers read failed (${response.status}): ${(await response.text()).slice(0, 200)}`,
    );
  }

  const body = (await response.json()) as { referrers?: SimpleAnalyticsReferrer[] };
  const arrivals = summarizeReferrers(Array.isArray(body.referrers) ? body.referrers : []);
  const total = arrivals.reduce((sum, arrival) => sum + arrival.pageviews, 0);

  return { arrivals, configured: true, total, window };
}
