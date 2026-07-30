// The `admin-bios` domain router module — the ruling on a bio that landed past the voice gate.
//
// One op, on the `admin-notes` pattern:
//
//   - `resolve_bio_review` — `adminAuth` + `operatorGuard` (OPERATOR). Both rulings are
//     publish-class in one direction or the other — `keep` blesses a public paragraph the voice
//     gate refused, `rewrite` un-publishes one — so the box's agent token 403s. The agent authors
//     bios (`describe_artist` / `describe_label` / `describe_album`, all agent tier); only the
//     operator overrules the gate, exactly as with a held auto-note.
//
// The final-attempt acceptance itself is NOT weakened here. `gateOrAcceptBio` still stores the
// sweep's third draft; it simply no longer does it where nobody can see. See lib/server/bio-review.ts.

import { resolveBioReview } from "../bio-review";
import { purgeEntityCache } from "../edge-cache";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { ORPCError } from "@orpc/server";
import { apiFault, type Implementer } from "./_shared";

/** Build the `admin-bios` domain's handlers. */
export function adminBiosHandlers(os: Implementer) {
  // POST /admin/bio-reviews/{kind}/{slug}/resolve — OPERATOR tier: keep the bypassed bio (clears
  // the review flag, page untouched) or send it back (empties the bio, so the sweep re-authors).
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

        // Nothing matched: an unknown slug, or a review a previous ruling already settled. Report
        // it rather than answering ok — a queue the operator cannot trust is the thing this fixes.
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

        // `rewrite` emptied a rendered block on the public entity page; drop its cached page so the
        // paragraph stops being served. `keep` changed nothing public, so it needs no purge — but
        // the call is cheap and unconditional keeps the two rulings from drifting.
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
