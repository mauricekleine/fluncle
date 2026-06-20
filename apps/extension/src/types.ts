// The shapes Fluncle Lens passes between its surfaces — the content script, the
// popup, and the background service worker. The web app's full DTO lives in
// `@fluncle/contracts` (TrackListItem); the extension only needs the handful of
// fields the hover card and popup actually render, so we mirror just those here
// rather than pulling the web package (and its DOM/TanStack deps) into the bundle.

/**
 * A finding's kind. A coordinate resolves to either a single track (the common
 * case) or one of Fluncle's own mixtapes (`F` in the middle slot) — the two render
 * a different facts line, so the kind rides along with the metadata.
 */
export type FindingKind = "mixtape" | "track";

/**
 * The finding metadata Fluncle Lens shows, narrowed from the public API's track or
 * mixtape DTO. Track-only fields (`album`, `bpm`, `key`, `spotifyUrl`, …) sit beside
 * mixtape-only fields (`memberCount`) — `kind` says which set is populated.
 */
export type FindingMeta = {
  album?: string;
  albumImageUrl?: string;
  artists?: string[];
  bpm?: number;
  /** ISO date Fluncle found it (track addedAt, or a mixtape's recorded/found date). */
  foundAt?: string;
  key?: string;
  kind: FindingKind;
  label?: string;
  logId?: string;
  /** Mixtape only: how many bangers ride in the set. */
  memberCount?: number;
  spotifyUrl?: string;
  title?: string;
  webUrl?: string;
  year?: string;
};

/** How a metadata fetch resolved, so every surface can render the same three states. */
export type FetchState = "error" | "loading" | "ready";

/** A finding the lens surfaced on the page, with whatever metadata has loaded. */
export type DetectedFinding = {
  /** The bare Log ID, e.g. `007.0.0Z`. */
  id: string;
  meta?: FindingMeta;
  /** The coordinate exactly as written on the page. */
  raw: string;
  state: FetchState;
};

// ── Messaging ────────────────────────────────────────────────────────────────
// The popup asks the active tab's content script what it found; the content script
// answers with its live list. The content script also pings the background worker
// to keep the toolbar badge in sync. Keep these tags string-literal so the union
// narrows in the switch handlers.

/** popup → content script: "what did you find on this page?" */
export type GetFindingsMessage = { type: "lens:get-findings" };

/** content script → popup: the current list. */
export type FindingsResponse = { findings: DetectedFinding[] };

/** content script → background: "set the badge to this count for my tab." */
export type BadgeMessage = { count: number; type: "lens:badge" };

export type LensMessage = BadgeMessage | GetFindingsMessage;
