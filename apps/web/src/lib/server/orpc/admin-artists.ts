// The `admin-artists` domain router module — artist entity operations (artist-
// relationship RFC). Follows the `admin-backfills` pattern for backfill; adds
// the resolution op for the social-identity sweep.
//
//   - `backfill_artists` — agent tier (`adminAuth`): the box's `fluncle-artist-backfill`
//     cron drives this. For each eligible finding (no track_artists row yet), the
//     Worker re-fetches the Spotify track metadata and upserts artists + track_artists.
//     Idempotent per finding; rate-paced to stay inside Spotify's burst ceiling.
//
//   - `resolve_artist` — agent tier (`adminAuth`): triggers the MB url-rels walk +
//     Firecrawl /v2/extract gap-fill for one artist. Driven by the on-box
//     `fluncle-artist-sweep` cron or the CLI for ad-hoc resolution.

import { backfillArtists } from "../backfill-artists";
import { listUnresolvedArtists, resolveArtist } from "../artist-resolution";
import { adminAuth } from "../orpc-auth";
import { apiFault, type Implementer, parseBool, parseLimit } from "./_shared";

const BACKFILL_DEFAULT_LIMIT = 10;
const BACKFILL_MAX_LIMIT = 50;

const QUEUE_DEFAULT_LIMIT = 50;
const QUEUE_MAX_LIMIT = 50;

/**
 * Build the `admin-artists` domain's handlers.
 */
export function adminArtistsHandlers(os: Implementer) {
  // POST /admin/backfill/artists — agent tier (`adminAuth`): internal + reversible
  // metadata enrichment (no publish), so the box's agent-token cron drives it.
  const backfillArtistsHandler = os.backfill_artists.use(adminAuth).handler(async ({ input }) => {
    try {
      const { query } = input;
      const result = await backfillArtists(
        parseLimit(query.limit, BACKFILL_DEFAULT_LIMIT, BACKFILL_MAX_LIMIT),
        parseBool(query.dryRun),
        query.cursor ?? undefined,
      );

      return {
        dryRun: result.dryRun,
        failed: result.failed,
        failedCount: result.failedCount,
        nextCursor: result.nextCursor,
        ok: true as const,
        skipped: result.skipped,
        skippedCount: result.skippedCount,
        upserted: result.upserted,
        upsertedCount: result.upsertedCount,
      };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // GET /admin/artists — agent tier (`adminAuth`): the artist-sweep worklist. A
  // bounded, cursor-paged page of artists still awaiting social resolution
  // (`resolved_at IS NULL`), oldest-first. The cron reads this, then resolves each.
  const listUnresolvedArtistsHandler = os.list_unresolved_artists
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const result = await listUnresolvedArtists(
          parseLimit(input.limit, QUEUE_DEFAULT_LIMIT, QUEUE_MAX_LIMIT),
          input.cursor ?? undefined,
        );

        return {
          artists: result.artists,
          nextCursor: result.nextCursor,
          ok: true as const,
        };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // POST /admin/artists/{artistId}/resolve — agent tier (`adminAuth`): MB url-rels
  // walk + Firecrawl gap-fill for one artist. The on-box cron loops the worklist;
  // the CLI calls this ad-hoc. Returns the resolved socials + mbid + wikidata QID.
  const resolveArtistHandler = os.resolve_artist.use(adminAuth).handler(async ({ input }) => {
    try {
      const result = await resolveArtist(input.artistId);

      return {
        artistId: input.artistId,
        mbid: result.mbid,
        ok: true as const,
        rateLimited: result.rateLimited,
        socials: result.socials,
        socialsCount: result.socials.length,
        wikidataQid: result.wikidataQid,
      };
    } catch (error) {
      throw apiFault(error);
    }
  });

  return {
    backfill_artists: backfillArtistsHandler,
    list_unresolved_artists: listUnresolvedArtistsHandler,
    resolve_artist: resolveArtistHandler,
  };
}
