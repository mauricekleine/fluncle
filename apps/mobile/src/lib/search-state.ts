import { type SearchEntity, type SearchHit } from "@fluncle/contracts/orpc";

export const MIN_QUERY_LENGTH = 2;

export function normalizeQuery(raw: string): string {
  return raw.trim();
}

export type SearchView = "idle" | "tooShort" | "loading" | "results" | "empty" | "error";

export function searchView({
  hasResults,
  isError,
  isFetching,
  query,
}: {
  hasResults: boolean;
  isError: boolean;
  isFetching: boolean;
  query: string;
}): SearchView {
  const trimmed = normalizeQuery(query);
  if (trimmed.length === 0) {
    return "idle";
  }
  if (trimmed.length < MIN_QUERY_LENGTH) {
    return "tooShort";
  }
  if (hasResults) {
    return "results";
  }
  if (isFetching) {
    return "loading";
  }
  if (isError) {
    return "error";
  }
  return "empty";
}

export type EntityGroup = { entities: SearchEntity[]; heading: string; kind: SearchEntity["kind"] };

export function partitionEntities(entities: SearchEntity[]): EntityGroup[] {
  const order: EntityGroup[] = [
    { entities: [], heading: "Artists", kind: "artist" },
    { entities: [], heading: "Labels", kind: "label" },
    { entities: [], heading: "Albums", kind: "album" },
    { entities: [], heading: "Galaxies", kind: "galaxy" },
    { entities: [], heading: "Mixtapes", kind: "mixtape" },
  ];
  for (const entity of entities) {
    const group = order.find((g) => g.kind === entity.kind);
    if (group) {
      group.entities.push(entity);
    }
  }
  return order.filter((g) => g.entities.length > 0);
}

export function entityWebPath(entity: Pick<SearchEntity, "kind" | "slug" | "url">): string {
  return entity.url ?? `/${entity.kind}/${entity.slug}`;
}

export type TrackGroup = { certified: boolean; heading: string; hits: SearchHit[] };

export function partitionTracks(results: SearchHit[]): TrackGroup[] {
  const certified: SearchHit[] = [];
  const uncertified: SearchHit[] = [];
  for (const hit of results) {
    (hit.certified ? certified : uncertified).push(hit);
  }
  const groups: TrackGroup[] = [];
  if (certified.length > 0) {
    groups.push({ certified: true, heading: "Fluncle's Findings", hits: certified });
  }
  if (uncertified.length > 0) {
    groups.push({ certified: false, heading: "Tracks", hits: uncertified });
  }
  return groups;
}
