export const OEMBED_PROVIDER_NAME = "Fluncle";
export const OEMBED_PROVIDER_URL = "https://www.fluncle.com";

const DEFAULT_WIDTH = 550;
const DEFAULT_HEIGHT = 240;
const MIN_WIDTH = 240;
const MIN_HEIGHT = 160;

const THUMBNAIL_WIDTH = 1200;
const THUMBNAIL_HEIGHT = 630;

const CACHE_AGE_SECONDS = 86_400;

const CANONICAL_HOSTS = new Set(["fluncle.com", "www.fluncle.com"]);

export type OembedTarget =
  | { kind: "log"; logId: string }
  | { kind: "artist"; slug: string }
  | { kind: "label"; slug: string }
  | { kind: "album"; slug: string }
  | { kind: "mixtapes" };

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

  if (segments.length === 2 && segments[0] === "log" && segments[1]) {
    return { kind: "log", logId: decodeURIComponent(segments[1]) };
  }

  if (segments.length === 2 && segments[0] === "artist" && segments[1]) {
    return { kind: "artist", slug: decodeURIComponent(segments[1]) };
  }

  if (segments.length === 2 && segments[0] === "label" && segments[1]) {
    return { kind: "label", slug: decodeURIComponent(segments[1]) };
  }

  if (segments.length === 2 && segments[0] === "album" && segments[1]) {
    return { kind: "album", slug: decodeURIComponent(segments[1]) };
  }

  if (segments.length === 1 && segments[0] === "mixtapes") {
    return { kind: "mixtapes" };
  }

  return undefined;
}

function clampDimension(requested: number | undefined, fallback: number, floor: number): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return fallback;
  }

  return Math.max(floor, Math.min(fallback, Math.floor(requested)));
}

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
