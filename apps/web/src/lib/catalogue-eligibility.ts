export const DUPLICATE_SIMILARITY = 0.995;

export const LONG_FORM_MS = 15 * 60_000;

export const SPOKEN_WORD_QUALIFIERS = [
  "commentary",
  "commentary track",
  "interview",
  "track by track",
  "track-by-track",
  "track–by–track",
] as const;

const SPOKEN_WORD_DASHES = [" - ", " – ", " — "] as const;

function spokenWordQualifierPatterns(qualifier: string): string[] {
  return [
    `%(${qualifier})%`,
    `%[${qualifier}]%`,
    `%(% ${qualifier})%`,
    `%[% ${qualifier}]%`,
    `${qualifier}: %`,
    ...SPOKEN_WORD_DASHES.flatMap((dash) => [
      `%${dash}${qualifier}`,
      `%${dash}${qualifier} (%`,
      `%${dash}${qualifier} [%`,
      `%${dash}% ${qualifier}`,
    ]),
  ];
}

export const SPOKEN_WORD_TITLE_PATTERNS: readonly {
  gate: string;
  patterns: readonly string[];
}[] = SPOKEN_WORD_QUALIFIERS.map((qualifier) => ({
  gate: `%${qualifier}%`,
  patterns: spokenWordQualifierPatterns(qualifier),
}));

function likePatternRegExp(pattern: string): RegExp {
  const body = pattern.replace(/[%_.*+?^${}()|[\]\\]/g, (char) => {
    if (char === "%") {
      return "[\\s\\S]*";
    }

    if (char === "_") {
      return "[\\s\\S]";
    }

    return `\\${char}`;
  });

  return new RegExp(`^${body}$`, "i");
}

const SPOKEN_WORD_TITLE_REGEXPS = SPOKEN_WORD_TITLE_PATTERNS.map(({ gate, patterns }) => ({
  gate: likePatternRegExp(gate),
  patterns: patterns.map(likePatternRegExp),
}));

export function isSpokenWordTitle(title: string): boolean {
  return SPOKEN_WORD_TITLE_REGEXPS.some(
    ({ gate, patterns }) => gate.test(title) && patterns.some((pattern) => pattern.test(title)),
  );
}

function column(alias: string | undefined, name: string): string {
  return alias === undefined ? name : `${alias}.${name}`;
}

export function balancedOr(terms: readonly string[]): string {
  if (terms.length === 0) {
    return "0";
  }

  if (terms.length === 1) {
    return `(${terms[0]})`;
  }

  const middle = Math.ceil(terms.length / 2);

  return `(${balancedOr(terms.slice(0, middle))} or ${balancedOr(terms.slice(middle))})`;
}

export function spokenWordTitleWhere(alias?: string): string {
  const title = column(alias, "title");

  return balancedOr(
    SPOKEN_WORD_TITLE_PATTERNS.map(
      ({ gate, patterns }) =>
        `${title} like '${gate}' and ${balancedOr(patterns.map((pattern) => `${title} like '${pattern}'`))}`,
    ),
  );
}

export function catalogueTrackPublicWhere(alias?: string): string {
  return `(${column(alias, "duration_ms")} < ${LONG_FORM_MS} and not ${spokenWordTitleWhere(alias)})`;
}

export type PublicTrackHiddenReason = "long_form" | "spoken_word";

export function catalogueTrackHiddenReason(track: {
  durationMs: number;
  title: string;
}): PublicTrackHiddenReason | null {
  if (!(track.durationMs < LONG_FORM_MS)) {
    return "long_form";
  }

  return isSpokenWordTitle(track.title) ? "spoken_word" : null;
}

export const REC_ELIGIBLE_WHERE = `f.track_id is null
      and emb.track_id is not null
      and t.spotify_uri is not null
      and t.dismissed_at is null
      and t.duplicate_of_track_id is null
      and (t.nearest_finding_score is null or t.nearest_finding_score < ${DUPLICATE_SIMILARITY})
      and ${catalogueTrackPublicWhere("t")}`;
