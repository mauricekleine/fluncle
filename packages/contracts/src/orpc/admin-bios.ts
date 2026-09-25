import { oc } from "@orpc/contract";
import * as z from "zod";

export const BioEntityKindSchema = z
  .enum(["album", "artist", "label"])
  .meta({ id: "BioEntityKind" });

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

export const adminBiosContract = {
  resolve_bio_review: resolveBioReview,
};
