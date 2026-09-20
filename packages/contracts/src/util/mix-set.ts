import { type MixReason } from "../index";
import { isLogId } from "../log-id";

// The URL is the cross-surface storage contract. Web and mobile must parse and serialize the same
// ordered chain so a set assembled on either surface opens unchanged on the other. Browser-local
// storage would break shared links and split the source of truth.

/** The most tracks a set link carries. */
export const MAX_SET_LENGTH = 32;

/** The most artists a taste seed carries. */
export const MAX_TASTE_ARTISTS = 10;

const SPOTIFY_TRACK_ID = /^[A-Za-z0-9]{22}$/;
const ARTIST_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** Whether a token can identify a track in a set link. */
export function isSetToken(token: string): boolean {
  return isLogId(token) || SPOTIFY_TRACK_ID.test(token);
}

/** Parse, validate, de-duplicate, and cap a comma-separated set while preserving its order. */
export function parseSetParam(raw: string | undefined | null): string[] {
  if (!raw) {
    return [];
  }

  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of raw.split(",")) {
    const token = value.trim();

    if (isSetToken(token) && !seen.has(token)) {
      seen.add(token);
      out.push(token);

      if (out.length >= MAX_SET_LENGTH) {
        break;
      }
    }
  }

  return out;
}

/** Serialize an ordered set. */
export function serializeSet(tokens: string[]): string {
  return tokens.join(",");
}

/** Name a track by coordinate when certified, otherwise by its Spotify id. */
export function setToken(track: { logId?: string; trackId: string }): string {
  return track.logId ?? track.trackId;
}

/** Parse, normalize, de-duplicate, and cap a comma-separated taste seed. */
export function parseTasteParam(raw: string | undefined | null): string[] {
  if (!raw) {
    return [];
  }

  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of raw.split(",")) {
    const slug = value.trim().toLowerCase();

    if (ARTIST_SLUG.test(slug) && !seen.has(slug)) {
      seen.add(slug);
      out.push(slug);

      if (out.length >= MAX_TASTE_ARTISTS) {
        break;
      }
    }
  }

  return out;
}

/** Serialize an ordered taste seed. */
export function serializeTaste(slugs: string[]): string {
  return slugs.join(",");
}

const REASON_LABEL: Record<MixReason["relationship"], string> = {
  adjacent: "Next key over",
  close_in_sound: "Close in sound",
  diagonal: "Diagonal key",
  distant: "Long stretch",
  energy: "Energy lift",
  relative: "Relative key",
  same_key: "Same key",
  tempo_match: "Tempo locked",
};

/** The reason chip's crew-facing label for a candidate row. */
export function mixReasonLabel(reason: MixReason): string {
  return REASON_LABEL[reason.relationship];
}
