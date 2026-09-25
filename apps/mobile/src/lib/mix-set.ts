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

export function buildMixShareUrl(setTokens: string[], tasteSlugs: string[]): string {
  const set = serializeSet(setTokens);
  const taste = tasteSlugs.length > 0 ? `&taste=${serializeTaste(tasteSlugs)}` : "";

  return `${API_BASE}/mix?set=${set}${taste}&view=play`;
}
