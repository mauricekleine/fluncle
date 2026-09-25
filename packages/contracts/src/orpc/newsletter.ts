import { oc } from "@orpc/contract";
import * as z from "zod";

const NewsletterBodySchema = z.looseObject({
  email: z.unknown().optional(),
  honeypot: z.unknown().optional(),
});

export type NewsletterBody = z.infer<typeof NewsletterBodySchema>;

export const subscribeNewsletter = oc
  .route({
    method: "POST",
    operationId: "subscribeNewsletter",
    path: "/newsletter",
    summary: "Board the newsletter",
    tags: ["Newsletter"],
  })
  .input(NewsletterBodySchema)
  .output(z.object({ ok: z.literal(true) }));

export const newsletterContract = {
  subscribe_newsletter: subscribeNewsletter,
};
