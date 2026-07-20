import { siteUrl } from "./fluncle-links";

// The sitemap documents, pure: the routes feed these rows; lastmod is REAL (per-finding
// freshest of video_squared_at / updated_at / added_at from the query), never a build stamp —
// entries without a known date simply omit the tag.
//
// ── WHY IT IS A SITEMAP INDEX ───────────────────────────────────────────────────────────
// Google rejects a sitemap wholesale past 50,000 URLs or 50 MB uncompressed — a breach is not
// partially honoured, the document is DROPPED. One flat `<urlset>` therefore carries a cliff
// it cannot see itself approaching, and "we are nowhere near it" is a claim that expires.
//
// So `/sitemap.xml` is a `<sitemapindex>` and the URLs live in children, ONE CHILD PER ENTITY
// TYPE (`pages` / `findings` / `artists` / `labels` / `albums` / `galaxies` / `logbook`) and
// each type AUTO-PAGED at {@link SITEMAP_MAX_URLS}. The breach stops being something to watch
// and becomes something that cannot happen: a type that outgrows a child grows a second child
// instead.
//
// Splitting PER ENTITY TYPE is also the diagnostic. Search Console reports coverage PER
// SITEMAP, so "labels: 41 submitted, 3 indexed" is a sentence you can read — which is exactly
// the question worth asking of an entity space that grows with a crawler. The graph pages once
// shared a single `graph` child; pulling artists/labels/albums/galaxies apart turns that one
// blurred number into four legible ones, and lets a crawler refetch only the type that changed
// (a new label touches `labels`, not every graph page).
//
// A finding that carries a rendered video also gets a Google video-sitemap `<video:video>`
// block (thumbnail/title/description/content_loc), and every finding gets an `<image:image>`
// (cover art) for Google Images — so the archive surfaces its videos and its covers to the
// right crawlers, not just a plain `<loc>`. A malformed video block gets the WHOLE sitemap
// rejected, so every text field is XML-escaped and the field order follows Google's spec.

/**
 * The per-child URL ceiling. Google's hard limit is 50,000; this sits under it with room, so
 * a child never lands on the boundary and a miscount is a cheap extra file, not a rejection.
 */
export const SITEMAP_MAX_URLS = 45_000;

/**
 * The kinds, and the order the index lists them in. One child PER ENTITY TYPE (not a single
 * `graph` bucket) so Search Console reports indexing per type and a changed type refetches
 * alone. `pages` is the static hubs; the rest map one-to-one onto the {@link SitemapBags}.
 */
export const SITEMAP_KINDS = [
  "pages",
  "findings",
  "artists",
  "labels",
  "albums",
  "galaxies",
  "logbook",
] as const;

export type SitemapKind = (typeof SITEMAP_KINDS)[number];

/** A finding's rendered video, for the `<video:video>` sitemap extension. */
export type SitemapVideo = {
  /** The footage file URL — `<video:content_loc>`. */
  contentLoc: string;
  /** A one-or-two sentence description — `<video:description>` (required). */
  description: string;
  /** The poster/cover still — `<video:thumbnail_loc>` (required). */
  thumbnailLoc: string;
  /** `Artist — Title` — `<video:title>` (required). */
  title: string;
};

export type SitemapLogPage = {
  /** Cover art for the Google Images `<image:image>` extension. */
  imageLoc?: string;
  /** ISO date of the finding's last real content change. */
  lastmod: string;
  logId: string;
  /** Present only when the finding has a rendered video. */
  video?: SitemapVideo;
};

// A `/logbook/<sector>` travelogue entry — one per authored sector-day. The route
// formats the sector to its padded URL form; this just carries the path + lastmod.
export type SitemapLogbookEntry = {
  /** ISO date of the entry's last (re)generation. */
  lastmod?: string;
  /** The padded sector segment (e.g. "036") — the /logbook/<sector> path. */
  sector: string;
};

// A `/artist/<slug>` page — added ONLY for artists past the thin-content gate
// (≥ ARTIST_INDEX_MIN_FINDINGS coordinate-bearing findings); the thin ones stay
// out (they render `noindex, follow`). The route filters; this just formats.
export type SitemapArtist = {
  /** Cover art for the Google Images `<image:image>` extension. */
  imageLoc?: string;
  /** ISO date of the artist's freshest finding. */
  lastmod?: string;
  slug: string;
};

