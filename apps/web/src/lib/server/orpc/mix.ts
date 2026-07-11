// The `mix` domain router module — the two public reads TASTE-SEEDING needs (the artists
// you can seed from, and what to open a set with once you have). Both are unauthenticated:
// `/mix` is a stranger's first contact with Fluncle and it must work with no account.
//
// The rail itself (`list_mixable_tracks`) lives in ./tracks.ts, where its `/tracks/{id}/…`
// path belongs.

import { getMixOpeners, listMixableArtists } from "../tracks";
import { apiFault, type Implementer } from "./_shared";

/** The default/max number of artists the taste picker's grid offers. */
const ARTISTS_DEFAULT_LIMIT = 60;
const ARTISTS_MAX_LIMIT = 200;
/** The default/max number of openers offered for a seed. */
const OPENERS_DEFAULT_LIMIT = 24;
const OPENERS_MAX_LIMIT = 60;

/** Parse a tolerant optional numeric string, degrading to the default rather than 400-ing. */
function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

/** Split the `taste` seed — a comma-separated artist-slug list — into clean slugs. */
function parseTaste(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((slug) => slug.trim())
    .filter(Boolean);
}

/** Build the `mix` domain's handlers — the taste-seed reads. Public, unauthenticated. */
export function mixHandlers(os: Implementer) {
  // `list_mixable_artists` — the artists a mix can be seeded from (a key AND a vector on at
  // least one track), most-represented first, `q` filtering by name. NOT `list_artists`:
  // that one promises artists with a published FINDING, and seeding against it would fail
  // the first stranger who names a favourite Fluncle has not logged yet.
  const listMixableArtistsHandler = os.list_mixable_artists.handler(async ({ input }) => {
    try {
      const limit = parseLimit(input.limit, ARTISTS_DEFAULT_LIMIT, ARTISTS_MAX_LIMIT);
      const artists = await listMixableArtists({ limit, q: input.q });

      return { artists, ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  // `list_mix_openers` — the seeded artists' own tracks, certified first. An empty or
  // unresolvable seed is a quiet `{ tracks: [] }` (the page falls back to search), never a
  // fault: a stranger who mistypes a slug should get a search box, not an error.
  const listMixOpenersHandler = os.list_mix_openers.handler(async ({ input }) => {
    try {
      const limit = parseLimit(input.limit, OPENERS_DEFAULT_LIMIT, OPENERS_MAX_LIMIT);
      const tracks = await getMixOpeners(parseTaste(input.taste), { limit });

      return { ok: true, tracks } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  return {
    list_mix_openers: listMixOpenersHandler,
    list_mixable_artists: listMixableArtistsHandler,
  };
}
