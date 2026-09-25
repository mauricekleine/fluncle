import {
  type SearchEntity,
  type SearchFilters,
  type SearchHit,
  type SearchKind,
} from "@fluncle/contracts";
import { hasTrackPageIdentity, trackPagePath } from "./track-page";

export type { SearchEntity, SearchFilters, SearchHit, SearchKind };

export type SearchEntityKind = SearchEntity["kind"];

export type SearchResponse = {
  anchor?: SearchHit;
  degraded: boolean;
  entities: SearchEntity[];
  filters?: SearchFilters;
  kind: SearchKind;
  redirect?: string;
  results: SearchHit[];
};

export const EMPTY_SEARCH: SearchResponse = {
  degraded: false,
  entities: [],
  kind: "empty",
  results: [],
};

export const MIN_QUERY_LENGTH = 2;

export const MAX_QUERY_LENGTH = 512;

export type SearchExampleIcon = "coordinate" | "sonic" | "token";

export const SEARCH_EXAMPLES = [
  { icon: "token", query: "netsky" },
  { icon: "token", query: "Hospital Records" },
  { icon: "coordinate", query: "004.7.2I" },
  { icon: "sonic", query: "tracks that sound like Nine Clouds" },
] as const satisfies readonly { icon: SearchExampleIcon; query: string }[];

export const ENTITY_GROUPS = [
  { heading: "Artists", kind: "artist" },
  { heading: "Labels", kind: "label" },
  { heading: "Albums", kind: "album" },
  { heading: "Galaxies", kind: "galaxy" },
  { heading: "Mixtapes", kind: "mixtape" },
] as const satisfies readonly { heading: string; kind: SearchEntityKind }[];

export function entityHref(entity: SearchEntity): string {
  return entity.url ?? `/${entity.kind}/${entity.slug}`;
}

export function hitHref(hit: SearchHit): { external: boolean; href: string } | undefined {
  if (hit.certified && hit.logId) {
    return { external: false, href: `/log/${hit.logId}` };
  }

  if (hasTrackPageIdentity(hit)) {
    return { external: false, href: trackPagePath(hit.trackId) };
  }

  return hit.spotifyUrl ? { external: true, href: hit.spotifyUrl } : undefined;
}

export function partitionHits(results: SearchHit[]): { findings: SearchHit[]; unlit: SearchHit[] } {
  return {
    findings: results.filter((hit) => hit.certified),
    unlit: results.filter((hit) => !hit.certified),
  };
}

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

export function searchPagePath(query?: string): string {
  const trimmed = (query ?? "").trim().slice(0, MAX_QUERY_LENGTH);

  return trimmed.length > 0 ? `/search?q=${encodeURIComponent(trimmed)}` : "/search";
}

export function searchArchiveApiPath(query: string, limit?: number): string {
  const params = new URLSearchParams({ q: query });

  if (limit !== undefined) {
    params.set("limit", String(limit));
  }

  return `/api/v1/search/archive?${params.toString()}`;
}
