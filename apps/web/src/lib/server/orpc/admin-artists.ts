// The `admin-artists` domain router module — the artist-entity backfill (Unit 1 of
// the artist-relationship RFC). Follows the `admin-backfills` pattern: a bounded,
// cursor-resumable, agent-tier POST with query params.
//
//   - `backfill_artists` — agent tier (`adminAuth`): the box's `fluncle-artist-backfill`
//     cron drives this. For each eligible finding (no track_artists row yet), the
//     Worker re-fetches the Spotify track metadata and upserts artists + track_artists.
//     Idempotent per finding; rate-paced to stay inside Spotify's burst ceiling.

import {
  addArtistSocial,
  ArtistSocialNotFoundError,
  confirmArtistSocial,
  fillEmptyArtistBio,
  getArtistBySlug,
  InvalidArtistSocialError,
  listArtistsMissingBio,
  listArtistSocialsQueue,
  removeArtistSocial,
  reviewArtist,
  reviewArtistSocial,
  updateArtistSocial,
} from "../artists";
import { listUnresolvedArtists, resolveArtist } from "../artist-resolution";
import { backfillArtistImages } from "../backfill-artist-images";
import { backfillArtists } from "../backfill-artists";
import { buildEntityBioPrompt, fetchEntityFacts, gateBioText } from "../bio";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { getFindingsByArtist } from "../tracks";
import { ORPCError } from "@orpc/server";
import { apiFault, type Implementer, parseBool, parseLimit, toFault } from "./_shared";

const BACKFILL_DEFAULT_LIMIT = 10;
const BACKFILL_MAX_LIMIT = 50;

// The resolve worklist page cap (Unit 2.1's `fluncle-artist-sweep` reads this page).
const QUEUE_DEFAULT_LIMIT = 50;
const QUEUE_MAX_LIMIT = 50;

