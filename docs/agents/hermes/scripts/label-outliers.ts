import { createHash } from "node:crypto";

export const EMBEDDING_DIMENSIONS = 1024;

export const LABEL_OUTLIER_THRESHOLDS = {
  artistSupportCeiling: 3,
  madScale: 1.4826,
  minLabelUnits: 8,
  sigmaFloor: 0.02,
  typicalQuantile: 0.25,
  zCeiling: -4,
} as const;

export type LabelOutlierThresholds = {
  artistSupportCeiling: number;
  madScale: number;
  minLabelUnits: number;
  sigmaFloor: number;
  typicalQuantile: number;
  zCeiling: number;
};

export type OutlierTrack = {
  albumId: string | null;
  trackId: string;
  vector: Float32Array;
};

export type LabelGroup = {
  labelId: string | null;
  tracks: readonly OutlierTrack[];
};

export type OutlierReference = "catalogue" | "label";

export type ScoredUnit = {
  albumId: string | null;
  artistSupport: number;
  fingerprint: string;
  labelId: string | null;
  reference: OutlierReference;
  referenceMedian: number;
  score: number;
  singleTrackId: string | null;
  trackCount: number;
  trackIds: string[];
  unitId: string;
  z: number;
};

export type LabelOutlierRun = {
  flagged: ScoredUnit[];
  labelsScored: number;
  tracksScored: number;
  unitsScored: number;
};

type UnitAccumulator = {
  albumId: string | null;
  catalogueScore: number;
  labelId: string | null;
  labelScore: number | null;
  trackIds: string[];
  unitId: string;
};

export function unitIdFor(labelId: string | null, albumId: string | null, trackId: string): string {
  return albumId === null ? `track:${trackId}` : `album:${albumId}:${labelId ?? "none"}`;
}

export function unitFingerprint(labelId: string | null, trackIds: readonly string[]): string {
  return createHash("sha256")
    .update(`${labelId ?? ""}|${[...trackIds].sort().join(",")}`)
    .digest("hex")
    .slice(0, 32);
}

export function addInto(sum: Float64Array, vector: Float32Array, sign = 1): void {
  for (let index = 0; index < sum.length; index += 1) {
    sum[index] = (sum[index] ?? 0) + sign * (vector[index] ?? 0);
  }
}

export function normalized(sum: Float64Array): Float64Array | null {
  let norm = 0;

  for (const value of sum) {
    norm += value * value;
  }

  if (!(norm > 0)) {
    return null;
  }

  const scale = 1 / Math.sqrt(norm);
  const out = new Float64Array(sum.length);

  for (let index = 0; index < sum.length; index += 1) {
    out[index] = (sum[index] ?? 0) * scale;
  }

  return out;
}

function unitVector(vector: Float32Array): Float32Array {
  let norm = 0;

  for (const value of vector) {
    norm += value * value;
  }

  if (!(norm > 0)) {
    return vector;
  }

  const scale = 1 / Math.sqrt(norm);
  const out = new Float32Array(vector.length);

  for (let index = 0; index < vector.length; index += 1) {
    out[index] = (vector[index] ?? 0) * scale;
  }

  return out;
}

export function dot(a: Float32Array, b: Float64Array): number {
  let total = 0;

  for (let index = 0; index < a.length; index += 1) {
    total += (a[index] ?? 0) * (b[index] ?? 0);
  }

  return total;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1
    ? (sorted[middle] ?? Number.NaN)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) {
    return Number.NaN;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;

  return (sorted[lower] ?? 0) * (1 - weight) + (sorted[upper] ?? 0) * weight;
}

export function robustSpread(
  values: readonly number[],
  thresholds: Pick<LabelOutlierThresholds, "madScale" | "sigmaFloor">,
): { center: number; sigma: number } {
  const center = median(values);
  const mad = median(values.map((value) => Math.abs(value - center)));

  return { center, sigma: Math.max(mad * thresholds.madScale, thresholds.sigmaFloor) };
}

