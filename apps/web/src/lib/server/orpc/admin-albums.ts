import { getAlbumBySlug, fillEmptyAlbumBio, listAlbumsMissingBio } from "../albums";
import { purgeEntityCache } from "../edge-cache";
import { buildEntityBioPrompt, fetchEntityFacts, gateOrAcceptBio } from "../bio";
import { adminAuth } from "../orpc-auth";
import { getFindingsByAlbum } from "../tracks";
import { ORPCError } from "@orpc/server";
import { apiFault, type Implementer, parseLimit, toFault } from "./_shared";

export function adminAlbumsHandlers(os: Implementer) {
  const describeAlbumHandler = os.describe_album.use(adminAuth).handler(async ({ input }) => {
    try {
      const dryRun = input.dryRun === true;
      const album = await getAlbumBySlug(input.slug);

      if (!album) {
        throw new ORPCError("NOT_FOUND", {
          data: { apiCode: "not_found", apiMessage: `No album with slug ${input.slug}` },
          message: `No album with slug ${input.slug}`,
          status: 404,
        });
      }

      if (!dryRun && album.bio?.trim()) {
        return { bio: album.bio, ok: true as const, skipped: true as const, slug: album.slug };
      }

      const gated = gateOrAcceptBio({
        bio: input.bio,
        finalAttempt: input.finalAttempt === true,
        kind: "album",
        name: album.name,
        slug: album.slug,
      });

      const { bio } = gated;

      if (dryRun) {
        return { ...gated, dryRun: true as const, ok: true as const, slug: album.slug };
      }

      const filled = await fillEmptyAlbumBio(
        album.slug,
        bio,
        input.promptVersion,
        gated.voiceViolations ?? null,
      );

      if (!filled) {
        const current = await getAlbumBySlug(input.slug);

        return {
          bio: current?.bio ?? bio,
          ok: true as const,
          skipped: true as const,
          slug: album.slug,
        };
      }

      purgeEntityCache("album", album.slug);

      return { ...gated, ok: true as const, slug: album.slug };
    } catch (error) {
      throw toFault(error);
    }
  });

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
