// The fire-and-forget half of public discovery events. Kept free of the search
// classifier so preview-player (and any other singleton) does not pull the example list
// into every surface that plays audio.

export const DISCOVERY_EVENTS = [
  "discovery_search",
  "discovery_example",
  "discovery_open",
  "discovery_similar",
  "discovery_preview",
  "discovery_outbound",
] as const;

export type DiscoveryEventName = (typeof DISCOVERY_EVENTS)[number];

export const DISCOVERY_QUERY_KINDS = ["coordinate", "sonic", "token", "other"] as const;
export type DiscoveryQueryKind = (typeof DISCOVERY_QUERY_KINDS)[number];

export const DISCOVERY_EXAMPLE_KINDS = ["coordinate", "sonic", "token"] as const;
export type DiscoveryExampleKind = (typeof DISCOVERY_EXAMPLE_KINDS)[number];

export const DISCOVERY_OPEN_KINDS = [
  "album",
  "artist",
  "finding",
  "galaxy",
  "label",
  "mixtape",
] as const;
export type DiscoveryOpenKind = (typeof DISCOVERY_OPEN_KINDS)[number];

export const DISCOVERY_SIMILAR_KINDS = ["artist", "finding"] as const;
export type DiscoverySimilarKind = (typeof DISCOVERY_SIMILAR_KINDS)[number];

export const DISCOVERY_SERVICES = [
  "apple",
  "deezer",
  "mixcloud",
  "soundcloud",
  "spotify",
  "youtube",
] as const;
export type DiscoveryService = (typeof DISCOVERY_SERVICES)[number];

export type DiscoveryMetadata =
  | { kind: DiscoveryQueryKind }
  | { kind: DiscoveryExampleKind }
  | { kind: DiscoveryOpenKind }
  | { kind: DiscoverySimilarKind }
  | { service: DiscoveryService };

const QUERY_KIND_SET = new Set<string>(DISCOVERY_QUERY_KINDS);
const EXAMPLE_KIND_SET = new Set<string>(DISCOVERY_EXAMPLE_KINDS);
const OPEN_KIND_SET = new Set<string>(DISCOVERY_OPEN_KINDS);
const SIMILAR_KIND_SET = new Set<string>(DISCOVERY_SIMILAR_KINDS);
const SERVICE_SET = new Set<string>(DISCOVERY_SERVICES);
const EVENT_SET = new Set<string>(DISCOVERY_EVENTS);

function sanitizeMetadata(
  event: DiscoveryEventName,
  metadata: DiscoveryMetadata | undefined,
): DiscoveryMetadata | undefined {
  if (!metadata) {
    return undefined;
  }

  if ("service" in metadata) {
    return event === "discovery_outbound" && SERVICE_SET.has(metadata.service)
      ? { service: metadata.service }
      : undefined;
  }

  if (!("kind" in metadata)) {
    return undefined;
  }

  const { kind } = metadata;

  if (event === "discovery_search") {
    return QUERY_KIND_SET.has(kind) ? { kind: kind as DiscoveryQueryKind } : undefined;
  }

  if (event === "discovery_example") {
    return EXAMPLE_KIND_SET.has(kind) ? { kind: kind as DiscoveryExampleKind } : undefined;
  }

  if (event === "discovery_open") {
    return OPEN_KIND_SET.has(kind) ? { kind: kind as DiscoveryOpenKind } : undefined;
  }

  if (event === "discovery_similar") {
    return SIMILAR_KIND_SET.has(kind) ? { kind: kind as DiscoverySimilarKind } : undefined;
  }

  return undefined;
}

type SaEvent = {
  (event: string, metadata?: Record<string, string>): void;
  q?: unknown[];
};

type AnalyticsWindow = Window & { sa_event?: SaEvent };

/**
 * Fire one aggregate event through the already-loaded Simple Analytics tag. Never throws.
 * Never sends a key that is not in the allow-list above. A blocked or absent tag is a no-op.
 */
export function emitDiscoveryEvent(event: DiscoveryEventName, metadata?: DiscoveryMetadata): void {
  try {
    if (!EVENT_SET.has(event) || typeof window === "undefined") {
      return;
    }

    const sa = (window as AnalyticsWindow).sa_event;

    if (typeof sa !== "function") {
      return;
    }

    const payload = sanitizeMetadata(event, metadata);

    if (payload) {
      sa(event, payload as Record<string, string>);

      return;
    }

    sa(event);
  } catch {
    // Analytics must never surface. The control's own action is the product.
  }
}

/** Public previews use the `/api/preview` proxy (`src` omitted). Admin source-audio passes `src`. */
export function shouldEmitDiscoveryPreview(src?: string): boolean {
  return src === undefined;
}
