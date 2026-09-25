import { subscribeToNewsletter } from "../newsletter";
import { apiFault, type Implementer } from "./_shared";

export function newsletterHandlers(os: Implementer) {
  const subscribeNewsletterHandler = os.subscribe_newsletter.handler(async ({ context, input }) => {
    try {
      await subscribeToNewsletter(input, context.request);

      return { ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  return { subscribe_newsletter: subscribeNewsletterHandler };
}
