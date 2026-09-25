import { siteUrl } from "./fluncle-links";

export const SITEMAP_MAX_URLS = 45_000;

export const SITEMAP_TRACKS_MAX_URLS = 10_000;

export function sitemapMaxUrls(kind: SitemapKind): number {
  return kind === "tracks" ? SITEMAP_TRACKS_MAX_URLS : SITEMAP_MAX_URLS;
}

export const SITEMAP_SQL_WINDOWED_KINDS: readonly SitemapKind[] = [
  "tracks",
  "artists",
  "labels",
  "albums",
  "logbook",
];

export const SITEMAP_KINDS = [
  "pages",
  "findings",
  "tracks",
  "artists",
  "labels",
  "albums",
  "galaxies",
  "logbook",
  "docs",
] as const;

export type SitemapKind = (typeof SITEMAP_KINDS)[number];

export type SitemapSqlWindowedKind = "albums" | "artists" | "labels" | "logbook" | "tracks";

export type SitemapVideo = {
  contentLoc: string;

  description: string;

  thumbnailLoc: string;

  title: string;
};

export type SitemapLogPage = {
  imageLoc?: string;

  lastmod: string;
  logId: string;

  video?: SitemapVideo;
};

export type SitemapLogbookEntry = {
  lastmod?: string;

  sector: string;
};

export type SitemapArtist = {
  imageLoc?: string;

  lastmod?: string;
  slug: string;
};

export type SitemapEntity = {
  imageLoc?: string;

  lastmod?: string;
  slug: string;
};

export type SitemapTrack = {
  imageLoc?: string;
  trackId: string;
};

export type SitemapGalaxy = {
  slug: string;
};

export type SitemapDoc = {
  path: string;
};

export type SitemapRowBags = {
  albums: SitemapEntity[];
  artists: SitemapArtist[];

  docs: SitemapDoc[];
  galaxies: SitemapGalaxy[];
  labels: SitemapEntity[];
  logbook: SitemapLogbookEntry[];

  logs: SitemapLogPage[];

  tracks: SitemapTrack[];
};

export type SitemapPages = {
  galaxiesOpen: boolean;

  latest?: string;

  logbookLatest?: string;

  mixOpen: boolean;
};

export type SitemapBags = SitemapRowBags & { pages: SitemapPages };

export const EMPTY_SITEMAP_ROW_BAGS: SitemapRowBags = {
  albums: [],
  artists: [],
  docs: [],
  galaxies: [],
  labels: [],
  logbook: [],
  logs: [],
  tracks: [],
};

export const EMPTY_SITEMAP_BAGS: SitemapBags = {
  ...EMPTY_SITEMAP_ROW_BAGS,
  pages: { galaxiesOpen: false, mixOpen: false },
};

export type SitemapKindStats = {
  count: number;
  lastmod?: string;
};

export type SitemapIndexStats = Record<SitemapKind, SitemapKindStats>;

const XML_ESCAPES: Record<string, string> = {
  '"': "&quot;",
  "&": "&amp;",
  "'": "&apos;",
  "<": "&lt;",
  ">": "&gt;",
};

