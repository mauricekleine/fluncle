// oEmbed 1.0 provider plumbing (https://oembed.com). A consumer (Discord, Notion,
// WordPress, Ghost, Slack, …) that finds the `<link rel="alternate"
// type="application/json+oembed">` on a Fluncle page fetches `/oembed?url=…` and
// gets back a provider envelope: a `rich` card (an <iframe> pointing at
// `/embed/<logId>`) for a finding or mixtape, or a `link` type (title + thumbnail)
// for an artist / label / album page or the mixtapes index. This module is PURE — URL parsing and
// the two payload builders, no I/O — so the route (../routes/oembed.ts) does the
// data resolution and this stays unit-testable (see oembed.test.ts).

export const OEMBED_PROVIDER_NAME = "Fluncle";
export const OEMBED_PROVIDER_URL = "https://www.fluncle.com";

// The rich-card iframe's default box, and the floor a `maxwidth` may shrink it to.
// The card is a compact horizontal finding plate; consumers may cap it with
// `maxwidth`/`maxheight` (honored as ceilings, never grown past the default).
const DEFAULT_WIDTH = 550;
const DEFAULT_HEIGHT = 240;
const MIN_WIDTH = 240;
const MIN_HEIGHT = 160;

// The OG card the finding/mixtape already renders (1200×630) is the thumbnail.
const THUMBNAIL_WIDTH = 1200;
const THUMBNAIL_HEIGHT = 630;

// A day — the card is publish-then-immutable, so consumers may cache it.
const CACHE_AGE_SECONDS = 86_400;

// Only these two hosts map to canonical Fluncle pages. Subdomains (galaxy./radio./
// found.) are not page hosts we unfurl.
const CANONICAL_HOSTS = new Set(["fluncle.com", "www.fluncle.com"]);

/**
 * What a submitted `url` resolves to. `log` covers both a finding and a mixtape
 * (they share the `/log/<logId>` route); `artist`, `label`, `album`, and
 * `mixtapes` are the `link`-type surfaces (a graph/collection page, no per-item
 * embed card).
 */
export type OembedTarget =
  | { kind: "log"; logId: string }
  | { kind: "artist"; slug: string }
  | { kind: "label"; slug: string }
  | { kind: "album"; slug: string }
  | { kind: "mixtapes" };

/**
 * Map a submitted URL to a Fluncle resource, or `undefined` if it is malformed,
 * off-host, or not an unfurlable page. Pure: no DB lookup — the route resolves the
 * resource once the shape is known.
 */
export function parseOembedTarget(rawUrl: string): OembedTarget | undefined {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }

  if (!CANONICAL_HOSTS.has(url.hostname.toLowerCase())) {
    return undefined;
  }

  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);

  // /log/<logId> — a finding or a mixtape (the coordinate can carry dots, never a
  // slash, so it is a single segment).
  if (segments.length === 2 && segments[0] === "log" && segments[1]) {
    return { kind: "log", logId: decodeURIComponent(segments[1]) };
  }

  // /artist/<slug>, /label/<slug>, /album/<slug> — the graph pages.
  if (segments.length === 2 && segments[0] === "artist" && segments[1]) {
    return { kind: "artist", slug: decodeURIComponent(segments[1]) };
  }

  if (segments.length === 2 && segments[0] === "label" && segments[1]) {
    return { kind: "label", slug: decodeURIComponent(segments[1]) };
  }

  if (segments.length === 2 && segments[0] === "album" && segments[1]) {
    return { kind: "album", slug: decodeURIComponent(segments[1]) };
  }

  // /mixtapes — the collection index (no per-mixtape path; a single mixtape lives
  // at /log/<F-logId> and takes the `log` branch).
  if (segments.length === 1 && segments[0] === "mixtapes") {
    return { kind: "mixtapes" };
  }

  return undefined;
}

/** Clamp a requested `maxwidth`/`maxheight` to the card's [floor, default] range. */
function clampDimension(requested: number | undefined, fallback: number, floor: number): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return fallback;
  }

  return Math.max(floor, Math.min(fallback, Math.floor(requested)));
}

