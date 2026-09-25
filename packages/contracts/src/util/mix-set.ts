import { type MixReason } from "../index";
import { isLogId } from "../log-id";

export const MAX_SET_LENGTH = 32;

export const MAX_TASTE_ARTISTS = 10;

const SPOTIFY_TRACK_ID = /^[A-Za-z0-9]{22}$/;
const ARTIST_SLUG = /^[a-z0-9][a-z0-9-]*$/;

export function isSetToken(token: string): boolean {
  return isLogId(token) || SPOTIFY_TRACK_ID.test(token);
}

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

export function serializeSet(tokens: string[]): string {
  return tokens.join(",");
}

export function setToken(track: { logId?: string; trackId: string }): string {
  return track.logId ?? track.trackId;
}

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

export function mixReasonLabel(reason: MixReason): string {
  return REASON_LABEL[reason.relationship];
}
