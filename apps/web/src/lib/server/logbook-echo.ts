import { type Echo, type NoteEchoThresholds, scoreEcho } from "./note";
import { getSetting } from "./settings";
import { ApiError } from "./spotify";

const LOGBOOK_ECHO_DEFAULTS: NoteEchoThresholds = {
  maxOverlap: 0.3,
  minPhraseWords: 4,
};

const MIN_PHRASE_WORDS_KEY = "logbook_echo_min_phrase_words";
const MAX_OVERLAP_KEY = "logbook_echo_max_overlap";

function parseDial(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);

  return raw !== undefined && Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

export async function getLogbookEchoThresholds(): Promise<NoteEchoThresholds> {
  const [phrase, overlap] = await Promise.all([
    getSetting(MIN_PHRASE_WORDS_KEY),
    getSetting(MAX_OVERLAP_KEY),
  ]);

  return {
    maxOverlap: parseDial(overlap, LOGBOOK_ECHO_DEFAULTS.maxOverlap, 0.05, 1),
    minPhraseWords: parseDial(phrase, LOGBOOK_ECHO_DEFAULTS.minPhraseWords, 2, 20),
  };
}

export type LogbookEchoNeighbor = { body: string; sector: number };

export type LogbookEcho = {
  body: string;

  echoes: boolean;

  overlap: number;

  phrase: string;

  sector: number | null;
};

export function scoreLogbookEcho(
  body: string,
  neighbors: readonly LogbookEchoNeighbor[],
  thresholds: NoteEchoThresholds = LOGBOOK_ECHO_DEFAULTS,
): LogbookEcho {
  const echo: Echo = scoreEcho(
    body,
    neighbors.map((neighbor) => ({ logId: String(neighbor.sector), text: neighbor.body })),
    thresholds,
  );

  return {
    body: echo.text,
    echoes: echo.echoes,
    overlap: echo.overlap,
    phrase: echo.phrase,
    sector: echo.logId === null ? null : Number(echo.logId),
  };
}

export function logbookBodyEchoError(echo: LogbookEcho): ApiError {
  const detail = echo.phrase
    ? `it lifts "${echo.phrase}" straight from sector ${echo.sector}`
    : `it reuses ${Math.round(echo.overlap * 100)}% of sector ${echo.sector}'s words`;

  return new ApiError(
    "body_echoes_logbook",
    `The entry echoes the recent logbook: ${detail}. The past entries show what is already spent, they never template a new day — write what was true of THIS day and no other.`,
    422,
  );
}
