// The metadata model attached to each synthetic track vector. Mirrors the FINAL
// immutable-only design: the INDEXED, filterable fields are immutable musical
// facts (key, bpm, anchored); `certified` is a VOLATILE field carried in metadata
// but never indexed — it is returned and dropped Worker-side (the post-filter),
// never used as a Vectorize filter.
//
// Pure: no Cloudflare imports, runs under `bun test`.

import { intBetween, type Rng } from "./prng";

/** The 24 Camelot wheel keys (12 minor "A", 12 major "B"). */
export const CAMELOT_KEYS: readonly string[] = (() => {
  const keys: string[] = [];
  for (let n = 1; n <= 12; n++) {
    keys.push(`${n}A`);
    keys.push(`${n}B`);
  }
  return keys;
})();

export const BPM_MIN = 60;
export const BPM_MAX = 200;

/** Probability a synthetic track is `anchored` / `certified`. */
export const ANCHORED_P = 0.7;
export const CERTIFIED_P = 0.3;

/** Vectorize caps a vector id at 64 BYTES. Measure UTF-8 bytes, not chars. */
export const MAX_ID_BYTES = 64;

const encoder = new TextEncoder();

export function byteLength(s: string): number {
  return encoder.encode(s).length;
}

export function isIdSafe(id: string): boolean {
  return id.length > 0 && byteLength(id) <= MAX_ID_BYTES;
}

/** Stable, id-safe track id. `t-<i>` stays well under 64 bytes for 150k rows. */
export function trackId(i: number): string {
  return `t-${i}`;
}

export function centroidId(i: number): string {
  return `c-${i}`;
}

export type TrackMetadata = {
  /** INDEXED, filterable — Camelot key string. */
  key: string;
  /** INDEXED, filterable — integer bpm in [BPM_MIN, BPM_MAX]. */
  bpm: number;
  /** INDEXED, filterable — is this track anchored to a real recording. */
  anchored: boolean;
  /** NON-indexed, returned-only — the volatile field the Worker post-filters on. */
  certified: boolean;
};

export function camelotKeyFor(rng: Rng): string {
  const idx = intBetween(rng, 0, CAMELOT_KEYS.length - 1);
  // CAMELOT_KEYS is non-empty and idx is in range; fall back defensively.
  return CAMELOT_KEYS[idx] ?? "1A";
}

export function buildTrackMetadata(rng: Rng): TrackMetadata {
  return {
    anchored: rng() < ANCHORED_P,
    bpm: intBetween(rng, BPM_MIN, BPM_MAX),
    certified: rng() < CERTIFIED_P,
    key: camelotKeyFor(rng),
  };
}
