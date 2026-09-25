import { isBareToken, parseCoordinate, parseSonicPhrase } from "./search-query";
import { SEARCH_EXAMPLES } from "./search-results";
import {
  type DiscoveryEventName,
  type DiscoveryExampleKind,
  type DiscoveryMetadata,
  type DiscoveryOpenKind,
  type DiscoveryQueryKind,
  type DiscoveryService,
  emitDiscoveryEvent,
} from "./discovery-emit";

export {
  DISCOVERY_EVENTS,
  DISCOVERY_EXAMPLE_KINDS,
  DISCOVERY_OPEN_KINDS,
  DISCOVERY_QUERY_KINDS,
  DISCOVERY_SERVICES,
  DISCOVERY_SIMILAR_KINDS,
  emitDiscoveryEvent,
  shouldEmitDiscoveryPreview,
  type DiscoveryEventName,
  type DiscoveryExampleKind,
  type DiscoveryMetadata,
  type DiscoveryOpenKind,
  type DiscoveryQueryKind,
  type DiscoveryService,
  type DiscoverySimilarKind,
  type StartPreviewOptions,
} from "./discovery-emit";

export type ClassifiedDiscovery = {
  event: DiscoveryEventName;
  metadata?: DiscoveryMetadata;
};

const LISTENING_HOSTS: Record<string, DiscoveryService> = {
  "deezer.com": "deezer",
  "itunes.apple.com": "apple",
  "mixcloud.com": "mixcloud",
  "music.apple.com": "apple",
  "open.spotify.com": "spotify",
  "play.spotify.com": "spotify",
  "soundcloud.com": "soundcloud",
  "www.deezer.com": "deezer",
  "www.mixcloud.com": "mixcloud",
  "www.youtube.com": "youtube",
  "youtu.be": "youtube",
  "youtube.com": "youtube",
};

const EXAMPLE_BY_QUERY = new Map<string, DiscoveryExampleKind>(
  SEARCH_EXAMPLES.map((example) => [example.query, example.icon]),
);

export function classifySearchQueryKind(query: string): DiscoveryQueryKind {
  const trimmed = query.trim();

  if (parseCoordinate(trimmed)) {
    return "coordinate";
  }

  if (parseSonicPhrase(trimmed)) {
    return "sonic";
  }

  if (isBareToken(trimmed)) {
    return "token";
  }

  return "other";
}

function parseHref(href: string, base = "https://www.fluncle.com"): URL | undefined {
  try {
    return new URL(href, base);
  } catch {
    return undefined;
  }
}

function mixtapeLogPath(pathname: string): boolean {
  return /^\/log\/\d{3,}\.F\.\d/i.test(pathname);
}

function openKindFromPath(pathname: string): DiscoveryOpenKind | undefined {
  if (mixtapeLogPath(pathname)) {
    return "mixtape";
  }

  if (/^\/log\/[^/]+$/.test(pathname)) {
    return "finding";
  }

  if (/^\/track\/[^/]+$/.test(pathname)) {
    return "track";
  }

  if (/^\/artist\/[^/]+$/.test(pathname)) {
    return "artist";
  }

  if (/^\/label\/[^/]+$/.test(pathname)) {
    return "label";
  }

  if (/^\/album\/[^/]+$/.test(pathname)) {
    return "album";
  }

  if (/^\/galaxies\/[^/]+$/.test(pathname)) {
    return "galaxy";
  }

  return undefined;
}

export function classifyDiscoveryHref(
  href: string,
  options: { base?: string; similar?: boolean } = {},
): ClassifiedDiscovery | undefined {
  const url = parseHref(href, options.base);

  if (!url) {
    return undefined;
  }

  const service = LISTENING_HOSTS[url.hostname];

  if (service) {
    return { event: "discovery_outbound", metadata: { service } };
  }

  const { pathname } = url;
  const query = url.searchParams.get("q")?.trim() ?? "";

  if (pathname === "/search" && query.length > 0) {
    if (options.similar && classifySearchQueryKind(query) === "sonic") {
      return { event: "discovery_similar", metadata: { kind: "track" } };
    }

    const exampleKind = EXAMPLE_BY_QUERY.get(query);

    if (exampleKind) {
      return { event: "discovery_example", metadata: { kind: exampleKind } };
    }

    return { event: "discovery_search", metadata: { kind: classifySearchQueryKind(query) } };
  }

  const openKind = openKindFromPath(pathname);

  if (
    options.similar &&
    (openKind === "artist" || openKind === "finding" || openKind === "track")
  ) {
    return { event: "discovery_similar", metadata: { kind: openKind } };
  }

  if (openKind) {
    return { event: "discovery_open", metadata: { kind: openKind } };
  }

  return undefined;
}

export function emitDiscoveryFromHref(href: string, options: { similar?: boolean } = {}): void {
  const classified = classifyDiscoveryHref(href, options);

  if (!classified) {
    return;
  }

  emitDiscoveryEvent(classified.event, classified.metadata);
}
