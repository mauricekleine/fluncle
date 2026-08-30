// The concepts' single read of the committed real-data snapshot.
//
// SERVER-ONLY. Every caller reaches it through a dynamic `import()` inside a
// `createServerFn().handler()` body, so the snapshot never touches a route's
// eager chunk (docs/client-bundle.md).
//
// The snapshot is captured by `scripts/capture-concept-fixture.ts` from Fluncle's
// own public, unauthenticated API. Nothing here invents a track, a coordinate, a
// count, or a listening destination: a field the capture did not carry is absent,
// and every surface renders around the absence rather than filling it.

import catalogueJson from "./fixture/catalogue.json" with { type: "json" };
import entitiesJson from "./fixture/entities.json" with { type: "json" };
import findingsJson from "./fixture/findings.json" with { type: "json" };
import freshJson from "./fixture/fresh.json" with { type: "json" };
import metaJson from "./fixture/meta.json" with { type: "json" };
import neighboursJson from "./fixture/neighbours.json" with { type: "json" };
import {
  type CaptureMeta,
  type ConceptEntity,
  type ConceptEntityKind,
  type ConceptEntityPage,
  type ConceptTrack,
  type SonicNeighbourhood,
  tempoBandOf,
} from "./model";

type RawRecord = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function names(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * One row shape out of three input shapes. A galaxy arrives as an object on the
 * findings feed and as a bare name on a search hit; both collapse to the name.
 */
function toTrack(raw: RawRecord): ConceptTrack {
  const galaxy = raw.galaxy;
  const logId = str(raw.logId);

  return {
    album: str(raw.album),
    albumSlug: str(raw.albumSlug),
    appleMusicUrl: str(raw.appleMusicUrl),
    artists: names(raw.artists),
    bpm: num(raw.bpm),
    certified: logId !== undefined,
    coverUrl: str(raw.albumImageUrl) ?? str(raw.coverImageUrl),
    durationMs: num(raw.durationMs),
    galaxy: typeof galaxy === "string" ? galaxy : str((galaxy as RawRecord | undefined)?.name),
    key: str(raw.key),
    label: str(raw.label),
    labelSlug: str(raw.labelSlug),
    logId,
    note: str(raw.note),
    releaseDate: str(raw.releaseDate),
    spotifyUrl: str(raw.spotifyUrl),
    title: str(raw.title) ?? "",
    trackId: str(raw.trackId) ?? "",
    youtubeUrl: str(raw.youtubeUrl),
  };
}

/** A mixtape is a checkpoint, not a find: the concepts read findings only. */
const FINDINGS: ConceptTrack[] = (findingsJson as RawRecord[])
  .filter((row) => row.type !== "mixtape")
  .map(toTrack);

const CATALOGUE: ConceptTrack[] = (catalogueJson as RawRecord[]).map(toTrack);

const FRESH_TRACKS: ConceptTrack[] = ((freshJson as RawRecord).tracks as RawRecord[]).map(toTrack);

export type FreshRecord = {
  artists: string[];
  coverUrl?: string;
  name: string;
  releaseDate?: string;
  slug: string;
};

const FRESH_RECORDS: FreshRecord[] = ((freshJson as RawRecord).albums as RawRecord[]).map(
  (raw) => ({
    artists: names(raw.artists),
    coverUrl: str(raw.coverImageUrl),
    name: str(raw.name) ?? "",
    releaseDate: str(raw.releaseDate),
    slug: str(raw.slug) ?? "",
  }),
);

export const CAPTURE: CaptureMeta = metaJson as CaptureMeta;

/** The release window the fresh read actually covered, in days. */
export const FRESH_WINDOW_DAYS: number = num((freshJson as RawRecord).windowDays) ?? 30;

export function allFindings(): ConceptTrack[] {
  return FINDINGS;
}

export function allCatalogue(): ConceptTrack[] {
  return CATALOGUE;
}

export function freshTracks(): ConceptTrack[] {
  return FRESH_TRACKS;
}

export function freshRecords(): FreshRecord[] {
  return FRESH_RECORDS;
}

export function findingByLogId(logId: string): ConceptTrack | undefined {
  return FINDINGS.find((finding) => finding.logId === logId);
}

/** The coordinates the capture holds a real sonic ranking for. */
export function sonicAnchorLogIds(): string[] {
  return Object.keys(neighboursJson as RawRecord);
}

/**
 * Fluncle's own "sounds like" answer for one coordinate, captured from the
 * production sonic tier. The anchor is dropped from its own ranking — a track is
 * trivially nearest itself, and the reader asked what is NEXT to it.
 */
export function neighbourhoodOf(logId: string): SonicNeighbourhood | undefined {
  const raw = (neighboursJson as Record<string, RawRecord | undefined>)[logId];
  const anchor = findingByLogId(logId);

  if (raw === undefined || anchor === undefined) {
    return undefined;
  }

  const neighbours = (raw.results as RawRecord[])
    .map(toTrack)
    .filter((track) => track.title !== anchor.title || track.artists[0] !== anchor.artists[0]);

  return neighbours.length === 0 ? undefined : { anchor, neighbours };
}

/** The nearest anchored finding to a starting point, so any seed can step out. */
export function nearestAnchor(seed: ConceptTrack | undefined): SonicNeighbourhood | undefined {
  const anchors = sonicAnchorLogIds();

  if (seed?.logId !== undefined && anchors.includes(seed.logId)) {
    return neighbourhoodOf(seed.logId);
  }

  const band = tempoBandOf(seed?.bpm);
  const hoods = anchors
    .map((logId) => neighbourhoodOf(logId))
    .filter((hood): hood is SonicNeighbourhood => hood !== undefined);

  return (
    hoods.find((hood) => hood.anchor.label !== undefined && hood.anchor.label === seed?.label) ??
    hoods.find((hood) => tempoBandOf(hood.anchor.bpm) === band) ??
    hoods[0]
  );
}

type RawEntityEntry = {
  identity: RawRecord;
  kind: ConceptEntityKind;
  tracks: { results: RawRecord[] };
};

function toEntity(kind: ConceptEntityKind, identity: RawRecord): ConceptEntity {
  return {
    bio: str(identity.bio),
    certified: identity.certified === true,
    findingCount: num(identity.findingCount) ?? 0,
    imageUrl: str(identity.imageUrl) ?? str(identity.logoImageUrl) ?? str(identity.coverImageUrl),
    kind,
    name: str(identity.name) ?? "",
    slug: str(identity.slug) ?? "",
    trackCount: num(identity.trackCount),
  };
}

export function conceptEntities(): ConceptEntity[] {
  return Object.values(entitiesJson as Record<string, RawEntityEntry>).map((entry) =>
    toEntity(entry.kind, entry.identity),
  );
}

/**
 * A direct arrival on one graph node: who it is, the findings Fluncle certified
 * there, the rest of what he holds, and the sonic step out. Findings lead;
 * everything below them stays unlit and unnamed (The Unlit Rule).
 */
export function entityPage(kind: ConceptEntityKind, slug: string): ConceptEntityPage | undefined {
  const entry = (entitiesJson as Record<string, RawEntityEntry | undefined>)[`${kind}:${slug}`];

  if (entry === undefined) {
    return undefined;
  }

  const rows = entry.tracks.results.map(toTrack);
  // The entity read returns lean hits; a certified one is re-hydrated from the
  // findings feed so the entity page carries the same note and chips as the feed.
  const findings = rows
    .filter((row) => row.certified)
    .map((row) => (row.logId !== undefined ? (findingByLogId(row.logId) ?? row) : row));

  return {
    catalogue: rows.filter((row) => !row.certified),
    entity: toEntity(entry.kind, entry.identity),
    findings,
    neighbourhood: nearestAnchor(findings[0]),
  };
}