// A `/label/<slug>` or `/album/<slug>` graph page — added ONLY past the thin-content gate
// (≥ LABEL_INDEX_MIN_TRACKS / ALBUM_INDEX_MIN_TRACKS renderable tracks: the findings plus the
// quieter uncertified rows, which are real content on the page too). The thin ones stay out
// and render `noindex, follow`. The route filters; this just formats.
export type SitemapEntity = {
  /** Cover art for the Google Images `<image:image>` extension. */
  imageLoc?: string;
  /** ISO date of the entity's freshest finding. */
  lastmod?: string;
  slug: string;
};

// A `/galaxies/<slug>` sonic-galaxy page (browse-by-feel RFC) — added ONLY once the map
// is fully named (the route feeds an empty list before the launch gate opens) AND the
// galaxy clears the thin-content floor (≥ GALAXY_INDEX_MIN_FINDINGS members; the thin
// ones render `noindex, follow`). The route filters; this just formats.
export type SitemapGalaxy = {
  slug: string;
};

/**
 * Everything the sitemap knows, gathered once. Both routes read the same bags — the index to
 * count and date its children, a child to slice its own page — so a URL the index promises is
 * always a URL the child serves.
 */
export type SitemapBags = {
  albums: SitemapEntity[];
  artists: SitemapArtist[];
  galaxies: SitemapGalaxy[];
  labels: SitemapEntity[];
  logbook: SitemapLogbookEntry[];
  /** The `/log/<coordinate>` pages: findings AND published mixtapes. */
  logs: SitemapLogPage[];
  /**
   * Whether `/mix` is open to the world — the route's own self-lifting gate
   * (`getMixChainDepth().open`). Listed in `pages` only while true, exactly as `/galaxies`
   * rides `galaxies.length`: the launch gate self-lifts with no deploy, and the sitemap
   * lights the hub up the same day the tool does.
   */
  mixOpen: boolean;
};

export const EMPTY_SITEMAP_BAGS: SitemapBags = {
  albums: [],
  artists: [],
  galaxies: [],
  labels: [],
  logbook: [],
  logs: [],
  mixOpen: false,
};

// Escape the five XML metacharacters so a Spotify-sourced title/artist or an
// operator note can't malform the document (a bare `&` invalidates the feed, and
// Google rejects an invalid video sitemap wholesale).
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

// A static-surface entry: just `<loc>` + optional `<lastmod>` (no media).
function staticEntry(loc: string, lastmod?: string): string {
  return `  <url>\n    <loc>${loc}</loc>${lastmodTag(lastmod)}\n  </url>`;
}

// Google video-sitemap required field order: thumbnail_loc, title, description,
// then a player_loc or content_loc. We ship content_loc (the footage file).
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

// A finding entry: `<loc>` + `<lastmod>` + optional `<image:image>` + optional
// `<video:video>`. A page with neither media renders exactly like a plain
// static entry (mixtapes flow through here too).
function findingEntry(page: SitemapLogPage): string {
  const loc = `${siteUrl}/log/${encodeURIComponent(page.logId)}`;
  const image = page.imageLoc ? imageTag(page.imageLoc) : "";
  const video = page.video ? videoTag(page.video) : "";

  return `  <url>\n    <loc>${loc}</loc>${lastmodTag(page.lastmod)}${image}${video}\n  </url>`;
}

// An artist entry: `<loc>` + optional `<lastmod>` + optional cover `<image:image>`.
function artistEntry(page: SitemapArtist): string {
  const loc = `${siteUrl}/artist/${encodeURIComponent(page.slug)}`;
  const image = page.imageLoc ? imageTag(page.imageLoc) : "";

  return `  <url>\n    <loc>${loc}</loc>${lastmodTag(page.lastmod)}${image}\n  </url>`;
}

