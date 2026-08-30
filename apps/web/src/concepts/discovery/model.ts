// The shared vocabulary of the three held discovery concepts.
//
// Client-safe by construction: pure types and pure functions, no fixture import
// and no `lib/server/**` reach, so a concept route's `head`/`validateSearch` can
// use it without dragging the snapshot into the eager entry chunk
// (docs/client-bundle.md, rule 1).
//
// One normalized row feeds all three concepts. That is deliberate: the concepts
// are meant to differ in product model, information architecture, and
// interaction, so holding the DATA shape fixed is what makes the comparison read
// as a comparison rather than three different datasets.

/** The exhibit's route prefix. Every concept surface hangs off it. */
export const CONCEPTS_BASE = "/concepts";

export type ConceptId = "desk" | "front" | "run";

export type ConceptEntityKind = "album" | "artist" | "label";

/**
 * One track, however it arrived.
 *
 * `certified` is the only tier marker, and it is carried structurally rather than
 * by a label: a certified row has a `logId` and is lit, an uncertified row has
 * none and stays unlit and unnamed (DESIGN.md, The Unlit Rule).
 */
export type ConceptTrack = {
  album?: string;
  albumSlug?: string;
  appleMusicUrl?: string;
  artists: string[];
  bpm?: number;
  certified: boolean;
  coverUrl?: string;
  durationMs?: number;
  galaxy?: string;
  key?: string;
  label?: string;
  labelSlug?: string;
  logId?: string;
  note?: string;
  releaseDate?: string;
  spotifyUrl?: string;
  title: string;
  trackId: string;
  youtubeUrl?: string;
};

/** Where a row can actually be heard, in the order a listener is offered it. */
export type ListenDestination = { href: string; platform: "apple" | "spotify" | "youtube" };

export type SonicNeighbourhood = {
  anchor: ConceptTrack;
  /** Ranked by Fluncle's own cosine distance, anchor removed. */
  neighbours: ConceptTrack[];
};

export type ConceptEntity = {
  bio?: string;
  certified: boolean;
  findingCount: number;
  imageUrl?: string;
  kind: ConceptEntityKind;
  name: string;
  slug: string;
  trackCount?: number;
};

export type ConceptEntityPage = {
  catalogue: ConceptTrack[];
  entity: ConceptEntity;
  findings: ConceptTrack[];
  /** The sonic step out of this entity, when one of its findings has an anchor. */
  neighbourhood?: SonicNeighbourhood;
};

export type CaptureMeta = {
  capturedAt: string;
  catalogueRows: number;
  findingCount: number;
  productionSha: string;
  source: string;
  surfaces: string[];
};

/** The tempo bands a drum & bass selector actually reaches for. */
export const TEMPO_BANDS = [
  { id: "half", label: "85 to 145", max: 145, min: 85 },
  { id: "rolling", label: "146 to 172", max: 172.5, min: 146 },
  { id: "full", label: "173 to 177", max: 177, min: 172.5 },
  { id: "fast", label: "178 and up", max: 400, min: 177 },
] as const;

export type TempoBandId = (typeof TEMPO_BANDS)[number]["id"];

export function tempoBandOf(bpm: number | undefined): TempoBandId | undefined {
  if (bpm === undefined) {
    return undefined;
  }

  return TEMPO_BANDS.find((band) => bpm >= band.min && bpm < band.max)?.id;
}

export function listenDestinations(track: ConceptTrack): ListenDestination[] {
  const out: ListenDestination[] = [];

  if (track.spotifyUrl !== undefined) {
    out.push({ href: track.spotifyUrl, platform: "spotify" });
  }

  if (track.appleMusicUrl !== undefined) {
    out.push({ href: track.appleMusicUrl, platform: "apple" });
  }

  if (track.youtubeUrl !== undefined) {
    out.push({ href: track.youtubeUrl, platform: "youtube" });
  }

  return out;
}

export function formatDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined) {
    return undefined;
  }

  const total = Math.round(durationMs / 1000);
  const minutes = Math.floor(total / 60);

  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

export function formatBpm(bpm: number | undefined): string | undefined {
  return bpm === undefined ? undefined : `${Math.round(bpm)} BPM`;
}

export function releaseYear(releaseDate: string | undefined): string | undefined {
  return releaseDate === undefined ? undefined : releaseDate.slice(0, 4);
}

/** `Artist — Title`, the one sanctioned em dash in the whole system. */
export function billing(track: ConceptTrack): string {
  return `${track.artists.join(", ")} — ${track.title}`;
}

export function entityHref(kind: ConceptEntityKind, slug: string): string {
  return `/${kind}/${slug}`;
}

/** A stable per-row key: uncertified catalogue rows carry no id of their own. */
export function trackKey(track: ConceptTrack, index: number): string {
  return track.trackId !== "" ? track.trackId : `${track.title}-${index}`;
}
