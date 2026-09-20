/** Pitch class (0 = C … 11 = B) for accepted note spellings. */
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

/** The Camelot number for each pitch class on the major (outer, "B") ring. */
export const CAMELOT_MAJOR_NUMBER: Record<number, number> = {
  0: 8,
  1: 3,
  10: 6,
  11: 1,
  2: 10,
  3: 5,
  4: 12,
  5: 7,
  6: 2,
  7: 9,
  8: 4,
  9: 11,
};

/** The Camelot number for each pitch class on the minor (inner, "A") ring. */
export const CAMELOT_MINOR_NUMBER: Record<number, number> = {
  0: 5,
  1: 12,
  10: 3,
  11: 10,
  2: 7,
  3: 2,
  4: 9,
  5: 4,
  6: 11,
  7: 6,
  8: 1,
  9: 8,
};

/** A parsed musical key: its pitch class and whether it is minor. */
export type ParsedKey = {
  isMinor: boolean;
  pitchClass: number;
};

/** A Camelot wheel position. */
export type Camelot = {
  letter: "A" | "B";
  number: number;
};

const KEY_PATTERN = /^\s*([A-Ga-g][#♯b♭]?)\s+(major|minor|maj|min)\s*$/;

/**
 * Parse scale text into a pitch class and quality. Enrichment writes sharps, while external
 * sources may supply flats, Unicode accidentals, mode abbreviations, or stray whitespace.
 * Anything outside that grammar returns `null` rather than guessing.
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

/** Project a parsed key onto the Camelot wheel. */
export function toCamelot({ isMinor, pitchClass }: ParsedKey): Camelot {
  const number = (isMinor ? CAMELOT_MINOR_NUMBER : CAMELOT_MAJOR_NUMBER)[pitchClass];

  // The maps cover every pitch class the parser can produce. The fallback keeps the public return
  // type non-optional for manually constructed ParsedKey values without a non-null assertion.
  return { letter: isMinor ? "A" : "B", number: number ?? 1 };
}

/** Parse scale text straight to a Camelot code such as `8A`, or `null`. */
export function keyToCamelotCode(key: string | null | undefined): string | null {
  const parsed = parseKey(key);

  if (!parsed) {
    return null;
  }

  const { letter, number } = toCamelot(parsed);

  return `${number}${letter}`;
}