// A label/album entry: `<loc>` + optional `<lastmod>` + optional cover `<image:image>` —
// the artist entry's shape, under a different path segment.
function entityEntry(segment: "album" | "label", page: SitemapEntity): string {
  const loc = `${siteUrl}/${segment}/${encodeURIComponent(page.slug)}`;
  const image = page.imageLoc ? imageTag(page.imageLoc) : "";

  return `  <url>\n    <loc>${loc}</loc>${lastmodTag(page.lastmod)}${image}\n  </url>`;
}

// A logbook entry: just `<loc>` + optional `<lastmod>` (text-first, no media).
function logbookEntry(page: SitemapLogbookEntry): string {
  const loc = `${siteUrl}/logbook/${encodeURIComponent(page.sector)}`;

  return `  <url>\n    <loc>${loc}</loc>${lastmodTag(page.lastmod)}\n  </url>`;
}

// A galaxy entry: just `<loc>` (the lens page has no single freshest media timestamp;
// its members carry their own lastmod on their /log entries).
function galaxyEntry(page: SitemapGalaxy): string {
  const loc = `${siteUrl}/galaxies/${encodeURIComponent(page.slug)}`;

  return `  <url>\n    <loc>${loc}</loc>\n  </url>`;
}

/** The freshest ISO date in a bag of maybe-dated pages, or undefined when nothing is dated. */
function freshest(dates: (string | undefined)[]): string | undefined {
  return dates
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
}

function bagLastmod(bags: SitemapBags): string | undefined {
  return freshest([
    ...bags.logs.map((page) => page.lastmod),
    ...bags.artists.map((page) => page.lastmod),
    ...bags.logbook.map((page) => page.lastmod),
    ...bags.labels.map((page) => page.lastmod),
    ...bags.albums.map((page) => page.lastmod),
  ]);
}

/**
 * Every `<url>` of one kind, in order. The single source of what a kind CONTAINS — the index
 * counts these to size its children and a child slices these to serve one, so the two can
 * never disagree about what exists.
 */
function kindEntries(kind: SitemapKind, bags: SitemapBags): string[] {
  switch (kind) {
    case "findings":
      return bags.logs.map((page) => findingEntry(page));

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

    case "pages": {
      const latest = bagLastmod(bags);
      // The /logbook index's lastmod: the freshest authored entry.
      const logbookLatest = freshest(bags.logbook.map((page) => page.lastmod));

      return [
        staticEntry(`${siteUrl}/`, latest),
        staticEntry(`${siteUrl}/log`, latest),
        staticEntry(`${siteUrl}/logbook`, logbookLatest),
        staticEntry(`${siteUrl}/mixtapes`, latest),
        // The newsletter archive — a real editorial hub (ItemList JSON-LD, self-canonical,
        // indexable) in the /mixtapes family: Fluncle's own published series kept as web
        // pages. Shares the hubs' `latest` stamp; the per-edition pages are discovered from it.
        staticEntry(`${siteUrl}/newsletter`, latest),
        staticEntry(`${siteUrl}/artists`, latest),
        // The new-releases lens — a real editorial hub (indexable, self-canonical): what just came
        // out across the whole archive. A daily-changing page, so it shares the hubs' freshest-
        // content `latest` stamp (the builder is pure — the page's own volatility rides its
        // Cache-Control, not a synthetic "now"), and it is listed unconditionally like /artists.
        staticEntry(`${siteUrl}/fresh`, latest),
        // The whole-archive track index — a real hub (indexable, self-canonical): every track,
        // findings + catalogue, newest release first. Listed unconditionally like /fresh; a
        // filtered view (`?bpmMin=…`) is `noindex` per-request, so only the bare hub is a URL here.
        staticEntry(`${siteUrl}/tracks`, latest),
        // The graph HUBS are listed unconditionally, exactly like /artists: a hub is a real
        // page whose content is the whole list, so the per-page thin-content gate (which can,
        // legitimately, admit no DETAIL pages at all) says nothing about whether the hub
        // itself is worth indexing. It is.
        staticEntry(`${siteUrl}/labels`, latest),
        staticEntry(`${siteUrl}/albums`, latest),
        staticEntry(`${siteUrl}/about`),
        staticEntry(`${siteUrl}/privacy`),
        staticEntry(`${siteUrl}/terms`),
        staticEntry(`${siteUrl}/galaxy`),
        // The console pages — real, self-canonical, indexable surfaces that were footer-only
        // for discovery until now: the docs hub, the reach page, and the live status board.
        staticEntry(`${siteUrl}/docs`),
        staticEntry(`${siteUrl}/reach`),
        staticEntry(`${siteUrl}/status`),
        // The `/mix` tool — listed only while its self-lifting gate is open (the same
        // `getMixChainDepth().open` the route checks). Closed, the tool is private (operator
        // + strangers sent home), so it stays out of the sitemap; the day the archive is deep
        // enough it opens on its own, the hub lights up here with no deploy.
        ...(bags.mixOpen ? [staticEntry(`${siteUrl}/mix`)] : []),
        // The `/galaxies` lens index — listed only once the launch gate has opened (the route
        // feeds an empty `galaxies` bag before then, keeping the pre-launch dark state).
        ...(bags.galaxies.length > 0 ? [staticEntry(`${siteUrl}/galaxies`)] : []),
      ];
    }
  }
}

