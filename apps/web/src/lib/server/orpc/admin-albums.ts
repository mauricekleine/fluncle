// The `admin-albums` domain router module — the album entity's admin surface. An album
// carries no operator control (no crawl-seed ruling, no alias review — docs/album-entity.md:
// an album is not a crawl seed, so there is nothing to rule on), so this domain is the
// voiced-bio engine and nothing else, on the `admin-labels` bio pattern.
//
// The three bio ops are all `adminAuth` (agent-allowed): the on-box sweep authors the album's
// bio, this VOICE-GATES it and stores it FILL-EMPTY-ONLY (a bio already on file — operator OR
// previously auto-authored — is a skipped no-op). Authoring a bio is enrichment, not an
// editorial ruling, so there is no operator-tier op here. See docs/agents/bio-agent.md.

import { getAlbumBySlug, fillEmptyAlbumBio, listAlbumsMissingBio } from "../albums";
import { buildEntityBioPrompt, fetchEntityFacts, gateBioText } from "../bio";
import { adminAuth } from "../orpc-auth";
import { getFindingsByAlbum } from "../tracks";
import { ORPCError } from "@orpc/server";
import { apiFault, type Implementer, parseLimit, toFault } from "./_shared";

/** Build the `admin-albums` domain's handlers. */
export function adminAlbumsHandlers(os: Implementer) {
  // POST /admin/albums/{slug}/bio — agent tier (`adminAuth`), the note_track precedent:
  // the on-box sweep authored the album's bio; this VOICE-GATES it and stores it
  // FILL-EMPTY-ONLY. A bio already on file (operator OR previously auto-authored) is a
  // skipped no-op.
  const describeAlbumHandler = os.describe_album.use(adminAuth).handler(async ({ input }) => {
    try {
      // `dryRun` runs the voice gate and stores nothing (the sweep's pre-check).
      const dryRun = input.dryRun === true;
      const album = await getAlbumBySlug(input.slug);

      if (!album) {
        throw new ORPCError("NOT_FOUND", {
          data: { apiCode: "not_found", apiMessage: `No album with slug ${input.slug}` },
          message: `No album with slug ${input.slug}`,
          status: 404,
        });
      }

      // Fast-path skip; the real guarantee is the DB predicate in `fillEmptyAlbumBio`.
      if (!dryRun && album.bio?.trim()) {
        return { bio: album.bio, ok: true as const, skipped: true as const, slug: album.slug };
      }

      // Voice-gate the agent-authored bio (defence in depth, re-scanned server-side).
      const bio = gateBioText(input.bio);

      if (dryRun) {
        return { bio, dryRun: true as const, ok: true as const, slug: album.slug };
      }

      // Fill the empty bio ATOMICALLY — the fill-empty-only predicate lives in the SQL.
      const filled = await fillEmptyAlbumBio(album.slug, bio, input.promptVersion);

      if (!filled) {
        const current = await getAlbumBySlug(input.slug);

        return {
          bio: current?.bio ?? bio,
          ok: true as const,
          skipped: true as const,
          slug: album.slug,
        };
      }

      return { bio, ok: true as const, slug: album.slug };
    } catch (error) {
      throw toFault(error);
    }
  });

  // GET /admin/albums/{slug}/bio-draft — agent tier (`adminAuth`): the Worker-paced grounding
  // seam (the describe_album sibling). The box cannot gather Firecrawl facts (no key) or
  // enumerate the tracks it has logged off an album (not on the wire), so it triggers this
  // READ: the Worker runs the Firecrawl gather with ITS key + pulls the logged finding titles
  // from ITS DB, assembles the registered bio prompt, and returns the ready-to-author prompt +
  // its provenance version. The box then authors with `claude -p` and writes back via
  // `describe_album`. Publishes nothing. A missing slug returns `found:false` (never throws).
  const draftAlbumBioHandler = os.draft_album_bio.use(adminAuth).handler(async ({ input }) => {
    try {
      const album = await getAlbumBySlug(input.slug);

      if (!album) {
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
      const facts = await fetchEntityFacts({ kind: "album", name: album.name });
      const findings = await getFindingsByAlbum(album.id);
      const findingTitles = findings.map((finding) => finding.title);

      const { body, version } = await buildEntityBioPrompt({
        facts: facts?.facts ?? null,
        findingTitles,
        kind: "album",
        name: album.name,
      });

      return {
        findingCount: findingTitles.length,
        found: true as const,
        hasFacts: facts != null,
        name: album.name,
        prompt: body,
        promptVersion: version,
      };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // GET /admin/albums/bio-queue — agent tier (`adminAuth`), the list_labels_missing_bio
  // precedent: the bio worklist (albums with findings but no bio yet), oldest-first.
  const listAlbumsMissingBioHandler = os.list_albums_missing_bio
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const albums = await listAlbumsMissingBio(parseLimit(input.limit, 50, 200));

        return { albums, ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  return {
    describe_album: describeAlbumHandler,
    draft_album_bio: draftAlbumBioHandler,
    list_albums_missing_bio: listAlbumsMissingBioHandler,
  };
}
