import {
  catalogueTrackHiddenReason,
  catalogueTrackPublicWhere,
  type PublicTrackHiddenReason,
} from "../lib/catalogue-eligibility";

export { catalogueTrackPublicWhere, type PublicTrackHiddenReason };

export type PublicTrackVisibilityInput = { durationMs: number; title: string };

export function publicTrackHiddenReason(
  track: PublicTrackVisibilityInput,
  isFinding: boolean,
): PublicTrackHiddenReason | null {
  return isFinding ? null : catalogueTrackHiddenReason(track);
}

export function publicTrackOk(track: PublicTrackVisibilityInput, isFinding: boolean): boolean {
  return publicTrackHiddenReason(track, isFinding) === null;
}

export function publicTrackWhere(trackAlias: string, findingAlias?: string): string {
  const findingExists =
    findingAlias === undefined
      ? `exists (select 1 from findings where findings.track_id = ${trackAlias}.track_id)`
      : `${findingAlias}.track_id is not null`;

  return `(${catalogueTrackPublicWhere(trackAlias)} or ${findingExists})`;
}