function meanCosine(vectors: readonly Float32Array[], centroid: Float64Array | null): number {
  if (!centroid || vectors.length === 0) {
    return Number.NaN;
  }

  let total = 0;

  for (const vector of vectors) {
    total += dot(vector, centroid);
  }

  return total / vectors.length;
}

export function isDrumAndBassTagged(discogsStyles: string | null): boolean {
  if (!discogsStyles) {
    return false;
  }

  try {
    const parsed: unknown = JSON.parse(discogsStyles);

    return (
      Array.isArray(parsed) && parsed.some((style) => style === "Drum n Bass" || style === "Jungle")
    );
  } catch {
    return false;
  }
}

export type ScoreCatalogueInput = {
  artistsByTrack: ReadonlyMap<string, readonly string[]>;
  dnbTaggedAlbumIds: ReadonlySet<string>;
  globalSum: Float64Array;
  groups: Iterable<LabelGroup>;
  thresholds?: LabelOutlierThresholds;
};

type GroupedUnit = { albumId: string | null; trackIds: string[]; vectors: Float32Array[] };

type Spread = { center: number; sigma: number };

type ScoringState = {
  typicality: Map<string, number>;
  unitOfTrack: Map<string, string>;
};

function groupUnits(
  group: LabelGroup,
  globalCentroid: Float64Array | null,
  state: ScoringState,
): { grouped: Map<string, GroupedUnit>; labelSum: Float64Array } {
  const grouped = new Map<string, GroupedUnit>();
  const labelSum = new Float64Array(EMBEDDING_DIMENSIONS);

  for (const track of group.tracks) {
    const vector = unitVector(track.vector);
    const unitId = unitIdFor(group.labelId, track.albumId, track.trackId);
    const entry = grouped.get(unitId) ?? { albumId: track.albumId, trackIds: [], vectors: [] };

    entry.vectors.push(vector);
    entry.trackIds.push(track.trackId);
    grouped.set(unitId, entry);
    addInto(labelSum, vector);
    state.unitOfTrack.set(track.trackId, unitId);

    if (globalCentroid) {
      state.typicality.set(track.trackId, dot(vector, globalCentroid));
    }
  }

  return { grouped, labelSum };
}

function leaveOut(total: Float64Array, part: Float64Array): Float64Array | null {
  const rest = new Float64Array(total);

  for (let index = 0; index < part.length; index += 1) {
    rest[index] = (rest[index] ?? 0) - (part[index] ?? 0);
  }

  return normalized(rest);
}

function scoreGroup(
  group: LabelGroup,
  globalSum: Float64Array,
  globalCentroid: Float64Array | null,
  thresholds: LabelOutlierThresholds,
  state: ScoringState,
): { labelScores: number[] | null; units: UnitAccumulator[] } {
  const { grouped, labelSum } = groupUnits(group, globalCentroid, state);
  const labelRelative = group.labelId !== null && grouped.size >= thresholds.minLabelUnits;
  const labelScores: number[] = [];
  const units: UnitAccumulator[] = [];

  for (const [unitId, entry] of grouped) {
    const unitSum = new Float64Array(EMBEDDING_DIMENSIONS);

    for (const vector of entry.vectors) {
      addInto(unitSum, vector);
    }

    const labelScore = labelRelative
      ? meanCosine(entry.vectors, leaveOut(labelSum, unitSum))
      : null;

    if (labelScore !== null && Number.isFinite(labelScore)) {
      labelScores.push(labelScore);
    }

    units.push({
      albumId: entry.albumId,
      catalogueScore: meanCosine(entry.vectors, leaveOut(globalSum, unitSum)),
      labelId: group.labelId,
      labelScore,
      trackIds: entry.trackIds,
      unitId,
    });
  }

  return { labelScores: labelRelative ? labelScores : null, units };
}

function typicalTracksByArtist(
  artistsByTrack: ReadonlyMap<string, readonly string[]>,
  typicality: ReadonlyMap<string, number>,
  quantileAt: number,
): Map<string, string[]> {
  const typicalFloor = quantile([...typicality.values()], quantileAt);
  const byArtist = new Map<string, string[]>();

  for (const [trackId, artistIds] of artistsByTrack) {
    const value = typicality.get(trackId);

    if (value === undefined || value < typicalFloor) {
      continue;
    }

    for (const artistId of artistIds) {
      const list = byArtist.get(artistId) ?? [];
      list.push(trackId);
      byArtist.set(artistId, list);
    }
  }

  return byArtist;
}

