// The `tracks` domain router module. Implements the track-read contract ops off
// the shared implementer the root (../orpc.ts) hands in. A future wave adds an
// op here and one spread line in the root — no other domain's file is touched.

import { ORPCError } from "@orpc/server";
import { parseSetParam, parseTasteParam } from "../../mix-set";
import { clampFreshLimit, listFreshTracks } from "../fresh";
import { CatalogueHubPageOutOfRangeError } from "../labels";
import { listTracksHubPage, toCatalogueTrackListItem } from "../tracks-hub";
import {
  decodeTrackCursor,
  getMixableTracks,
  getRandomTrack,
  getSimilarFindings,
  listTracks,
  toPublicTrackListItem,
} from "../tracks";
import { resolveLogPageTarget } from "../log-resolver";
import { apiFault, type Implementer, parseLimit } from "./_shared";

// Feed page-size bounds, ported verbatim from the live feed route.
const LIST_DEFAULT_LIMIT = 16;
const LIST_MAX_LIMIT = 48;

// "More like this" row bounds — a small default (matches the `/log` row) with a
// modest ceiling; the op parses the limit tolerantly like the `list_findings` feed.
const SIMILAR_DEFAULT_LIMIT = 6;
const SIMILAR_MAX_LIMIT = 24;

// `/mix` rail bounds — a fuller default than "more like this" (the crew builds a set
// off it), still modestly capped; parsed tolerantly like the `list_findings` feed.
const MIXABLE_DEFAULT_LIMIT = 12;
const MIXABLE_MAX_LIMIT = 32;

/**
 * Normalize a discovery-window bound exactly as the live route's `parseTimestamp`
 * did: an invalid value is ignored (degrades to the unwindowed list), a valid one
 * is normalized to ISO so string comparison against the stored `added_at` holds.
 */
