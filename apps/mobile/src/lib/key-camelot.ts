// The pure key → Camelot core — a faithful port of apps/web/src/lib/key-camelot.ts (the
// canonical pitch-class + wheel tables; the mixability engine reasons over the same maps).
// React-Native-free so the test harness loads it directly; key-camelot.test.ts pins the
// conversions to the web's so the two surfaces can't drift on what "1A" means.
//
// The parser is deliberately forgiving — enrichment writes sharps ("C# major"), but an
// externally sourced key might arrive flat, in `maj`/`min` shorthand, or with stray
// whitespace, and all resolve. Anything it cannot parse returns `null`, never a guess.

/**
 * Pitch class (0 = C … 11 = B) for every note spelling we might see. Enharmonics fold to
 * the same class (Bb and A# are both 10), matching the repo's sharp convention.
 */
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

/** The Camelot number for each pitch class on the MAJOR (outer, "B") ring. */
const CAMELOT_MAJOR_NUMBER: Record<number, number> = {
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

/** The Camelot number for each pitch class on the MINOR (inner, "A") ring. */
const CAMELOT_MINOR_NUMBER: Record<number, number> = {
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

// A tolerant "<note> <quality>" matcher: an optional sharp/flat accidental (ASCII or
// Unicode), then a full or shortened mode word. Long forms listed first so
// "major"/"minor" bind fully rather than stopping at "maj"/"min".
const KEY_PATTERN = /^\s*([A-Ga-g][#♯b♭]?)\s+(major|minor|maj|min)\s*$/;

/**
 * Parse a scale-text key ("A minor", "F# major", "Bb min") straight to its Camelot code
 * string ("8A", "7B"), or `null` when it is absent / not a recognized key.
 */
export function keyToCamelotCode(key: string | null | undefined): string | null {
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

  const isMinor = quality.toLowerCase().startsWith("min");
  const number = (isMinor ? CAMELOT_MINOR_NUMBER : CAMELOT_MAJOR_NUMBER)[pitchClass];

  // The maps are exhaustive over 0..11; the `?? 1` keeps the type non-optional without a
  // non-null assertion for a class that cannot occur from a valid parse.
  return `${number ?? 1}${isMinor ? "A" : "B"}`;
}
