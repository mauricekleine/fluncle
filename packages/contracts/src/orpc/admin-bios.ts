// The `admin-bios` domain contract module — the operator's ruling on a bio that landed past the
// voice gate.
//
// The entity-bio sweep gives an artist / label / album three authoring attempts, and the THIRD
// draft is stored even when the voice scan refuses it (`--final-attempt`). That is an explicit
// operator ruling and this domain does not reverse it: without it the sweep spins on one entity
// forever. What it left behind was an unsupervised outcome — the acceptance announced itself as a
// `FINAL-ATTEMPT ACCEPTANCE` line in a cron's stderr and a `gateBypassed` field on the write
// response, and the documented way to find one was to remember to grep. So a paragraph the gate
// said no to could sit on `/artist/<slug>`, in its JSON-LD, and on the unauthenticated `/mcp`
// surface with nothing surfacing it for review.
//
// The bypass now stamps the entity (`bio_gate_bypassed_at` + the accepted reasons), which raises a
// `bio-review` row on the `/admin` attention queue — the `label-review` mechanism, deliberately,
// rather than a second review channel. This is the one op that clears it.
//
//   - `resolve_bio_review` — OPERATOR tier (`adminAuth` + `operatorGuard`), the
//     `resolve_note_rejection` shape. Ruling on public copy is publish-class in both directions
//     (`keep` blesses a paragraph the gate refused; `rewrite` un-publishes one), so the box's
//     agent token 403s: the agent authors, only the operator overrules the gate.

import { oc } from "@orpc/contract";
import * as z from "zod";

/** Which entity a bio belongs to — the three kinds the sweep authors for. */
export const BioEntityKindSchema = z
  .enum(["album", "artist", "label"])
  .meta({ id: "BioEntityKind" });

/**
 * `resolve_bio_review` → `POST /admin/bio-reviews/{kind}/{slug}/resolve` (operationId
 * `resolveBioReview`).
 *
 * OPERATOR tier (`adminAuth` + `operatorGuard`). The operator's ruling on a bio the final-attempt
 * acceptance let through.
 *
 * `keep` — he read the paragraph beside the gate's reasons and the gate was over-strict. The bio
 * stands exactly as it is; only the review flag is cleared, so the row leaves the queue and the
 * page is untouched.
 *
 * `rewrite` — the gate was right. The bio is EMPTIED (with its prompt provenance, and
 * `bio_status` back to `pending`), which returns the entity to the sweep's own `describe --queue`
 * worklist with a fresh three-attempt budget: the on-box attempt ledger already dropped its line
 * when the bio landed, so nothing on the box needs re-arming. Emptying a public paragraph is why
 * an agent token 403s here.
 *
 * Both rulings are guarded in SQL by `bio_gate_bypassed_at is not null`, so a replayed or racing
 * ruling can never empty a bio nobody flagged — it matches no row and answers 404.
 *
 * Codes: `not_found`/404 (no such entity, or nothing under review for it).
 */
export const resolveBioReview = oc
  .route({
    method: "POST",
    operationId: "resolveBioReview",
    path: "/admin/bio-reviews/{kind}/{slug}/resolve",
    summary: "Rule on a bio that landed past the voice gate: keep it or send it back (operator)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      kind: BioEntityKindSchema,
      resolution: z.enum(["keep", "rewrite"]),
      slug: z.string(),
    }),
  )
  .output(
    z.object({
      kind: BioEntityKindSchema,
      ok: z.literal(true),
      resolution: z.enum(["keep", "rewrite"]),
      slug: z.string(),
    }),
  );

/** The `admin-bios` domain's ops, merged into the root contract by `./index.ts`. */
export const adminBiosContract = {
  resolve_bio_review: resolveBioReview,
};
