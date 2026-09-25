import { LONG_FORM_MS } from "../lib/catalogue-eligibility";

export function catalogueTrackDurationWhere(trackAlias?: string): string {
  return `${trackAlias === undefined ? "" : `${trackAlias}.`}duration_ms < ${LONG_FORM_MS}`;
}

export function publicTrackDurationOk(durationMs: number, isFinding: boolean): boolean {
  return durationMs < LONG_FORM_MS || isFinding;
}

export function publicTrackDurationWhere(trackAlias: string, findingAlias?: string): string {
  const findingExists =
    findingAlias === undefined
      ? `exists (select 1 from findings where findings.track_id = ${trackAlias}.track_id)`
      : `${findingAlias}.track_id is not null`;

  return `(${catalogueTrackDurationWhere(trackAlias)} or ${findingExists})`;
}
