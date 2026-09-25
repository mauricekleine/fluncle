import { resolveBioReview } from "../bio-review";
import { purgeEntityCache } from "../edge-cache";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { ORPCError } from "@orpc/server";
import { apiFault, type Implementer } from "./_shared";

export function adminBiosHandlers(os: Implementer) {
  const resolveBioReviewHandler = os.resolve_bio_review
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const resolved = await resolveBioReview({
          kind: input.kind,
          resolution: input.resolution,
          slug: input.slug,
        });

        if (!resolved) {
          throw new ORPCError("NOT_FOUND", {
            data: {
              apiCode: "not_found",
              apiMessage: `No open bio review for ${input.kind} ${input.slug}`,
            },
            message: `No open bio review for ${input.kind} ${input.slug}`,
            status: 404,
          });
        }

        purgeEntityCache(input.kind, input.slug);

        return {
          kind: input.kind,
          ok: true,
          resolution: input.resolution,
          slug: input.slug,
        } as const;
      } catch (error) {
        if (error instanceof ORPCError) {
          throw error;
        }

        throw apiFault(error);
      }
    });

  return {
    resolve_bio_review: resolveBioReviewHandler,
  };
}
