import { type Echo, type NoteEchoThresholds, scoreEcho } from "./note";
import { ApiError } from "./spotify";

export const OBSERVATION_ECHO_DEFAULTS: NoteEchoThresholds = {
  maxOverlap: 0.3,
  minPhraseWords: 4,
};

export type ObservationNeighbor = { logId: string; script: string };

export type ObservationEcho = {
  echoes: boolean;

  logId: string | null;

  phrase: string;

  overlap: number;

  script: string;
};

export function scoreObservationEcho(
  script: string,
  neighbors: readonly ObservationNeighbor[],
  thresholds: NoteEchoThresholds = OBSERVATION_ECHO_DEFAULTS,
): ObservationEcho {
  const echo: Echo = scoreEcho(
    script,
    neighbors.map((neighbor) => ({ logId: neighbor.logId, text: neighbor.script })),
    thresholds,
  );

  return {
    echoes: echo.echoes,
    logId: echo.logId,
    overlap: echo.overlap,
    phrase: echo.phrase,
    script: echo.text,
  };
}

export function observationEchoError(echo: ObservationEcho): ApiError {
  const detail = echo.phrase
    ? `it lifts "${echo.phrase}" straight from ${echo.logId}`
    : `it reuses ${Math.round(echo.overlap * 100)}% of ${echo.logId}'s words`;

  return new ApiError(
    "observation_echoes_neighbours",
    `The observation echoes its sonic neighbourhood: ${detail}. The neighbours inform the read, they never template it — say what is true of THIS record's arrival and nothing else. It is held for the operator's eye, not thrown away.`,
    422,
  );
}
