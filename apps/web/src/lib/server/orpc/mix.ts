import { parseSetParam, parseTasteParam } from "../../mix-set";
import { getMixOpeners, getMixTracksByTokens, listMixableArtists } from "../tracks";
import { apiFault, type Implementer } from "./_shared";

const ARTISTS_DEFAULT_LIMIT = 60;
const ARTISTS_MAX_LIMIT = 200;

const OPENERS_DEFAULT_LIMIT = 24;
const OPENERS_MAX_LIMIT = 60;

function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

export function mixHandlers(os: Implementer) {
  const listMixableArtistsHandler = os.list_mixable_artists.handler(async ({ input }) => {
    try {
      const limit = parseLimit(input.limit, ARTISTS_DEFAULT_LIMIT, ARTISTS_MAX_LIMIT);
      const artists = await listMixableArtists({ limit, q: input.q });

      return { artists, ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  const listMixOpenersHandler = os.list_mix_openers.handler(async ({ input }) => {
    try {
      const limit = parseLimit(input.limit, OPENERS_DEFAULT_LIMIT, OPENERS_MAX_LIMIT);
      const tracks = await getMixOpeners(parseTasteParam(input.taste), { limit });

      return { ok: true, tracks } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  const listSetTracksHandler = os.list_set_tracks.handler(async ({ input }) => {
    try {
      const tokens = parseSetParam(input.set);
      const tracks = tokens.length > 0 ? await getMixTracksByTokens(tokens) : [];

      return { ok: true, tracks } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  return {
    list_mix_openers: listMixOpenersHandler,
    list_mixable_artists: listMixableArtistsHandler,
    list_set_tracks: listSetTracksHandler,
  };
}