// Escape a string for safe interpolation into a double-quoted HTML attribute — the
// `html` payload is injected raw into a consumer's page, so the iframe `title`
// (a Spotify-sourced finding title) must not be able to break out of the attribute.
function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export type OembedRichResponse = {
  version: "1.0";
  type: "rich";
  provider_name: string;
  provider_url: string;
  title: string;
  author_name?: string;
  thumbnail_url?: string;
  thumbnail_width?: number;
  thumbnail_height?: number;
  html: string;
  width: number;
  height: number;
  cache_age: number;
};

export type OembedLinkResponse = {
  version: "1.0";
  type: "link";
  provider_name: string;
  provider_url: string;
  title: string;
  author_name?: string;
  thumbnail_url?: string;
  thumbnail_width?: number;
  thumbnail_height?: number;
  cache_age: number;
};

export type OembedResponse = OembedRichResponse | OembedLinkResponse;

/**
 * The `rich` payload for a finding or mixtape: an <iframe> pointing at the
 * self-contained `/embed/<logId>` card, sized within the consumer's `maxwidth`/
 * `maxheight`, with the OG card as the thumbnail. Type is `rich` (not `video`) —
 * the embed is a finding CARD (cover + coordinate + actions), not a bare video
 * player, so `rich` is the honest oEmbed type even when the finding has a video.
 */
export function buildRichEmbed(params: {
  logId: string;
  title: string;
  authorName?: string;
  thumbnailUrl?: string;
  maxwidth?: number;
  maxheight?: number;
}): OembedRichResponse {
  const width = clampDimension(params.maxwidth, DEFAULT_WIDTH, MIN_WIDTH);
  const height = clampDimension(params.maxheight, DEFAULT_HEIGHT, MIN_HEIGHT);
  const embedUrl = `${OEMBED_PROVIDER_URL}/embed/${encodeURIComponent(params.logId)}`;
  const frameTitle = escapeHtmlAttribute(params.title);
  const html =
    `<iframe src="${embedUrl}" width="${width}" height="${height}" ` +
    `title="${frameTitle}" frameborder="0" loading="lazy" ` +
    `style="border:0;border-radius:14px;max-width:100%;" ` +
    `allow="clipboard-write" referrerpolicy="no-referrer-when-downgrade"></iframe>`;

  return {
    cache_age: CACHE_AGE_SECONDS,
    height,
    html,
    provider_name: OEMBED_PROVIDER_NAME,
    provider_url: OEMBED_PROVIDER_URL,
    thumbnail_height: params.thumbnailUrl ? THUMBNAIL_HEIGHT : undefined,
    thumbnail_url: params.thumbnailUrl,
    thumbnail_width: params.thumbnailUrl ? THUMBNAIL_WIDTH : undefined,
    title: params.title,
    type: "rich",
    version: "1.0",
    width,
    ...(params.authorName ? { author_name: params.authorName } : {}),
  };
}

/**
 * The `link` payload for an artist page or the mixtapes index — a collection/
 * profile page with no per-item embed card. Still carries the title, author, and
 * OG thumbnail, so a consumer unfurls it richly without an iframe.
 */
export function buildLinkResponse(params: {
  title: string;
  authorName?: string;
  thumbnailUrl?: string;
}): OembedLinkResponse {
  return {
    cache_age: CACHE_AGE_SECONDS,
    provider_name: OEMBED_PROVIDER_NAME,
    provider_url: OEMBED_PROVIDER_URL,
    thumbnail_height: params.thumbnailUrl ? THUMBNAIL_HEIGHT : undefined,
    thumbnail_url: params.thumbnailUrl,
    thumbnail_width: params.thumbnailUrl ? THUMBNAIL_WIDTH : undefined,
    title: params.title,
    type: "link",
    version: "1.0",
    ...(params.authorName ? { author_name: params.authorName } : {}),
  };
}
