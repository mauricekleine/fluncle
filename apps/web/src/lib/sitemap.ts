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
// TYPE (`pages` / `findings` / `artists` / `labels` / `albums` / `galaxies` / `logbook` / `docs`) and
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
 * The TRACKS child's own, much lower ceiling.
 *
 * Every other kind is bounded by what Fluncle has certified or by how many entities exist, so
 * 45,000 is a limit those children will not reach for a long time and the cost of the ceiling is
 * theoretical. The archive track pages are bounded by the CRAWL, which is six figures and climbing,
 * so this ceiling is the one that actually fires — and it decides how much a single request has to
 * build. 45,000 `<url>` elements is several megabytes of string assembled inside a 128 MB Worker
 * isolate on every cache miss; 10,000 is a few hundred kilobytes and costs only more files, which
 * is exactly what a sitemap INDEX is for.
 */
export const SITEMAP_TRACKS_MAX_URLS = 10_000;

/** The per-child URL ceiling for one kind. */
export function sitemapMaxUrls(kind: SitemapKind): number {
  return kind === "tracks" ? SITEMAP_TRACKS_MAX_URLS : SITEMAP_MAX_URLS;
}

/**
 * The kinds whose bag is WINDOWED IN SQL — the data layer returns exactly the requested page's
 * rows, so {@link buildSitemapShardXml} must render the bag as-is instead of slicing it again.
 *
 * Only `tracks` is here, and it is here because it is the only kind big enough that reading the
 * whole bag to emit one child would pull a six-figure column into the isolate (AGENTS.md: never
 * pull a whole column in to rank or slice it). Every other kind reads its whole bag and lets the
 * builder window it, which keeps their unit tests exercising the builder's own arithmetic.
 */
export const SITEMAP_SQL_WINDOWED_KINDS: readonly SitemapKind[] = ["tracks"];

/**
 * The kinds, and the order the index lists them in. One child PER ENTITY TYPE (not a single
 * `graph` bucket) so Search Console reports indexing per type and a changed type refetches
 * alone. `pages` is the static hubs; the rest map one-to-one onto the {@link SitemapRowBags}.
 */
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

/**
 * A `/track/<trackId>` archive-track destination — added ONLY for a track past the EVIDENCE gate
 * (`TRACK_PAGE_INDEXABLE_WHERE`, `lib/server/track-page.ts`), which is the same expression the
 * page's own `robots` directive reads. A low-evidence track still serves 200 and stays crawlable,
 * and renders `noindex, follow`; it is simply not submitted here.
 *
 * It carries NO `<lastmod>`, and that is deliberate rather than missing. `tracks` has no
 * content-change timestamp — a release date is when the record came out, not when this page's
 * content last moved — so a track entry is honestly undated, exactly as the `docs` and `galaxies`
 * children are, instead of inventing a stamp a crawler would treat as a claim.
 */
export type SitemapTrack = {
  /** Cover art for the Google Images `<image:image>` extension. */
  imageLoc?: string;
  trackId: string;
};

// A `/galaxies/<slug>` sonic-galaxy page (browse-by-feel RFC) — added ONLY once the map
// is fully named (the route feeds an empty list before the launch gate opens) AND the
// galaxy clears the thin-content floor (≥ GALAXY_INDEX_MIN_FINDINGS members; the thin
// ones render `noindex, follow`). The route filters; this just formats.
export type SitemapGalaxy = {
  slug: string;
};

// One `/docs/<slug>` developer-doc page — the Fumadocs content tree, one `<loc>` each. Text
// only (no media), and honestly undated: the MDX carries no per-page timestamp, so a docs
// entry omits `<lastmod>` rather than inventing a build stamp (the `galaxies` precedent).
export type SitemapDoc = {
  /** The page's own path as Fumadocs resolved it, e.g. `/docs/cli`. */
  path: string;
};

/**
 * The ROW bags — every `<url>` the sitemap can list, one array per entity kind. A CHILD sitemap
 * slices exactly one of these, which is why the data layer fetches one at a time
 * (`collectSitemapBag`) rather than all seven for every request.
 */
export type SitemapRowBags = {
  albums: SitemapEntity[];
  artists: SitemapArtist[];
  /** The `/docs/<slug>` pages, WITHOUT the `/docs` hub — `pages` owns the hub. */
  docs: SitemapDoc[];
  galaxies: SitemapGalaxy[];
  labels: SitemapEntity[];
  logbook: SitemapLogbookEntry[];
  /** The `/log/<coordinate>` pages: findings AND published mixtapes. */
  logs: SitemapLogPage[];
  /** The `/track/<trackId>` archive-track destinations past the evidence gate. */
  tracks: SitemapTrack[];
};

