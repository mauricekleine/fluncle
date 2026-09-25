const COORDINATE_PATTERN = /^(?:fluncle:\/\/)?(\d{3,}\.(?:\d|f)\.(?:\d[a-z]|\d{2}))$/i;

export function parseCoordinate(query: string): string | null {
  const match = COORDINATE_PATTERN.exec(query.trim());

  return match?.[1] ? match[1].toUpperCase() : null;
}

export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

export function isBareToken(query: string): boolean {
  return tokenize(query).length === 1;
}

const SONIC_PATTERN =
  /^(?:(?:tracks?|songs?|findings?|anything|something|stuff)\s+)?(?:that\s+)?(?:sounds?\s+like|sound\s+like|similar\s+to|like)\s+(.+)$/i;

const COMPOUND_TAIL = /\s+(?:but|on|in|from|under|over|above|below|around|at)\s+\S/i;

export function parseSonicPhrase(query: string): string | null {
  const match = SONIC_PATTERN.exec(query.trim());
  const reference = match?.[1]?.trim();

  if (!reference || COMPOUND_TAIL.test(reference)) {
    return null;
  }

  return reference;
}

export function toFtsMatch(query: string, join: "and" | "or" = "and"): string | null {
  const tokens = tokenize(query);
  const searchable = join === "or" ? withoutStopwords(tokens) : tokens;

  if (searchable.length === 0) {
    return null;
  }

  const terms = searchable.map((token, index) =>
    index === searchable.length - 1 ? `"${token}"*` : `"${token}"`,
  );

  return terms.join(join === "or" ? " OR " : " ");
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "any",
  "anything",
  "at",
  "by",
  "find",
  "for",
  "from",
  "get",
  "give",
  "in",
  "is",
  "it",
  "like",
  "me",
  "more",
  "of",
  "on",
  "or",
  "show",
  "some",
  "something",
  "song",
  "songs",
  "sound",
  "sounds",
  "that",
  "the",
  "to",
  "track",
  "tracks",
  "tune",
  "tunes",
  "with",
]);

function withoutStopwords(tokens: string[]): string[] {
  const kept = tokens.filter((token) => !STOPWORDS.has(token));

  return kept.length > 0 ? kept : tokens;
}

const PITCH_SPELLINGS: Record<number, string[]> = {
  0: ["C", "B#"],
  1: ["C#", "Db"],
  10: ["A#", "Bb"],
  11: ["B", "Cb"],
  2: ["D"],
  3: ["D#", "Eb"],
  4: ["E", "Fb"],
  5: ["F", "E#"],
  6: ["F#", "Gb"],
  7: ["G"],
  8: ["G#", "Ab"],
  9: ["A"],
};

const MODE_WORDS: Record<"major" | "minor", string[]> = {
  major: ["major", "maj"],
  minor: ["minor", "min"],
};

export function keySpellings(parsed: { isMinor: boolean; pitchClass: number }): string[] {
  const notes = PITCH_SPELLINGS[parsed.pitchClass] ?? [];
  const modes = MODE_WORDS[parsed.isMinor ? "minor" : "major"];

  return notes.flatMap((note) => modes.map((mode) => `${note} ${mode}`));
}
