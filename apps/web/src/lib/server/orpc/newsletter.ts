// The `newsletter` domain router module. Implements the public
// newsletter-subscribe write op off the shared implementer the root (../orpc.ts)
// hands in. A future wave adds an op here and one spread line in the root — no
// other domain's file is touched.

import { type NewsletterInput, subscribeToNewsletter } from "../newsletter";
import { apiFault, type Implementer } from "./_shared";

/**
 * Build the `newsletter` domain's handlers — a direct port of the live
 * /api/newsletter route, preserving the bare `{ ok: true }` envelope
 * byte-for-byte. The body is handed straight to `subscribeToNewsletter`, whose
 * `validateInput` owns the email/honeypot checks and emits the exact
 * `invalid_email`/400, `rate_limited`/429|503, `subscribe_failed`/502 codes; all
 * flow through `apiFault` so the rails encoder reproduces the legacy `jsonError`
 * body.
 */
export function newsletterHandlers(os: Implementer) {
  // `subscribe_newsletter` — board the newsletter (at the current `POST
  // /newsletter` path). Port of /api/newsletter POST: the contract has parsed the
  // JSON body into `input` (a loose object mirroring `NewsletterInput`); pass it
  // through and emit the bare `{ ok: true }` the live route returns.
  const subscribeNewsletterHandler = os.subscribe_newsletter.handler(async ({ context, input }) => {
    try {
      await subscribeToNewsletter(input as NewsletterInput, context.request);

      return { ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  return { subscribe_newsletter: subscribeNewsletterHandler };
}
