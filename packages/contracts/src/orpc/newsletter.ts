// The `newsletter` domain contract module. Owns the public newsletter-subscribe
// write op; a future wave adds an op here and one import line in `./index.ts`,
// touching no other domain's file.

import { oc } from "@orpc/contract";
import * as z from "zod";

/**
 * The subscribe request body (`NewsletterInput` in the server `newsletter`
 * module). Both fields are OPTIONAL UNKNOWN and the object is LOOSE: as with
 * submissions, the live route does NOT schema-validate — `subscribeToNewsletter`
 * → `validateInput` owns the email/honeypot checks and emits the exact
 * `invalid_email`/`invalid_request`/`rate_limited` codes. A permissive contract
 * input keeps oRPC from pre-rejecting a valid-JSON body so that validation, and
 * its codes, stay byte-for-byte the live behavior.
 */
const NewsletterBodySchema = z.looseObject({
  email: z.unknown().optional(),
  honeypot: z.unknown().optional(),
});

/**
 * `subscribe_newsletter` → `POST /newsletter` (operationId `subscribeNewsletter`).
 *
 * Board the newsletter. Converted at its CURRENT path `POST /newsletter` (the
 * future `/newsletter/subscribe` move is a separate build). The live route emits
 * the bare `{ ok: true }` envelope on success — no echo of the email; the
 * contract output preserves that exactly. Validation/upstream faults
 * (`invalid_email`/400, `rate_limited`/429|503, `subscribe_failed`/502) are
 * carried through the rails fault encoder for the precise legacy body.
 */
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

/** The `newsletter` domain's ops, merged into the root contract by `./index.ts`. */
export const newsletterContract = {
  subscribe_newsletter: subscribeNewsletter,
};
