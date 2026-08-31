// SEARCH — the shared, CLIENT-SAFE half of the surface.
//
// Fluncle's search now answers in two places: the ⌘K command dialog (the accelerator, one
// keystroke from every public page) and `/search` (the persistent, linkable, server-rendered
// results page). They are ONE search — one resolver, one ranking, one vocabulary — so
// everything that is not a rendering decision lives here, in a pure module both import.
//
// It is deliberately free of React, of `lib/server/**`, and of any I/O: the `/search` route's
// `validateSearch` / `loaderDeps` / `head` are EAGERLY bundled into the client entry chunk
// (docs/client-bundle.md, Rule 1, build-enforced by the `fluncle-eager-chunk-purity` gate), so
// anything they reach has to be free of the `getDb` → `@libsql/client` chain. The wire types are
// restated here rather than imported from `@fluncle/contracts` for the same reason the dialog
// restated them: a type-only shape, with no schema and no zod, is what a client needs.
//
// ── WHY THE DIALOG AND THE PAGE ARE BOTH REAL ────────────────────────────────────────────
// A palette is the fastest way to reach one known thing and the worst way to hold a result set:
// it has no URL, so it cannot be shared, reloaded, or walked back to. A page is the opposite. So
// the dialog stays the accelerator and HANDS OFF to the page ({@link searchPagePath}) rather than
// being replaced by it, and the page carries the whole query state in its URL.

import { hasTrackPageIdentity, trackPagePath } from "./track-page";

/** The five graph nodes that have a page of their own — a jump target, not a result row. */
export type SearchEntityKind = "album" | "artist" | "galaxy" | "label" | "mixtape";

/** An entity the query named or prefixed. `url` overrides the `/<kind>/<slug>` default. */
export type SearchEntity = {
  imageUrl?: string;
  kind: SearchEntityKind;
  name: string;
  slug: string;
  url?: string;
};

/**
 * One archive row as search returns it — and the object that carries THE CATALOGUE RULE.
 *
 * `certified` is the one bit a renderer needs to pick the register: a finding carries its
 * coordinate and lights gold, a track Fluncle never certified stays cold and links OUT. The
 * uncertified tier is never named, never badged, never given a noun (DESIGN.md's Unlit Rule).
 */
export type SearchHit = {
  album?: string;
  albumImageUrl?: string;
  artists: string[];
  bpm?: number;
  certified: boolean;
  galaxy?: string;
  key?: string;
  label?: string;
  logId?: string;
  releaseDate?: string;
  spotifyUrl?: string;
  title: string;
  trackId: string;
};

/** What the language tier understood, echoed back so a reader can see it and correct it. */
export type SearchFilters = {
  album?: string;
  artist?: string;
  bpmMax?: number;
  bpmMin?: number;
  key?: string;
  label?: string;
  soundsLike?: string;
  soundsLikeArtists?: string[];
  text?: string;
  yearMax?: number;
  yearMin?: number;
};

/** Which of the resolver's tiers answered. Not a debug detail: it decides what renders. */
export type SearchKind = "coordinate" | "empty" | "entity" | "filters" | "sonic" | "token";

/** The whole answer, exactly as `search_archive` puts it on the wire. */
export type SearchResponse = {
  anchor?: SearchHit;
  degraded: boolean;
  entities: SearchEntity[];
  filters?: SearchFilters;
  kind: SearchKind;
  redirect?: string;
  results: SearchHit[];
};

/** The answer shape for a query nobody asked — and the value every miss folds to. */
export const EMPTY_SEARCH: SearchResponse = {
  degraded: false,
  entities: [],
  kind: "empty",
  results: [],
};

/** The floor the server also enforces — below it there is nothing to go on yet. */
export const MIN_QUERY_LENGTH = 2;

/** The ceiling the `search_archive` contract binds `q` to. A longer URL is trimmed, never sent. */
export const MAX_QUERY_LENGTH = 512;

/** Which glyph an example carries — the tier it teaches, not a label anyone reads. */
export type SearchExampleIcon = "coordinate" | "sonic" | "token";

/**
 * The four example queries, and they are a lesson disguised as a shortcut: a coordinate, a bare
 * artist name, a label, and a sonic reference. Between them they walk the resolver without ever
 * explaining that there are tiers.
 *
 * ── EVERY ONE OF THEM IS DETERMINISTIC, AND THAT IS THE CONTRACT ─────────────────────────────
 * They are REAL: each returns rows against the live archive, because an example query that finds
 * nothing teaches the opposite of what it is for. The only way to keep that true is for every one
 * of them to be answered by a tier that does not involve a model — a coordinate lookup, an indexed
 * entity read, FTS5, or the anchored vector scan (docs/search.md, tiers 1–3½).
 *
 * The list used to carry a natural-language filter query ("tracks in A minor above 170 bpm") to
 * teach the LLM tier. It came out because the LLM tier is NONDETERMINISTIC BY CONSTRUCTION: the
 * same sentence parsed once to `{bpmMin, key}` and returned rows, and once to `{bpmMin, key, text:
 * "tracks"}` — where the stray leftover word narrowed the result set to nothing. A worked example
 * that is a coin flip is not a worked example, and this list is the one place in the product that
 * promises otherwise. The language tier is still there and still answers; it is simply not
 * something to advertise with a query that might come back empty.
 *
 * Enforced on both sides, so the promise cannot rot silently:
 *   - OFFLINE, in the deploy gate — `search-examples.integration.test.ts` runs every query below
 *     against a real migrated database with the model stubbed OFF, and fails any that comes back
 *     degraded, empty, or resolved by the wrong tier.
 *   - IN PRODUCTION, after every deploy — `scripts/post-deploy-probe.ts` derives one target per
 *     example and fails the probe if the live archive answers any of them with nothing.
 *
 * ONE owner, three consumers: the palette's empty state, the front door's band, and `/search`'s
 * zero state.
 */