/** The freshest lastmod inside one kind — a child sitemap's `<lastmod>` in the index. */
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

    // The lens page carries no single freshest timestamp (its members date their own /log
    // entries), so a galaxies child is honestly undated — the tag is simply omitted.
    case "galaxies":
      return undefined;

    case "logbook":
      return freshest(bags.logbook.map((page) => page.lastmod));

    case "pages":
      return bagLastmod(bags);
  }
}

/** How many children one kind needs. Always ≥ 1 for `pages` (the hubs are never empty). */
export function shardCount(kind: SitemapKind, bags: SitemapBags): number {
  return Math.ceil(kindEntries(kind, bags).length / SITEMAP_MAX_URLS);
}

/** The path of one child, 1-indexed: `/sitemap/findings-1.xml`. */
export function shardPath(kind: SitemapKind, page: number): string {
  return `/sitemap/${kind}-${page}.xml`;
}

/**
 * Parse the `$shard` route param — the WHOLE segment, `.xml` and all — back to its kind and
 * page. Anything else is undefined, which the route turns into a 404: the param is a stranger's
 * string, so the allowlist of four kinds is the validator.
 */
export function parseShard(shard: string): { kind: SitemapKind; page: number } | undefined {
  const match = /^([a-z]+)-(\d+)\.xml$/.exec(shard);
  const kind = SITEMAP_KINDS.find((candidate) => candidate === match?.[1]);
  const page = Number(match?.[2] ?? 0);

  return kind && Number.isSafeInteger(page) && page >= 1 ? { kind, page } : undefined;
}

const URLSET_OPEN =
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">';

/**
 * One child sitemap: the `page`-th slice of `kind`, capped at {@link SITEMAP_MAX_URLS}.
 * Returns undefined for a page past the end, which the route turns into a 404 — an empty
 * `<urlset>` would tell a crawler the URLs had been REMOVED.
 */
export function buildSitemapShardXml(
  kind: SitemapKind,
  page: number,
  bags: SitemapBags,
): string | undefined {
  const entries = kindEntries(kind, bags).slice(
    (page - 1) * SITEMAP_MAX_URLS,
    page * SITEMAP_MAX_URLS,
  );

  if (entries.length === 0) {
    return undefined;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n${URLSET_OPEN}\n${entries.join("\n")}\n</urlset>`;
}

/**
 * `/sitemap.xml` — the index. Lists every child that actually has URLs, so an archive with no
 * logbook advertises no logbook sitemap rather than an empty one.
 */
export function buildSitemapIndexXml(bags: SitemapBags): string {
  const children = SITEMAP_KINDS.flatMap((kind) => {
    const lastmod = kindLastmod(kind, bags);

    return Array.from({ length: shardCount(kind, bags) }, (_unused, index) => {
      const loc = `${siteUrl}${shardPath(kind, index + 1)}`;

      return `  <sitemap>\n    <loc>${loc}</loc>${lastmodTag(lastmod)}\n  </sitemap>`;
    });
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${children.join("\n")}
</sitemapindex>`;
}