function parseTimestamp(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * Build the `tracks` domain's handlers — direct ports of the live route logic,
 * each preserving the success body byte-for-byte (these feed the CLI, MCP, the
 * web app, and the external newsletter agent). Errors are converted through the
 * shared `apiFault` so the rails encoder reproduces the legacy `jsonError` body.
 */
export function tracksHandlers(os: Implementer) {
  // `get_track` — public read of one finding (or mixtape) by Spotify trackId or
  // Log ID. Port of /api/tracks/{idOrLogId} GET: resolve, 404 via ORPCError when
  // absent, else the `{ ok: true } & ({ track } | { mixtape })` envelope.
  const getTrack = os.get_track.handler(async ({ input }) => {
    try {
      const target = await resolveLogPageTarget(input.idOrLogId);

      if (!target) {
        throw new ORPCError("NOT_FOUND", { message: `No finding for "${input.idOrLogId}"` });
      }

      return target.kind === "mixtape"
        ? ({ mixtape: target.mixtape, ok: true } as const)
        : ({ ok: true, track: toPublicTrackListItem(target.track) } as const);
    } catch (error) {
      // Re-throw oRPC's own errors (the 404 above) so the rails encoder shapes
      // the response; anything else is an unexpected fault.
      if (error instanceof ORPCError) {
        throw error;
      }

      throw apiFault(error);
    }
  });

  // `list_findings` — the public merged FEED (findings + published mixtapes, newest
  // FOUND first). Port of the feed route GET: clamp the limit, decode the cursor,
  // normalize the discovery window, and drop mixtapes when a window is present. The
  // response is the FeedListPage itself — no `ok` envelope.
  const listFindingsHandler = os.list_findings.handler(async ({ input }) => {
    try {
      const limit = parseLimit(input.limit, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
      const cursor = decodeTrackCursor(input.cursor ?? null);
      const since = parseTimestamp(input.since);
      const until = parseTimestamp(input.until);

      const page = await listTracks({
        cursor,
        includeMixtapes: since === undefined && until === undefined,
        // The public feed reads the lean list projection (Finding B4): no list surface
        // renders the heavy caption/feature/reasoning fields, and they stay optional on
        // the `list_findings` contract, so their absence here is additive (get_track still
        // serves the fat single-finding shape for anyone who needs them).
        lean: true,
        limit,
        since,
        until,
      });

      // Strip the private capture key from every item before it world-serves.
      return { ...page, tracks: page.tracks.map(toPublicTrackListItem) };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // `list_tracks` — the whole-archive ENUMERATOR (every track Fluncle holds, newest
  // RELEASE first, numbered pages). The machine twin of the web `/tracks` page: it
  // reads the SAME hosted-proven `listTracksHubPage` hub, so the two never disagree
  // and no new scan over the growing table is invented here. The ONE filter is the
  // tri-state `certified` (findings only / uncertified only / all), folded into the
  // hub's compiled clause set (one gate). A page past the end 404s (never clamps to
  // page 1). Each row is the LEAN `CatalogueTrackListItem` — a finding carries its
  // coordinate + cover, an uncertified row carries neither (the Unlit Rule, structural
  // in the mapper), and the heavy DTO never crosses this boundary.
  const listTracksHandler = os.list_tracks.handler(async ({ input }) => {
    try {
      // Tolerant page parse (mirrors the web route's `pageParam`): junk / absent / < 1
      // folds to page 1, rather than 400-ing.
      const parsedPage = Math.trunc(Number(input.page));
      const page = Number.isFinite(parsedPage) && parsedPage >= 1 ? parsedPage : 1;
      const certified = input.certified === undefined ? undefined : input.certified === "true";

      const result = await listTracksHubPage({ certified }, page);

      return {
        ok: true as const,
        page: result.page,
        pageCount: result.pageCount,
        total: result.total,
        tracks: result.items.map(toCatalogueTrackListItem),
      };
    } catch (error) {
      // A page past the end is a 404 (never a clamp to page 1 — that would be a second
      // URL for page 1's rows), exactly like the web route.
      if (error instanceof CatalogueHubPageOutOfRangeError) {
        throw new ORPCError("NOT_FOUND", { message: `No page ${input.page ?? 1} of tracks` });
      }

      throw apiFault(error);
    }
  });

  // `get_random_track` — one random certified finding. Port of /api/tracks/random
  // GET: the `{ ok: true, track }` envelope, or a 404 with the custom
  // `track_not_found` code/message (carried as fault data so the rails encoder
  // reproduces the exact legacy `jsonError` body, not the generic `not_found`).
  const getRandomTrackHandler = os.get_random_track.handler(async () => {
    try {
      const track = await getRandomTrack();

      if (!track) {
        throw new ORPCError("NOT_FOUND", {
          data: { apiCode: "track_not_found", apiMessage: "No tracks found" },
          message: "No tracks found",
        });
      }

      return { ok: true, track: toPublicTrackListItem(track) } as const;
    } catch (error) {
      if (error instanceof ORPCError) {
        throw error;
      }

      throw apiFault(error);
    }
  });

  // `list_similar_tracks` — the N sonically-nearest findings (the "more like this"
  // cluster). Cosine-ranks the target's MuQ embedding against every other
  // coordinate-bearing finding's, self excluded, similarity order. An unknown
  // coordinate / an un-embedded finding / an empty archive all resolve to
  // `{ ok: true, findings: [] }` (a quiet empty row, never a fault). The limit is
  // parsed tolerantly like the feed's, degrading to the default rather than 400-ing.
  const listSimilarTracksHandler = os.list_similar_tracks.handler(async ({ input }) => {
    try {
      const limit = parseLimit(input.limit, SIMILAR_DEFAULT_LIMIT, SIMILAR_MAX_LIMIT);
      const findings = await getSimilarFindings(input.idOrLogId, limit);

      return { findings: findings.map(toPublicTrackListItem), ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  // `list_mixable_tracks` — the tracks that mix cleanly out of the given one (the `/mix`
  // rail). Ranks the WHOLE archive by the mixability engine (a catalogue track is rankable
  // the moment it has a key, so it competes with the findings on the same terms), excludes
  // the already-chained tracks server-side, and returns each candidate with its reason chip,
  // its `certified` register bit, and NO numeric score. The limit parses tolerantly like the
  // feed's. An unknown coordinate / a keyless target / an empty archive all resolve to
  // `{ findings: [] }`.
  //
  // `taste` is the seed: a comma-separated artist-slug list, which re-ranks the rail by
  // mixability × taste. Absent, the rail is the plain mixability order.
  //
  // NOTHING TO STRIP. The payload is `MixTrackSchema`, which carries no private field to
  // leak (no `sourceAudioKey`, no provenance) — and no finding-only field to leak into the
  // unlit register either. The old `toPublicTrackListItem` pass is gone with the fat DTO it
  // was cleaning up after.
  //
  // RATE LIMIT: accept-risk, no limiter (Decision 2). One key-pre-filtered archive scan,
  // comparable to the existing uncached `list_similar_tracks`. Revisit at archive growth —
  // this is now a PUBLIC page's hot path rather than an admin-gated one.
  const listMixableTracksHandler = os.list_mixable_tracks.handler(async ({ input }) => {
    try {
      const limit = parseLimit(input.limit, MIXABLE_DEFAULT_LIMIT, MIXABLE_MAX_LIMIT);
      // Reuse the canonical `/mix` codec parsers (mix-set) rather than an ad-hoc splitter:
      // `taste` is a seed capped at MAX_TASTE_ARTISTS (10, slug-validated), `exclude` a set
      // of chain tokens capped at MAX_SET_LENGTH (32, token-validated). This is a public
      // unauth read with no rate limiter, so bounding the IN/NOT-IN placeholder lists here
      // keeps a huge query string from inflating the whole-archive vector scan. The web
      // client already enforces these caps, so nothing valid is rejected.
      const findings = await getMixableTracks(input.idOrLogId, {
        artistSlugs: parseTasteParam(input.taste),
        exclude: parseSetParam(input.exclude),
        limit,
      });

      return { findings, ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  // `list_fresh` — WHAT JUST CAME OUT: the flat, capped list of newest RELEASES over the trailing
  // 30-day window (the release-date axis, the opposite of `list_findings`' found-date feed). The lib
  // read returns the unlit-safe shape verbatim (an uncertified row carries no logId/cover), so this
  // is a thin pass-through; the tolerant `limit` string is clamped to [1, 100] (default 50).
  const listFreshHandler = os.list_fresh.handler(async ({ input }) => {
    try {
      const limit = clampFreshLimit(input.limit === undefined ? undefined : Number(input.limit));
      return await listFreshTracks({ limit });
    } catch (error) {
      throw apiFault(error);
    }
  });

  return {
    get_random_track: getRandomTrackHandler,
    get_track: getTrack,
    list_findings: listFindingsHandler,
    list_fresh: listFreshHandler,
    list_mixable_tracks: listMixableTracksHandler,
    list_similar_tracks: listSimilarTracksHandler,
    list_tracks: listTracksHandler,
  };
}