// Re-express a missing-social / invalid-input server error as the matching oRPC fault
// so the rails encoder reproduces the legacy `{ code, message }` body at the right status.
function toSocialFault(error: unknown): ORPCError<string, { apiCode: string; apiMessage: string }> {
  if (error instanceof ArtistSocialNotFoundError) {
    return new ORPCError("NOT_FOUND", {
      data: { apiCode: "not_found", apiMessage: error.message },
      message: error.message,
      status: 404,
    });
  }

  if (error instanceof InvalidArtistSocialError) {
    return new ORPCError("BAD_REQUEST", {
      data: { apiCode: "invalid_request", apiMessage: error.message },
      message: error.message,
      status: 400,
    });
  }

  return apiFault(error);
}

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

  // POST /admin/backfill/artist-images — agent tier (`adminAuth`): fetch the largest
  // Spotify avatar for artists missing one. Internal + reversible enrichment (no
  // publish), so the box's agent-token cron drives it.
  const backfillArtistImagesHandler = os.backfill_artist_images
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const { query } = input;
        const result = await backfillArtistImages(
          parseLimit(query.limit, BACKFILL_DEFAULT_LIMIT, BACKFILL_MAX_LIMIT),
          parseBool(query.dryRun),
          query.cursor ?? undefined,
        );

        return {
          dryRun: result.dryRun,
          failed: result.failed,
          failedCount: result.failedCount,
          filled: result.filled,
          filledCount: result.filledCount,
          nextCursor: result.nextCursor,
          ok: true as const,
          skipped: result.skipped,
          skippedCount: result.skippedCount,
        };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // GET /admin/artists/socials — admin tier (agent-allowed read): the review queue for
  // the `/admin/artists` station. Returns artists with unconfirmed socials; `fresh=true`
  // widens to every artist carrying an unreviewed link (the board's fresh-links rule).
  const listArtistSocialsHandler = os.list_artist_socials
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const limit = parseLimit(input.limit, 100, 500);

        return {
          artists: await listArtistSocialsQueue(limit, parseBool(input.fresh)),
          ok: true as const,
        };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // POST /admin/artists/socials/{socialId}/confirm — operator tier: candidate → confirmed.
  const confirmArtistSocialHandler = os.confirm_artist_social
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        return { ok: true as const, social: await confirmArtistSocial(input.socialId) };
      } catch (error) {
        throw toSocialFault(error);
      }
    });

  // POST /admin/artists/{artistId}/review — operator tier: the "Looks good" acknowledgment.
  // Bulk-stamps every one of the artist's links reviewed + promotes surviving candidates.
  const reviewArtistHandler = os.review_artist
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const { confirmed } = await reviewArtist(input.artistId);

        return { confirmed, ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // POST /admin/artists/socials/{socialId}/review — operator tier: approve ONE fresh link (the
  // fresh-links section's "approve"). Stamps reviewed_at + promotes a candidate to confirmed.
  const reviewArtistSocialHandler = os.review_artist_social
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        return { ok: true as const, social: await reviewArtistSocial(input.socialId) };
      } catch (error) {
        throw toSocialFault(error);
      }
    });

  // POST /admin/artists/{artistId}/socials — operator tier: add/replace a social by platform.
  const addArtistSocialHandler = os.add_artist_social
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const platform = typeof input.platform === "string" ? input.platform : "";
        const url = typeof input.url === "string" ? input.url : "";

        return {
          ok: true as const,
          social: await addArtistSocial(input.artistId, platform, url),
        };
      } catch (error) {
        throw toSocialFault(error);
      }
    });

  // PATCH /admin/artists/socials/{socialId} — operator tier: the fresh-links INLINE EDIT.
  // Validate + normalize the entered URL against the row's platform, then store it operator-
  // owned + confirmed + reviewed (correct AND approve in one act). Loose body carries `url`.
  const updateArtistSocialHandler = os.update_artist_social
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const url = typeof input.url === "string" ? input.url : "";

        return { ok: true as const, social: await updateArtistSocial(input.socialId, url) };
      } catch (error) {
        throw toSocialFault(error);
      }
    });

  // DELETE /admin/artists/socials/{socialId} — operator tier: remove a social.
  const removeArtistSocialHandler = os.remove_artist_social
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        await removeArtistSocial(input.socialId);

        return { ok: true as const };
      } catch (error) {
        throw toSocialFault(error);
      }
    });

  // GET /admin/artists — agent tier (`adminAuth`): the artist-sweep worklist. A bounded,
  // cursor-paged page of artists still awaiting social resolution (`resolved_at IS NULL`),
  // oldest-first. The cron reads this, then resolves each.
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

  // POST /admin/artists/{slug}/bio — agent tier (`adminAuth`), the note_track precedent:
  // the on-box sweep authored the artist's bio; this VOICE-GATES it and stores it
  // FILL-EMPTY-ONLY. A bio already on file (operator OR previously auto-authored) is a
  // skipped no-op — the operator override always wins, enforced atomically at the DB.
  const describeArtistHandler = os.describe_artist.use(adminAuth).handler(async ({ input }) => {
    try {
      // `dryRun` runs the voice gate and stores nothing (the sweep's pre-check).
      const dryRun = input.dryRun === true;
      const artist = await getArtistBySlug(input.slug);

      if (!artist) {
        throw new ORPCError("NOT_FOUND", {
          data: { apiCode: "not_found", apiMessage: `No artist with slug ${input.slug}` },
          message: `No artist with slug ${input.slug}`,
          status: 404,
        });
      }

      // Fast-path skip: a bio already on file short-circuits before the gate runs. The
      // real guarantee is the DB predicate in `fillEmptyArtistBio` below — a bio that
      // lands AFTER this read still cannot be clobbered.
      if (!dryRun && artist.bio?.trim()) {
        return { bio: artist.bio, ok: true as const, skipped: true as const, slug: artist.slug };
      }

      // Voice-gate the agent-authored bio (defence in depth: the sweep gates as it writes;
      // the Worker re-scans and hard-fails any violation before the bio is stored).
      const bio = gateBioText(input.bio);

      if (dryRun) {
        return { bio, dryRun: true as const, ok: true as const, slug: artist.slug };
      }

      // Fill the empty bio ATOMICALLY — the fill-empty-only predicate lives in the SQL, so
      // an operator bio (or a concurrent tick) that landed between our read and this write
      // matches no row and reports skipped, never clobbered.
      const filled = await fillEmptyArtistBio(artist.slug, bio, input.promptVersion);

      if (!filled) {
        const current = await getArtistBySlug(input.slug);

        return {
          bio: current?.bio ?? bio,
          ok: true as const,
          skipped: true as const,
          slug: artist.slug,
        };
      }

      return { bio, ok: true as const, slug: artist.slug };
    } catch (error) {
      throw toFault(error);
    }
  });

  // GET /admin/artists/{slug}/bio-draft — agent tier (`adminAuth`): the Worker-paced
  // grounding seam. The box cannot gather Firecrawl facts (no key) or enumerate finding
  // TITLES (not on the wire), so it triggers this READ: the Worker runs the Firecrawl gather
  // with ITS key + pulls the logged finding titles from ITS DB, assembles the registered bio
  // prompt, and returns the ready-to-author prompt + its provenance version. The box then
  // authors with `claude -p` and writes back via `describe_artist`. Publishes nothing; the
  // context-note sweep's Worker-side twin. A missing slug returns `found:false` (never throws).
  const draftArtistBioHandler = os.draft_artist_bio.use(adminAuth).handler(async ({ input }) => {
    try {
      const artist = await getArtistBySlug(input.slug);

      if (!artist) {
        return {
          findingCount: 0,
          found: false as const,
          hasFacts: false,
          name: "",
          prompt: "",
          promptVersion: 0,
        };
      }

      // Gather Worker-side: Firecrawl facts (with the Worker's key) + the logged finding
      // titles (with the Worker's DB) — the two the box cannot reach. Both best-effort.
      const facts = await fetchEntityFacts({ kind: "artist", name: artist.name });
      const findings = await getFindingsByArtist(artist.id, artist.name);
      const findingTitles = findings.map((finding) => finding.title);

      const { body, version } = await buildEntityBioPrompt({
        facts: facts?.facts ?? null,
        findingTitles,
        kind: "artist",
        name: artist.name,
      });

      return {
        findingCount: findingTitles.length,
        found: true as const,
        hasFacts: facts != null,
        name: artist.name,
        prompt: body,
        promptVersion: version,
      };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // GET /admin/artists/bio-queue — agent tier (`adminAuth`), the list_unresolved_artists
  // precedent: the bio worklist (artists with findings but no bio yet), oldest-first.
  const listArtistsMissingBioHandler = os.list_artists_missing_bio
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const artists = await listArtistsMissingBio(parseLimit(input.limit, 50, 200));

        return { artists, ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  return {
    add_artist_social: addArtistSocialHandler,
    backfill_artist_images: backfillArtistImagesHandler,
    backfill_artists: backfillArtistsHandler,
    confirm_artist_social: confirmArtistSocialHandler,
    describe_artist: describeArtistHandler,
    draft_artist_bio: draftArtistBioHandler,
    list_artist_socials: listArtistSocialsHandler,
    list_artists_missing_bio: listArtistsMissingBioHandler,
    list_unresolved_artists: listUnresolvedArtistsHandler,
    remove_artist_social: removeArtistSocialHandler,
    resolve_artist: resolveArtistHandler,
    review_artist: reviewArtistHandler,
    review_artist_social: reviewArtistSocialHandler,
    update_artist_social: updateArtistSocialHandler,
  };
}
