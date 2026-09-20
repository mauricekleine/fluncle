import { type MixTrack } from "@fluncle/contracts";
import { type SearchHit } from "@fluncle/contracts/orpc";
import { serializeSet, serializeTaste } from "@fluncle/contracts/util/mix-set";
import { API_BASE } from "@/config";

export {
  isSetToken,
  MAX_SET_LENGTH,
  MAX_TASTE_ARTISTS,
  mixReasonLabel,
  parseSetParam,
  parseTasteParam,
  serializeSet,
  serializeTaste,
  setToken,
} from "@fluncle/contracts/util/mix-set";

/**
 * Adapt an archive-search hit into a mix chain row. Only a certified hit carries a Log ID, which
 * preserves the Unlit Rule structurally while the rail fills duration data later.
 */
export function searchHitToMixTrack(hit: SearchHit): MixTrack {
  return {
    albumImageUrl: hit.albumImageUrl,
    artists: hit.artists,
    bpm: hit.bpm,
    certified: hit.certified,
    durationMs: 0,
    key: hit.key,
    logId: hit.certified ? hit.logId : undefined,
    spotifyUrl: hit.spotifyUrl,
    title: hit.title,
    trackId: hit.trackId,
  };
}

/**
 * Build the same share URL as the web button. Log IDs, Spotify ids, and artist slugs are URL-safe
 * by construction, so raw interpolation preserves the shared codec byte-for-byte.
 */
export function buildMixShareUrl(setTokens: string[], tasteSlugs: string[]): string {
  const set = serializeSet(setTokens);
  const taste = tasteSlugs.length > 0 ? `&taste=${serializeTaste(tasteSlugs)}` : "";

  return `${API_BASE}/mix?set=${set}${taste}&view=play`;
}
