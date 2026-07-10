// The pure key ⇄ Camelot core — client-safe, side-effect-free, and importable from
// BOTH the client (`key-notation.ts`, the admin key chips) and the server (the
// mixability engine, `lib/server/mixability.ts`). It holds the canonical
// `PITCH_CLASS` spelling table + the Camelot-wheel maps and exposes a named,
// tolerant parser (`parseKey`) plus the wheel projection (`toCamelot`) so the
// server can reason about harmonic STRUCTURE (a pitch class + a mode), not just a
// display string. `key-notation.ts` re-implements its `formatKey` on top of this,
// so "what a key parses to" is written down exactly once.
//
// The parser is deliberately forgiving — enrichment writes sharps ("C# major"),
// but a hand-entered or externally sourced key might arrive flat, in `maj`/`min`
// shorthand, or with stray whitespace, and all resolve. Anything it cannot parse
// (an unknown spelling, a modal quality, empty, null) returns `null`; a caller
// treats that as "no harmonic information", never as a zero score.

/**
 * Pitch class (0 = C … 11 = B) for every note spelling we might see. Enrichment
 * writes sharps ("C# major"); flats and Unicode accidentals (♯/♭) are accepted so a
 * hand-entered or externally sourced key still resolves. Enharmonics fold to the
 * same class (Bb and A# are both 10), matching the repo's sharp convention.
 */
export const PITCH_CLASS: Record<string, number> = {
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

/**
 * The Camelot number for each pitch class on the MAJOR (outer, "B") ring, indexed by
 * pitch class. E.g. C major → 8, F major → 7, G major → 9.
 */
export const CAMELOT_MAJOR_NUMBER: Record<number, number> = {
  0: 8, // C
  1: 3, // C#/Db
  10: 6, // A#/Bb
  11: 1, // B
  2: 10, // D
  3: 5, // D#/Eb
  4: 12, // E
  5: 7, // F
  6: 2, // F#/Gb
  7: 9, // G
  8: 4, // G#/Ab
  9: 11, // A
};

/**
 * The Camelot number for each pitch class on the MINOR (inner, "A") ring, indexed by
 * pitch class. E.g. A minor → 8, D minor → 7, G minor → 6.
 */
export const CAMELOT_MINOR_NUMBER: Record<number, number> = {
  0: 5, // C
  1: 12, // C#/Db
  10: 3, // A#/Bb
  11: 10, // B
  2: 7, // D
  3: 2, // D#/Eb
  4: 9, // E
  5: 4, // F
  6: 11, // F#/Gb
  7: 6, // G
  8: 1, // G#/Ab
  9: 8, // A
};

/** A parsed musical key: its pitch class (0 = C … 11 = B) and whether it is minor. */
export type ParsedKey = {
  isMinor: boolean;
  pitchClass: number;
};

/**
 * A Camelot wheel position: the number ring (1..12) and the letter ring
 * (`A` = minor/inner, `B` = major/outer). "8A" is `{ number: 8, letter: "A" }`.
 */
export type Camelot = {
  letter: "A" | "B";
  number: number;
};

// A tolerant "<note> <quality>" matcher: an optional sharp/flat accidental (ASCII or
// Unicode), then a full or shortened mode word, with stray leading/trailing
// whitespace allowed. The quality alternation lists the long forms first so
// "major"/"minor" bind fully rather than stopping at "maj"/"min".
const KEY_PATTERN = /^\s*([A-Ga-g][#♯b♭]?)\s+(major|minor|maj|min)\s*$/;

/**
 * Parse a scale-text key ("A minor", "F# major", "Bb min") into its structural
 * `{ pitchClass, isMinor }`, or `null` when it is absent / not a recognized key.
 * Tolerant of flats (folded to their sharp enharmonic), `maj`/`min` shorthand, and
 * stray whitespace; a modal or unknown spelling ("F# dorian", "H major") is `null`,
 * never a guess. The one place the repo decides "what a key string means".
 */
export function parseKey(key: string | null | undefined): ParsedKey | null {
  if (!key) {
    return null;
  }

  const match = KEY_PATTERN.exec(key);
  const rawNote = match?.[1];
  const quality = match?.[2];

  if (!rawNote || !quality) {
    return null;
  }

  const note = rawNote.charAt(0).toUpperCase() + rawNote.slice(1);
  const pitchClass = PITCH_CLASS[note];

  if (pitchClass === undefined) {
    return null;
  }

  return { isMinor: quality.toLowerCase().startsWith("min"), pitchClass };
}

/**
 * Project a parsed key onto the Camelot wheel — its number ring (1..12) + letter
 * ring (`A` minor / `B` major). Pure lookup; the pitch-class maps are exhaustive
 * over 0..11, so every valid `ParsedKey` yields a position.
 */
export function toCamelot({ isMinor, pitchClass }: ParsedKey): Camelot {
  const number = (isMinor ? CAMELOT_MINOR_NUMBER : CAMELOT_MAJOR_NUMBER)[pitchClass];

  // `number` is defined for every pitch class 0..11 (both maps are exhaustive); the
  // `?? 1` keeps the type non-optional without a non-null assertion for a class that
  // cannot occur from a valid `ParsedKey`.
  return { letter: isMinor ? "A" : "B", number: number ?? 1 };
}

/**
 * Parse a scale-text key straight to its Camelot code string ("8A", "7B"), or `null`.
 * The convenience `parseKey` → `toCamelot` composition `formatKey` (client display)
 * builds on.
 */
export function keyToCamelotCode(key: string | null | undefined): string | null {
  const parsed = parseKey(key);

  if (!parsed) {
    return null;
  }

  const { letter, number } = toCamelot(parsed);

  return `${number}${letter}`;
}