function xmlEscape(value: string): string {
  return value.replace(/["&'<>]/g, (char) => XML_ESCAPES[char] ?? char);
}

function lastmodTag(lastmod?: string): string {
  return lastmod ? `\n    <lastmod>${new Date(lastmod).toISOString()}</lastmod>` : "";
}

function staticEntry(loc: string, lastmod?: string): string {
  return `  <url>\n    <loc>${loc}</loc>${lastmodTag(lastmod)}\n  </url>`;
}

function videoTag(video: SitemapVideo): string {
  return [
    "\n    <video:video>",
    `      <video:thumbnail_loc>${xmlEscape(video.thumbnailLoc)}</video:thumbnail_loc>`,
    `      <video:title>${xmlEscape(video.title)}</video:title>`,
    `      <video:description>${xmlEscape(video.description)}</video:description>`,
    `      <video:content_loc>${xmlEscape(video.contentLoc)}</video:content_loc>`,
    "    </video:video>",
  ].join("\n");
}

function imageTag(imageLoc: string): string {
  return `\n    <image:image>\n      <image:loc>${xmlEscape(imageLoc)}</image:loc>\n    </image:image>`;
}

function findingEntry(page: SitemapLogPage): string {
  const loc = `${siteUrl}/log/${encodeURIComponent(page.logId)}`;
  const image = page.imageLoc ? imageTag(page.imageLoc) : "";
  const video = page.video ? videoTag(page.video) : "";

  return `  <url>\n    <loc>${loc}</loc>${lastmodTag(page.lastmod)}${image}${video}\n  </url>`;
}

function artistEntry(page: SitemapArtist): string {
  const loc = `${siteUrl}/artist/${encodeURIComponent(page.slug)}`;
  const image = page.imageLoc ? imageTag(page.imageLoc) : "";

  return `  <url>\n    <loc>${loc}</loc>${lastmodTag(page.lastmod)}${image}\n  </url>`;
}

function entityEntry(segment: "album" | "label", page: SitemapEntity): string {
  const loc = `${siteUrl}/${segment}/${encodeURIComponent(page.slug)}`;
  const image = page.imageLoc ? imageTag(page.imageLoc) : "";

  return `  <url>\n    <loc>${loc}</loc>${lastmodTag(page.lastmod)}${image}\n  </url>`;
}

function trackEntry(page: SitemapTrack): string {
  const loc = `${siteUrl}/track/${encodeURIComponent(page.trackId)}`;
  const image = page.imageLoc ? imageTag(page.imageLoc) : "";

  return `  <url>\n    <loc>${loc}</loc>${image}\n  </url>`;
}

function logbookEntry(page: SitemapLogbookEntry): string {
  const loc = `${siteUrl}/logbook/${encodeURIComponent(page.sector)}`;

  return `  <url>\n    <loc>${loc}</loc>${lastmodTag(page.lastmod)}\n  </url>`;
}

function galaxyEntry(page: SitemapGalaxy): string {
  const loc = `${siteUrl}/galaxies/${encodeURIComponent(page.slug)}`;

  return `  <url>\n    <loc>${loc}</loc>\n  </url>`;
}

function docsEntry(page: SitemapDoc): string {
  const path = page.path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return `  <url>\n    <loc>${siteUrl}${path}</loc>\n  </url>`;
}

function freshest(dates: (string | undefined)[]): string | undefined {
  return dates
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
}

export function sitemapPagesFromBags(bags: SitemapRowBags, mixOpen: boolean): SitemapPages {
  return {
    galaxiesOpen: bags.galaxies.length > 0,
    latest: freshest([
      ...bags.logs.map((page) => page.lastmod),
      ...bags.artists.map((page) => page.lastmod),
      ...bags.logbook.map((page) => page.lastmod),
      ...bags.labels.map((page) => page.lastmod),
      ...bags.albums.map((page) => page.lastmod),
    ]),
    logbookLatest: freshest(bags.logbook.map((page) => page.lastmod)),
    mixOpen,
  };
}

function kindEntries(kind: SitemapKind, bags: SitemapBags): string[] {
  switch (kind) {
    case "findings":
      return bags.logs.map((page) => findingEntry(page));

    case "tracks":
      return bags.tracks.map((page) => trackEntry(page));

    case "artists":
      return bags.artists.map((page) => artistEntry(page));

    case "labels":
      return bags.labels.map((page) => entityEntry("label", page));

    case "albums":
      return bags.albums.map((page) => entityEntry("album", page));

    case "galaxies":
      return bags.galaxies.map((page) => galaxyEntry(page));

    case "logbook":
      return bags.logbook.map((page) => logbookEntry(page));

    case "docs":
      return bags.docs.map((page) => docsEntry(page));

    case "pages": {
      const { galaxiesOpen, latest, logbookLatest, mixOpen } = bags.pages;

      return [
        staticEntry(`${siteUrl}/`, latest),

        staticEntry(`${siteUrl}/findings`, latest),
        staticEntry(`${siteUrl}/log`, latest),
        staticEntry(`${siteUrl}/logbook`, logbookLatest),
        staticEntry(`${siteUrl}/mixtapes`, latest),

        staticEntry(`${siteUrl}/newsletter`, latest),
        staticEntry(`${siteUrl}/artists`, latest),

        staticEntry(`${siteUrl}/fresh`, latest),

        staticEntry(`${siteUrl}/tracks`, latest),

        staticEntry(`${siteUrl}/search`, latest),

        staticEntry(`${siteUrl}/labels`, latest),
        staticEntry(`${siteUrl}/albums`, latest),
        staticEntry(`${siteUrl}/about`),
        staticEntry(`${siteUrl}/privacy`),
        staticEntry(`${siteUrl}/terms`),

        staticEntry(`${siteUrl}/radio`),

        staticEntry(`${siteUrl}/docs`),
        staticEntry(`${siteUrl}/reach`),
        staticEntry(`${siteUrl}/status`),

        staticEntry(`${siteUrl}/identity`),

        ...(mixOpen ? [staticEntry(`${siteUrl}/mix`)] : []),

        ...(galaxiesOpen ? [staticEntry(`${siteUrl}/galaxies`)] : []),
      ];
    }
  }
}

function kindLastmod(kind: SitemapKind, bags: SitemapBags): string | undefined {
  switch (kind) {
    case "findings":
      return freshest(bags.logs.map((page) => page.lastmod));

    case "artists":
      return freshest(bags.artists.map((page) => page.lastmod));

    case "labels":
      return freshest(bags.labels.map((page) => page.lastmod));

    case "albums":
      return freshest(bags.albums.map((page) => page.lastmod));

    case "galaxies":
    case "docs":
    case "tracks":
      return undefined;

    case "logbook":
      return freshest(bags.logbook.map((page) => page.lastmod));

    case "pages":
      return bags.pages.latest;
  }
}

export function shardCountForSize(count: number, kind: SitemapKind = "findings"): number {
  return Math.ceil(count / sitemapMaxUrls(kind));
}

export function shardCount(kind: SitemapKind, bags: SitemapBags): number {
  return shardCountForSize(kindEntries(kind, bags).length, kind);
}

export function sitemapPagesStats(pages: SitemapPages): SitemapKindStats {
  return {
    count: kindEntries("pages", { ...EMPTY_SITEMAP_ROW_BAGS, pages }).length,
    lastmod: pages.latest,
  };
}

export function sitemapIndexStatsFromBags(bags: SitemapBags): SitemapIndexStats {
  const statsFor = (kind: SitemapKind): SitemapKindStats => ({
    count: kindEntries(kind, bags).length,
    lastmod: kindLastmod(kind, bags),
  });

  return {
    albums: statsFor("albums"),
    artists: statsFor("artists"),
    docs: statsFor("docs"),
    findings: statsFor("findings"),
    galaxies: statsFor("galaxies"),
    labels: statsFor("labels"),
    logbook: statsFor("logbook"),
    pages: statsFor("pages"),
    tracks: statsFor("tracks"),
  };
}

export function shardPath(kind: SitemapKind, page: number): string {
  return `/sitemap/${kind}-${page}.xml`;
}

export function parseShard(shard: string): { kind: SitemapKind; page: number } | undefined {
  const match = /^([a-z]+)-(\d+)\.xml$/.exec(shard);
  const kind = SITEMAP_KINDS.find((candidate) => candidate === match?.[1]);
  const page = Number(match?.[2] ?? 0);

  return kind && Number.isSafeInteger(page) && page >= 1 ? { kind, page } : undefined;
}

const URLSET_OPEN =
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">';

export function buildSitemapShardXml(
  kind: SitemapKind,
  page: number,
  bags: SitemapBags,
): string | undefined {
  const all = kindEntries(kind, bags);
  const limit = sitemapMaxUrls(kind);
  const entries = SITEMAP_SQL_WINDOWED_KINDS.includes(kind)
    ? all
    : all.slice((page - 1) * limit, page * limit);

  if (entries.length === 0) {
    return undefined;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n${URLSET_OPEN}\n${entries.join("\n")}\n</urlset>`;
}

export function buildSitemapIndexXml(stats: SitemapIndexStats): string {
  const children = SITEMAP_KINDS.flatMap((kind) => {
    const { count, lastmod } = stats[kind];

    return Array.from({ length: shardCountForSize(count, kind) }, (_unused, index) => {
      const loc = `${siteUrl}${shardPath(kind, index + 1)}`;

      return `  <sitemap>\n    <loc>${loc}</loc>${lastmodTag(lastmod)}\n  </sitemap>`;
    });
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${children.join("\n")}
</sitemapindex>`;
}