/**
 * What the `pages` child needs and no row bag carries: the two hub timestamps and the two
 * self-lifting gates.
 *
 * It is a field of its own rather than something derived from the row bags because that is what
 * lets the `pages` child be built from four small aggregates instead of every URL in the archive
 * — the whole reason `/sitemap.xml` stopped dragging the corpus through the isolate.
 * {@link sitemapPagesFromBags} is the pure derivation from full bags, and the data layer's
 * aggregate read must agree with it (pinned by `sitemap-data.integration.test.ts`).
 */
export type SitemapPages = {
  /**
   * Whether the `/galaxies` lens index is listed — true once the map is fully named, which is
   * exactly `galaxies.length > 0` (the reader feeds an empty bag before the launch gate opens).
   */
  galaxiesOpen: boolean;
  /** The freshest content date across the archive — every hub `<loc>`'s `<lastmod>`. */
  latest?: string;
  /** The freshest authored logbook entry — the `/logbook` hub's own `<lastmod>`. */
  logbookLatest?: string;
  /**
   * Whether `/mix` is open to the world — the route's own self-lifting gate
   * (`getMixChainDepth().open`). Listed in `pages` only while true, exactly as `/galaxies`
   * rides `galaxiesOpen`: the launch gate self-lifts with no deploy, and the sitemap
   * lights the hub up the same day the tool does.
   */
  mixOpen: boolean;
};

/**
 * Everything one sitemap document needs. A CHILD is built from the single row bag it slices (plus
 * `pages` for the static child); the INDEX is built from {@link SitemapIndexStats} instead, which
 * is the same information counted and dated without the rows.
 */
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

/** One child's line in the index: how many URLs it holds, and the freshest date among them. */
export type SitemapKindStats = {
  count: number;
  lastmod?: string;
};

/**
 * The whole index, as numbers and dates — the ONLY thing `/sitemap.xml` needs. Seven small
 * `count`/`max()` reads produce this; seven full row reads are no longer paid to emit ~eight
 * `<sitemap>` lines.
 */
export type SitemapIndexStats = Record<SitemapKind, SitemapKindStats>;

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