function artistSupportFor(
  unit: UnitAccumulator,
  artistsByTrack: ReadonlyMap<string, readonly string[]>,
  typicalByArtist: ReadonlyMap<string, readonly string[]>,
  unitOfTrack: ReadonlyMap<string, string>,
): number {
  const unitArtists = new Set(
    unit.trackIds.flatMap((trackId) => artistsByTrack.get(trackId) ?? []),
  );
  let support = 0;

  for (const artistId of unitArtists) {
    const elsewhere = (typicalByArtist.get(artistId) ?? []).filter(
      (trackId) => unitOfTrack.get(trackId) !== unit.unitId,
    ).length;

    support = Math.max(support, elsewhere);
  }

  return support;
}

function referenceFor(
  unit: UnitAccumulator,
  labelSpreads: ReadonlyMap<string | null, Spread>,
  catalogueSpread: Spread,
): { reference: OutlierReference; score: number; spread: Spread } {
  const labelSpread = unit.labelScore === null ? undefined : labelSpreads.get(unit.labelId);

  if (labelSpread && unit.labelScore !== null) {
    return { reference: "label", score: unit.labelScore, spread: labelSpread };
  }

  return { reference: "catalogue", score: unit.catalogueScore, spread: catalogueSpread };
}

export function scoreCatalogue(input: ScoreCatalogueInput): LabelOutlierRun {
  const thresholds = input.thresholds ?? LABEL_OUTLIER_THRESHOLDS;
  const globalCentroid = normalized(input.globalSum);
  const state: ScoringState = { typicality: new Map(), unitOfTrack: new Map() };
  const units: UnitAccumulator[] = [];
  const labelSpreads = new Map<string | null, Spread>();
  let labelsScored = 0;

  for (const group of input.groups) {
    if (group.tracks.length === 0) {
      continue;
    }

    labelsScored += 1;

    const scored = scoreGroup(group, input.globalSum, globalCentroid, thresholds, state);
    units.push(...scored.units);

    if (scored.labelScores) {
      labelSpreads.set(group.labelId, robustSpread(scored.labelScores, thresholds));
    }
  }

  const catalogueSpread = robustSpread(
    units.map((unit) => unit.catalogueScore).filter((score) => Number.isFinite(score)),
    thresholds,
  );
  const typicalByArtist = typicalTracksByArtist(
    input.artistsByTrack,
    state.typicality,
    thresholds.typicalQuantile,
  );
  const flagged: ScoredUnit[] = [];

  for (const unit of units) {
    const { reference, score, spread } = referenceFor(unit, labelSpreads, catalogueSpread);
    const z = (score - spread.center) / spread.sigma;

    if (!Number.isFinite(z) || z > thresholds.zCeiling) {
      continue;
    }

    const tagged = unit.albumId !== null && input.dnbTaggedAlbumIds.has(unit.albumId);
    const artistSupport = artistSupportFor(
      unit,
      input.artistsByTrack,
      typicalByArtist,
      state.unitOfTrack,
    );

    if (tagged || artistSupport >= thresholds.artistSupportCeiling) {
      continue;
    }

    flagged.push({
      albumId: unit.albumId,
      artistSupport,
      fingerprint: unitFingerprint(unit.labelId, unit.trackIds),
      labelId: unit.labelId,
      reference,
      referenceMedian: spread.center,
      score,
      singleTrackId: unit.albumId === null ? (unit.trackIds[0] ?? null) : null,
      trackCount: unit.trackIds.length,
      trackIds: unit.trackIds,
      unitId: unit.unitId,
      z,
    });
  }

  flagged.sort((left, right) => left.z - right.z || left.unitId.localeCompare(right.unitId));

  return { flagged, labelsScored, tracksScored: state.unitOfTrack.size, unitsScored: units.length };
}