export const SEARCH_EXAMPLES = [
  { icon: "token", query: "netsky" },
  { icon: "token", query: "Hospital Records" },
  { icon: "coordinate", query: "004.7.2I" },
  { icon: "sonic", query: "tracks that sound like Nine Clouds" },
] as const satisfies readonly { icon: SearchExampleIcon; query: string }[];

/**
 * The graph nodes that HAVE a page, in the order they render — and the order a reader means,
 * because a name is most often a person. The heading names the KIND, which it is allowed to do
 * because all five are named objects in Fluncle's world (unlike the uncertified tracks, which get
 * no heading at all).
 */
export const ENTITY_GROUPS = [
  { heading: "Artists", kind: "artist" },
  { heading: "Labels", kind: "label" },
  { heading: "Albums", kind: "album" },
  { heading: "Galaxies", kind: "galaxy" },
  { heading: "Mixtapes", kind: "mixtape" },
] as const satisfies readonly { heading: string; kind: SearchEntityKind }[];

/** The page an entity IS — its own `url` when it carries one, else the `/<kind>/<slug>` default. */
export function entityHref(entity: SearchEntity): string {
  return entity.url ?? `/${entity.kind}/${entity.slug}`;
}

/**
 * Where a result row goes, for both surfaces that render one — the palette and the `/search` page
 * read this, so they cannot disagree about where a result leads.
 *
 * A finding goes to its coordinate. A track Fluncle never certified goes to its own
 * `/track/<trackId>` destination, where its record, its imprint, its tempo, every service that
 * carries it, and what sits close to it in sound are gathered — a result stays INSIDE the archive
 * rather than ejecting the reader to a streaming tab mid-search. There is still no `/log` page for
 * somewhere he has not been, and this is not one: the destination carries no coordinate and names
 * no tier (docs/track-destination.md).
 *
 * A row the destination would refuse — one the archive cannot name — falls back to its off-site
 * anchor, and a row with neither is not a destination at all, so the renderer leaves it as text.
 */
export function hitHref(hit: SearchHit): { external: boolean; href: string } | undefined {
  if (hit.certified && hit.logId) {
    return { external: false, href: `/log/${hit.logId}` };
  }

  if (hasTrackPageIdentity(hit)) {
    return { external: false, href: trackPagePath(hit.trackId) };
  }

  return hit.spotifyUrl ? { external: true, href: hit.spotifyUrl } : undefined;
}

/**
 * The two registers, partitioned once. The server already ranks certified first; the split is what
 * lets each block carry its own heading (or, for a bare unlit list, none — a heading over the only
 * content on screen would exist purely to name the tier).
 */
export function partitionHits(results: SearchHit[]): { findings: SearchHit[]; unlit: SearchHit[] } {
  return {
    findings: results.filter((hit) => hit.certified),
    unlit: results.filter((hit) => !hit.certified),
  };
}

/**
 * The chips for what the language tier understood. `renderKey` is injected rather than imported so
 * this module stays free of the key-notation context: the caller passes the reader's own notation.
 */
export function filterChips(filters: SearchFilters, renderKey: (key: string) => string): string[] {
  return [
    filters.artist && `artist: ${filters.artist}`,
    filters.label && `label: ${filters.label}`,
    filters.album && `album: ${filters.album}`,
    filters.soundsLikeArtists &&
      filters.soundsLikeArtists.length > 0 &&
      `sounds like: ${filters.soundsLikeArtists.join(", ")}`,
    filters.key && `key: ${renderKey(filters.key)}`,
    filters.bpmMin !== undefined && `bpm ≥ ${filters.bpmMin}`,
    filters.bpmMax !== undefined && `bpm ≤ ${filters.bpmMax}`,
    filters.yearMin !== undefined && `from ${filters.yearMin}`,
    filters.yearMax !== undefined && `to ${filters.yearMax}`,
    filters.text && `“${filters.text}”`,
  ].filter((chip): chip is string => Boolean(chip));
}

/**
 * THE PERSISTENT SURFACE'S URL, and the one place it is built.
 *
 * The whole query state is a single param, because the resolver's whole query state IS a single
 * string: a coordinate, a name, a sentence, and a sonic reference all arrive as `q` and are told
 * apart by the tiers, never by the caller. So a shared link, a cold reload, and the back button
 * all carry everything, and no consumer has to know which tier will answer.
 *
 * A blank query is the zero state, which is a real destination (the examples live there), so it
 * gets the bare path rather than an empty param.
 */
export function searchPagePath(query?: string): string {
  const trimmed = (query ?? "").trim().slice(0, MAX_QUERY_LENGTH);

  return trimmed.length > 0 ? `/search?q=${encodeURIComponent(trimmed)}` : "/search";
}

/** The public read behind both doors. One op, one URL builder, so the two cannot drift. */
export function searchArchiveApiPath(query: string, limit?: number): string {
  const params = new URLSearchParams({ q: query });

  if (limit !== undefined) {
    params.set("limit", String(limit));
  }

  return `/api/v1/search/archive?${params.toString()}`;
}