// An archive-track entry: `<loc>` + optional cover `<image:image>`. No `<lastmod>` — see
// SitemapTrack for why an undated entry is the honest one here.
function trackEntry(page: SitemapTrack): string {
  const loc = `${siteUrl}/track/${encodeURIComponent(page.trackId)}`;
  const image = page.imageLoc ? imageTag(page.imageLoc) : "";

  return `  <url>\n    <loc>${loc}</loc>${image}\n  </url>`;
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

// A docs entry: just `<loc>`. The path already comes from Fumadocs as URL segments, so it is
// joined rather than percent-encoded whole (`encodeURIComponent` would eat the slashes of a
// nested doc); each SEGMENT is encoded instead.
function docsEntry(page: SitemapDoc): string {
  const path = page.path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return `  <url>\n    <loc>${siteUrl}${path}</loc>\n  </url>`;
}

/** The freshest ISO date in a bag of maybe-dated pages, or undefined when nothing is dated. */
function freshest(dates: (string | undefined)[]): string | undefined {
  return dates
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
}

/**
 * The `pages` child's inputs, derived from FULL row bags — the reference the data layer's lean
 * aggregate read has to match, and what the unit tests build their fixtures through.
 *
 * `latest` is the freshest date anywhere in the archive (the hubs' shared `<lastmod>`);
 * `logbookLatest` dates the `/logbook` hub alone. `mixOpen` is the one input no bag implies, so
 * it is passed in.
 */
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

/**
 * Every `<url>` of one kind, in order. The single source of what a kind CONTAINS — the index
 * counts these to size its children and a child slices these to serve one, so the two can
 * never disagree about what exists.
 */
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
      // The two hub timestamps + the two gates, already aggregated (SitemapPages) — so the static
      // child costs four small reads, never a walk of the archive it dates itself from.
      const { galaxiesOpen, latest, logbookLatest, mixOpen } = bags.pages;

      return [
        staticEntry(`${siteUrl}/`, latest),
        // The cover-led archive page: every finding, newest-found first, on the logbook plate.
        // It shares the front door's `latest` stamp because it is the same content, and both are
        // indexable and self-canonical — `/` is the door (search, one edited lead, a few findings,
        // what just came out, the four hubs), `/findings` is the whole feed.
        staticEntry(`${siteUrl}/findings`, latest),
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
        // NOT `/galaxy`: the game renders `noindex` (routes/galaxy.tsx — a client-only canvas, so a
        // crawler sees chrome and no content). A sitemap is a submission for indexing, so listing a
        // noindexed URL asks for the one thing the page refuses; Search Console reports it back as
        // "Submitted URL marked 'noindex'". The OG card keeps the game shareable, and
        // galaxy.fluncle.com serves the same noindexed document, so nothing here needs a `loc`.
        // The `/galaxies` LENS index below is a different surface and is listed once its gate opens.
        // The always-on player — self-canonical and indexable like the rest, and listed
        // unconditionally because the stream is always live. The `loc` also does consolidation
        // work: radio.fluncle.com serves the identical document, so naming the www URL here is
        // the tie-break that points the duplicate home.
        staticEntry(`${siteUrl}/radio`),
        // The console pages — real, self-canonical, indexable surfaces that were footer-only
        // for discovery until now: the docs hub, the reach page, and the live status board.
        staticEntry(`${siteUrl}/docs`),
        staticEntry(`${siteUrl}/reach`),
        staticEntry(`${siteUrl}/status`),
        // The identity DOOR — the indexable page that stands for the lookup surface. Its per-key
        // answers (`/identity/<key>`) are deliberately absent: one recording is reachable under up
        // to three identifiers, so listing them would put three near-identical URLs in front of
        // one answer, tens of thousands of times over. Those pages render `noindex, follow`, so
        // they stay crawlable and citable while only the door is a URL here.
        staticEntry(`${siteUrl}/identity`),
        // The `/mix` tool — listed only while its self-lifting gate is open (the same
        // `getMixChainDepth().open` the route checks). Closed, the tool is private (operator
        // + strangers sent home), so it stays out of the sitemap; the day the archive is deep
        // enough it opens on its own, the hub lights up here with no deploy.
        ...(mixOpen ? [staticEntry(`${siteUrl}/mix`)] : []),
        // The `/galaxies` lens index — listed only once the launch gate has opened (the reader
        // feeds an empty `galaxies` bag before then, keeping the pre-launch dark state).
        ...(galaxiesOpen ? [staticEntry(`${siteUrl}/galaxies`)] : []),
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
    // entries), so a galaxies child is honestly undated — the tag is simply omitted. The docs
    // child is undated for the same reason: the MDX front matter carries no date, and the tracks
    // child for a third: `tracks` carries no content-change timestamp at all (see SitemapTrack).
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

/** How many children a kind of `count` URLs needs. Always ≥ 1 for `pages` (the hubs are never empty). */
export function shardCountForSize(count: number, kind: SitemapKind = "findings"): number {
  return Math.ceil(count / sitemapMaxUrls(kind));
}

/** How many children one kind needs, from full bags. */
export function shardCount(kind: SitemapKind, bags: SitemapBags): number {
  return shardCountForSize(kindEntries(kind, bags).length, kind);
}

/**
 * The `pages` child's line in the index. It is the one kind whose SIZE is a function of the two
 * gates rather than of a row bag (18 hubs, plus `/mix` and `/galaxies` when open), so the data
 * layer counts it through here instead of guessing the number.
 */
export function sitemapPagesStats(pages: SitemapPages): SitemapKindStats {
  return {
    count: kindEntries("pages", { ...EMPTY_SITEMAP_ROW_BAGS, pages }).length,
    lastmod: pages.latest,
  };
}

/**
 * The index stats derived from FULL row bags — the reference path. The data layer answers the
 * same question with seven `count`/`max()` reads instead (`collectSitemapIndexStats`), and
 * `sitemap-data.integration.test.ts` pins the two against each other over a seeded archive, so
 * the cheap read can never quietly start promising a different index than the children serve.
 */
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
 * One child sitemap: the `page`-th slice of `kind`, capped at {@link sitemapMaxUrls}.
 * Returns undefined for a page past the end, which the route turns into a 404 — an empty
 * `<urlset>` would tell a crawler the URLs had been REMOVED.
 *
 * A {@link SITEMAP_SQL_WINDOWED_KINDS} kind arrives ALREADY windowed (the data layer applied the
 * `limit`/`offset`), so it is rendered as-is; slicing it a second time would serve page 1's rows
 * for page 1 and nothing at all for every page after it.
 */
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

/**
 * `/sitemap.xml` — the index. Lists every child that actually has URLs, so an archive with no
 * logbook advertises no logbook sitemap rather than an empty one.
 *
 * It takes STATS, not bags: the index carries no `<url>` of its own, so a count and a date per
 * kind is the whole input, and asking for the rows to derive them was the reason a ~1KB document
 * cost multiple seconds and grew with the catalogue.
 */
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
