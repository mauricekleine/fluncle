import { isLogId, isMixtapeLogId } from "./log-id";

const SPOTIFY_TRACK_ID_PATTERN = /^[0-9A-Za-z]{22}$/;

export function isLogPageParam(value: string): boolean {
  return isLogId(value) || isMixtapeLogId(value) || SPOTIFY_TRACK_ID_PATTERN.test(value);
}

export function canonicalCoordinate(value: string): string | undefined {
  const upper = value.toUpperCase();

  return isLogId(upper) || isMixtapeLogId(upper) ? upper : undefined;
}
