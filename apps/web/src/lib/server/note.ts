import { NOTE_MAX_LENGTH } from "../log-prose";
import { maskSubjectNames, scanObservationScript } from "./observation";
import { ApiError } from "./spotify";

const NOTE_MIN_CHARS = 24;
const NOTE_MAX_CHARS = NOTE_MAX_LENGTH;

export function gateNoteText(text: unknown, subjectNames: readonly string[]): string {
  if (typeof text !== "string" || !text.trim()) {
    throw new ApiError("no_note", "A `note` (the finding's editorial line) is required", 400);
  }

  const trimmed = text.trim();

  if (trimmed.length < NOTE_MIN_CHARS) {
    throw new ApiError(
      "note_too_short",
      `The note is too short (${trimmed.length} < ${NOTE_MIN_CHARS} chars)`,
      422,
    );
  }

  if (trimmed.length > NOTE_MAX_CHARS) {
    throw new ApiError(
      "note_too_long",
      `The note is too long (${trimmed.length} > ${NOTE_MAX_CHARS} chars)`,
      422,
    );
  }

  const violations = scanObservationScript(maskSubjectNames(trimmed, subjectNames));

  if (violations.length > 0) {
    throw new ApiError(
      "voice_gate",
      `The note fails the voice gate: ${violations.map((violation) => violation.reason).join("; ")}`,
      422,
    );
  }

  return trimmed;
}

export const NOTE_ECHO_DEFAULTS = {
  maxOverlap: 0.3,

  minPhraseWords: 4,
} as const;

export type NoteEchoThresholds = {
  maxOverlap: number;
  minPhraseWords: number;
};

const ECHO_STOPWORDS = new Set(
  (
    "a an the and or but of to in on at it its is was be been this that these those " +
    "i my me you your he she they them we our us with without for from as into onto " +
    "over under before after then than so very just still yet even more most much " +
    "many had have has do does did doing done got get gets not no nor if when while " +
    "where how what who which one ones another other any every each both there here " +
    "now s t re ve ll d m"
  ).split(" "),
);

export function echoWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function echoContentWords(text: string): string[] {
  return echoWords(text).filter((word) => !ECHO_STOPWORDS.has(word) && word.length > 2);
}

export function contentOverlap(a: string, b: string): number {
  const left = new Set(echoContentWords(a));
  const right = new Set(echoContentWords(b));

  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let shared = 0;

  for (const word of left) {
    if (right.has(word)) {
      shared += 1;
    }
  }

  return shared / new Set([...left, ...right]).size;
}

function liftedPhrase(a: string, b: string, minPhraseWords: number): string {
  const left = echoWords(a);
  const right = echoWords(b);
  let best: string[] = [];

  for (let i = 0; i < left.length; i += 1) {
    for (let j = 0; j < right.length; j += 1) {
      let run = 0;

      while (i + run < left.length && j + run < right.length && left[i + run] === right[j + run]) {
        run += 1;
      }

      if (run > best.length) {
        best = left.slice(i, i + run);
      }
    }
  }

  if (best.length < minPhraseWords) {
    return "";
  }

  const carriesContent = best.some((word) => !ECHO_STOPWORDS.has(word) && word.length > 2);

  return carriesContent ? best.join(" ") : "";
}

export type EchoNeighbor = { logId: string; text: string };

export type Echo = {
  echoes: boolean;

  logId: string | null;

  text: string;

  overlap: number;

  phrase: string;
};

export function scoreEcho(
  text: string,
  neighbors: readonly EchoNeighbor[],
  thresholds: NoteEchoThresholds = NOTE_ECHO_DEFAULTS,
): Echo {
  let worst: Echo = { echoes: false, logId: null, overlap: 0, phrase: "", text: "" };
  const severity = (echo: Echo) => (echo.phrase ? 1 + echo.phrase.split(" ").length : echo.overlap);
  let worstSeverity = -1;

  for (const neighbor of neighbors) {
    if (!neighbor.text.trim()) {
      continue;
    }

    const phrase = liftedPhrase(text, neighbor.text, thresholds.minPhraseWords);
    const overlap = contentOverlap(text, neighbor.text);
    const candidate: Echo = {
      echoes: phrase.length > 0 || overlap >= thresholds.maxOverlap,
      logId: neighbor.logId,
      overlap,
      phrase,
      text: neighbor.text,
    };

    if (severity(candidate) > worstSeverity) {
      worstSeverity = severity(candidate);
      worst = candidate;
    }
  }

  return worst;
}

export type NoteNeighbor = { logId: string; note: string };

export type NoteEcho = {
  echoes: boolean;

  logId: string | null;

  note: string;

  overlap: number;

  phrase: string;
};

export function scoreNoteEcho(
  note: string,
  neighbors: readonly NoteNeighbor[],
  thresholds: NoteEchoThresholds = NOTE_ECHO_DEFAULTS,
): NoteEcho {
  const echo = scoreEcho(
    note,
    neighbors.map((neighbor) => ({ logId: neighbor.logId, text: neighbor.note })),
    thresholds,
  );

  return {
    echoes: echo.echoes,
    logId: echo.logId,
    note: echo.text,
    overlap: echo.overlap,
    phrase: echo.phrase,
  };
}

export function noteEchoError(echo: NoteEcho): ApiError {
  const detail = echo.phrase
    ? `it lifts "${echo.phrase}" straight from ${echo.logId}`
    : `it reuses ${Math.round(echo.overlap * 100)}% of ${echo.logId}'s words`;

  return new ApiError(
    "note_echoes_neighbours",
    `The note echoes its sonic neighbourhood: ${detail}. The neighbours inform the note, they never template it — write a line that is this finding's own. It is held for the operator's eye, not thrown away.`,
    422,
  );
}

export function gateNoteEcho(
  note: string,
  neighbors: readonly NoteNeighbor[],
  thresholds: NoteEchoThresholds = NOTE_ECHO_DEFAULTS,
): NoteEcho {
  const echo = scoreNoteEcho(note, neighbors, thresholds);

  if (!echo.echoes) {
    return echo;
  }

  throw noteEchoError(echo);
}
