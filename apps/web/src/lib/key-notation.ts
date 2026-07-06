// The admin's key-display preference: DJs mix harmonically by the Camelot wheel, so
// the operator can flip every admin key readout from musical scales ("F major") to
// Camelot notation ("7B") to line up a mixtape faster. A per-operator CLIENT pref —
// it lives in localStorage, no backend.
//
// useSyncExternalStore over module state (the same singleton shape as
// preview-player.ts) keeps this a plain store rather than a context threaded through
// the admin tree. SSR-safe: the server snapshot and the first client render both read
// the default ("scales"), and localStorage is only read once a component subscribes
// (post-mount), so there is no hydration mismatch.

import { useCallback, useSyncExternalStore } from "react";

export const KEY_NOTATIONS = ["scales", "camelot"] as const;
export type KeyNotation = (typeof KEY_NOTATIONS)[number];

const DEFAULT_NOTATION: KeyNotation = "scales";
const STORAGE_KEY = "fluncle.admin.key-notation";

// Pitch class (0 = C … 11 = B) for every note spelling we might see. Enrichment
// writes sharps ("C# major"); accept flats too so a hand-entered or externally
// sourced key still resolves.
const PITCH_CLASS: Record<string, number> = {
  A: 9,
  "A#": 10,
  Ab: 8,
  "A♭": 8,
  "A♯": 10,
  B: 11,
  "B#": 0,
  Bb: 10,
  "B♭": 10,
  "B♯": 0,
  C: 0,
  "C#": 1,
  Cb: 11,
  "C♭": 11,
  "C♯": 1,
  D: 2,
  "D#": 3,
  Db: 1,
  "D♭": 1,
  "D♯": 3,
  E: 4,
  "E#": 5,
  Eb: 3,
  "E♭": 3,
  "E♯": 5,
  F: 5,
  "F#": 6,
  Fb: 4,
  "F♭": 4,
  "F♯": 6,
  G: 7,
  "G#": 8,
  Gb: 6,
  "G♭": 6,
  "G♯": 8,
};

// The Camelot wheel, indexed by pitch class. `B` = major (outer ring), `A` = minor
// (inner ring). E.g. C major → 8B, A minor → 8A, F major → 7B, D minor → 7A,
// G minor → 6A.
const CAMELOT_MAJOR: Record<number, string> = {
  0: "8B", // C
  1: "3B", // C#/Db
  10: "6B", // A#/Bb
  11: "1B", // B
  2: "10B", // D
  3: "5B", // D#/Eb
  4: "12B", // E
  5: "7B", // F
  6: "2B", // F#/Gb
  7: "9B", // G
  8: "4B", // G#/Ab
  9: "11B", // A
};
const CAMELOT_MINOR: Record<number, string> = {
  0: "5A", // C
  1: "12A", // C#/Db
  10: "3A", // A#/Bb
  11: "10A", // B
  2: "7A", // D
  3: "2A", // D#/Eb
  4: "9A", // E
  5: "4A", // F
  6: "11A", // F#/Gb
  7: "6A", // G
  8: "1A", // G#/Ab
  9: "8A", // A
};

// Pure display helper. `scales` returns the key verbatim; `camelot` maps a parsed
// "<note> <major|minor>" to its wheel code. Anything that doesn't parse (unknown,
// empty, or an odd spelling) renders as-is — never throws, never blanks a real value.
export function formatKey(key: string | undefined | null, notation: KeyNotation): string {
  if (!key) {
    return "";
  }
  if (notation === "scales") {
    return key;
  }

  const match = /^\s*([A-Ga-g][#♯b♭]?)\s+(major|minor|maj|min)\s*$/.exec(key);
  const rawNote = match?.[1];
  const quality = match?.[2];
  if (!rawNote || !quality) {
    return key;
  }

  const note = rawNote.charAt(0).toUpperCase() + rawNote.slice(1);
  const pitchClass = PITCH_CLASS[note];
  if (pitchClass === undefined) {
    return key;
  }

  const isMinor = quality.toLowerCase().startsWith("min");
  return (isMinor ? CAMELOT_MINOR : CAMELOT_MAJOR)[pitchClass] ?? key;
}

let notation: KeyNotation = DEFAULT_NOTATION;
let hydrated = false;
const listeners = new Set<() => void>();

function emit(next: KeyNotation): void {
  notation = next;
  for (const listener of listeners) {
    listener();
  }
}

function readStored(): KeyNotation {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "camelot" ? "camelot" : "scales";
  } catch {
    return DEFAULT_NOTATION;
  }
}

function subscribe(listener: () => void): () => void {
  // The first subscription (an effect, so post-mount) adopts the stored preference —
  // keeping the initial render on the default so hydration matches the server.
  if (!hydrated) {
    hydrated = true;
    const stored = readStored();
    if (stored !== notation) {
      emit(stored);
    }
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setKeyNotation(next: KeyNotation): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // A private-mode / disabled-storage failure just keeps the pref in-memory.
  }
  emit(next);
}

export function useKeyNotation(): {
  notation: KeyNotation;
  setNotation: (next: KeyNotation) => void;
} {
  const current = useSyncExternalStore(
    subscribe,
    () => notation,
    () => DEFAULT_NOTATION,
  );

  return { notation: current, setNotation: useCallback(setKeyNotation, []) };
}
