import { type FetchImpl, readOptionalEnv } from "./env";
import { getDb, typedRows } from "./db";
import {
  type DueWorkStatement,
  markDueWorkSourceMaintenanceFromSelectStatements,
} from "./due-work";
import { markCrawlProjectionRepairsFromSelectStatement } from "./crawl-due-work";

export const DEMAND_WINDOW_DAYS = 30;

export const DEMAND_PAGE_LIMIT = 1000;

const SA_HOSTNAME = "fluncle.com";

const SA_TIMEOUT_MS = 20_000;

type SimpleAnalyticsPage = {
  pageviews?: number;
  value?: string;
  visitors?: number;
};

type SimpleAnalyticsResponse = { pages?: SimpleAnalyticsPage[] };

type SimpleAnalyticsReferrer = {
  pageviews?: number;
  value?: string;
  visitors?: number;
};

const SOCIAL_REFERRER_HOSTS: Record<string, string[]> = {
  bluesky: ["bsky.app", "bsky.social"],
  facebook: ["facebook.com", "fb.com", "fb.me"],
  instagram: ["instagram.com"],
  reddit: ["reddit.com", "redd.it"],
  tiktok: ["tiktok.com"],
  x: ["t.co", "twitter.com", "x.com"],
  youtube: ["youtube.com", "youtu.be"],
};

export type SocialReferralArrival = { pageviews: number; platform: string };

export type SocialReferralsResult = {
  arrivals: SocialReferralArrival[];

  configured: boolean;

  total: number;

  window: { end: string; start: string };
};

export type RecordDemandSummary = {
  configured: boolean;

  demandedArtists: number;

  demandedLabels: number;

  frontierPromoted: number;

  pagesRead: number;

  window: { end: string; start: string };

  totalPageviews: number;

  tracksScored: number;

  unknownSlugs: number;
};

export type RecordDemandOptions = {
  fetchImpl?: FetchImpl;

  now?: Date;
};

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

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

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

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

  const demandedArtistIds = [...artistDemandById.keys()];
  const demandedLabelSlugs = [...labelDemandBySlugResolved.keys()];
  const writeTime = now.toISOString();
  const sourceVersion = `demand-rewrite:${crypto.randomUUID()}`;
  const repairSelectionArms = [
    `select track_id as subject_id from tracks where demand_score is not null`,
  ];
  const repairSelectionArgs: string[] = [];

  if (demandedArtistIds.length > 0) {
    repairSelectionArms.push(
      `select track_id as subject_id from track_artists
       where artist_id in (${placeholders(demandedArtistIds.length)})`,
    );
    repairSelectionArgs.push(...demandedArtistIds);
  }

  if (demandedLabelSlugs.length > 0) {
    repairSelectionArms.push(
      `select track_id as subject_id from tracks
       where label_id in (
         select id from labels where slug in (${placeholders(demandedLabelSlugs.length)})
       )`,
    );
    repairSelectionArgs.push(...demandedLabelSlugs);
  }

  const writes: DueWorkStatement[] = [
    markCrawlProjectionRepairsFromSelectStatement(
      "label",
      {
        args: [],
        sql: `select distinct label_slug as source_id from crawl_frontier
              where demand_rank = 0 and label_slug is not null`,
      },
      { now: writeTime, sourceVersion },
    ),
    markCrawlProjectionRepairsFromSelectStatement(
      "artist",
      {
        args: [],
        sql: `select distinct external_id as source_id from crawl_frontier
              where demand_rank = 0 and kind = 'artist'`,
      },
      { now: writeTime, sourceVersion },
    ),
    ...markDueWorkSourceMaintenanceFromSelectStatements(
      "track",
      { args: repairSelectionArgs, sql: repairSelectionArms.join(" union ") },
      {
        markerVersion: sourceVersion,
        now: writeTime,
        producer: "demand-score-rewrite",
      },
    ),
    { args: [], sql: `update tracks set demand_score = null where demand_score is not null` },
    { args: [], sql: `update crawl_frontier set demand_rank = 1 where demand_rank = 0` },
  ];

  if (artistDemandById.size > 0) {
    const demandRows = [...artistDemandById.entries()];

    writes.push({
      args: demandRows.flatMap(([artistId, demand]) => [artistId, demand.pageviews]),

      sql: `with demand(artist_id, score) as
              (values ${demandRows.map(() => "(?, ?)").join(", ")})
            update tracks set demand_score = coalesce(demand_score, 0) + (
              select sum(demand.score) from track_artists
              join demand on demand.artist_id = track_artists.artist_id
              where track_artists.track_id = tracks.track_id
            ) where track_id in (
              select track_artists.track_id from track_artists
              join demand on demand.artist_id = track_artists.artist_id
            )`,
    });
  }

  if (labelDemandBySlugResolved.size > 0) {
    const demandRows = [...labelDemandBySlugResolved.entries()];
    writes.push({
      args: demandRows.flatMap(([slug, pageviews]) => [slug, pageviews]),
      sql: `with demand(label_slug, score) as
              (values ${demandRows.map(() => "(?, ?)").join(", ")})
            update tracks set demand_score = coalesce(demand_score, 0) + (
              select demand.score from labels
              join demand on demand.label_slug = labels.slug
              where labels.id = tracks.label_id
            ) where label_id in (
              select labels.id from labels join demand on demand.label_slug = labels.slug
            )`,
    });
    writes.push({
      args: demandedLabelSlugs,
      sql: `with demand(label_slug) as
              (values ${demandedLabelSlugs.map(() => "(?)").join(", ")})
            update crawl_frontier set demand_rank = 0
            where state = 'pending' and label_slug in (select label_slug from demand)`,
    });
    writes.push(
      markCrawlProjectionRepairsFromSelectStatement(
        "label",
        {
          args: demandedLabelSlugs,
          sql: `select column1 as source_id
                from (values ${demandedLabelSlugs.map(() => "(?)").join(", ")})`,
        },
        {
          now: writeTime,
          onlyIfPreviousStatementChanged: true,
          sourceVersion,
        },
      ),
    );
  }

  if (demandedArtistMbids.length > 0) {
    writes.push({
      args: demandedArtistMbids,

      sql: `with demand(artist_mbid) as
              (values ${demandedArtistMbids.map(() => "(?)").join(", ")})
            update crawl_frontier set demand_rank = 0
            where id in (
              select 'musicbrainz:artist:' || artist_mbid from demand
            ) and state = 'pending'`,
    });
    writes.push(
      markCrawlProjectionRepairsFromSelectStatement(
        "artist",
        {
          args: demandedArtistMbids,
          sql: `select column1 as source_id
                from (values ${demandedArtistMbids.map(() => "(?)").join(", ")})`,
        },
        {
          now: writeTime,
          onlyIfPreviousStatementChanged: true,
          sourceVersion,
        },
      ),
    );
  }

  await db.batch(writes, "write");

  let tracksScored = 0;

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
