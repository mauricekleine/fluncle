// The `admin-artists` domain router module — the artist-entity backfill (Unit 1 of
// the artist-relationship RFC). Follows the `admin-backfills` pattern: a bounded,
// cursor-resumable, agent-tier POST with query params.
//
//   - `backfill_artists` — agent tier (`adminAuth`): the box's `fluncle-artist-backfill`
//     cron drives this. For each eligible finding (no track_artists row yet), the
//     Worker re-fetches the Spotify track metadata and upserts artists + track_artists.
//     Idempotent per finding; rate-paced to stay inside Spotify's burst ceiling.

import { implement } from "@orpc/server";
import { adminArtistsContract } from "@fluncle/contracts/orpc";
import { type OrpcContext } from "../orpc-auth";
import { backfillArtists } from "../backfill-artists";
import { adminAuth } from "../orpc-auth";
import { apiFault, type Implementer, parseBool, parseLimit } from "./_shared";

const BACKFILL_DEFAULT_LIMIT = 10;
const BACKFILL_MAX_LIMIT = 50;

// A sub-implementer scoped to the admin-artists contract. TypeScript reliably
// computes the mapped type for a 1-key contract; the full 97-op Implementer hits
// a type-inference limit that drops some keys (a known TS limitation for large
// contracts). Using implement<..., OrpcContext>() directly (not $context<>())
// keeps TInitialContext = OrpcContext (not OrpcContext & Record<never, never>),
// which the router's Router<typeof contract, OrpcContext> constraint requires.
const adminArtistsOs = implement<typeof adminArtistsContract, OrpcContext>(adminArtistsContract);

/**
 * Build the `admin-artists` domain's handlers.
 */
export function adminArtistsHandlers(_os: Implementer) {
  // POST /admin/backfill/artists — agent tier (`adminAuth`): internal + reversible
  // metadata enrichment (no publish), so the box's agent-token cron drives it.
  const backfillArtistsHandler = adminArtistsOs.backfill_artists
    .use(adminAuth)
    .handler(async ({ input }) => {
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

  return {
    backfill_artists: backfillArtistsHandler,
  };
}
