// PUBLIC DISCOVERY JOURNEY EVENTS — aggregate Simple Analytics beacons, never a person.
//
// Fluncle already loads Simple Analytics for cookieless pageviews (`routes/__root.tsx`). This
// module is the small extra layer on top: six named journey steps, fired from existing public
// controls, with payloads that are bounded categories and never the words a visitor typed.
// Analytics is progressive enhancement. `emitDiscoveryEvent` never awaits, never throws, and
// never intercepts navigation or playback. If `window.sa_event` is missing or throws, the
// control's own action still runs.
//
// Vocabulary (one name, one step):
//   discovery_search   — committed an archive query (the /search form, or a palette type-ahead)
//   discovery_example  — followed a worked example into /search
//   discovery_open     — opened an entity destination (finding, track, artist, label, album, galaxy, mixtape)
//   discovery_similar  — continued through a sonic neighbour (Close in sound, similar artists)
//   discovery_preview  — started an in-place preview
//   discovery_outbound — left for an outbound listening service
//
// Classification is by RESOLVED destination (the href, or hitHref / entityHref), never by the
// English on the control. A catalogue row and a finding can share a component: certified + Log ID
// opens `/log/<id>` (discovery_open/finding); an identified uncertified row opens
// `/track/<trackId>` (discovery_open/track); only the fallback Spotify URL leaves the origin
// (discovery_outbound). See docs/search.md, "Discovery journey events".

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

/** The resolver-tier SHAPE of a query, with no text retained. Multi-word names fold to `other`. */
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

/**
 * Classify a control by where it actually goes. `similar` is the behavioural marker on a
 * neighbour rail (`data-discovery="similar"`), not a reading of the English on the chip.
 */
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

/** Classify an href and emit, used by palette rows that navigate imperatively rather than as anchors. */
export function emitDiscoveryFromHref(href: string, options: { similar?: boolean } = {}): void {
  const classified = classifyDiscoveryHref(href, options);

  if (!classified) {
    return;
  }

  emitDiscoveryEvent(classified.event, classified.metadata);
}

/**
 * Capture-phase click classification. Returns the event that WOULD fire so tests can prove
 * once-per-action without a browser. `undefined` when the click is not a discovery control.
 */
export function classifyDiscoveryClick(
  href: string,
  similar: boolean,
  base?: string,
): ClassifiedDiscovery | undefined {
  return classifyDiscoveryHref(href, { base, similar });
}
