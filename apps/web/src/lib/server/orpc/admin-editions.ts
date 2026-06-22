// The `admin-editions` domain router module — newsletter edition authoring + the
// Resend send. Each handler reuses the live `editions` server logic; the auth tier
// lives in the oRPC procedure middleware (../orpc-auth).
//
// VERIFIED auth tiers (docs/rfcs/newsletter-own-the-stack.md §3.3):
//   - `create_edition` / `update_edition` — admin tier (`adminAuth`): drafting is
//     AGENT-ALLOWED (the Friday agent persists the draft).
//   - `send_edition` — operator tier (`adminAuth` + `operatorGuard`): the explicit
//     human gate. A valid agent token gets a 403.

import { createEdition, sendEdition, updateEdition } from "../editions";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { apiFault, type Implementer } from "./_shared";

/** Build the `admin-editions` domain's handlers. */
export function adminEditionsHandlers(os: Implementer) {
  // POST /admin/newsletter/editions — admin tier (drafting is agent-allowed).
  const createEditionHandler = os.create_edition.use(adminAuth).handler(async ({ input }) => {
    try {
      return { edition: await createEdition(input), ok: true as const };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // PATCH /admin/newsletter/editions/{id} — admin tier.
  const updateEditionHandler = os.update_edition.use(adminAuth).handler(async ({ input }) => {
    try {
      const { id, ...body } = input as { id: string } & Record<string, unknown>;
      const edition = await updateEdition(id, body);

      return { edition, ok: true as const };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // POST /admin/newsletter/editions/{id}/send — OPERATOR tier (the human gate).
  const sendEditionHandler = os.send_edition
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const body = input as { id: string; scheduledAt?: unknown };
        const scheduledAt =
          typeof body.scheduledAt === "string" && body.scheduledAt.trim()
            ? body.scheduledAt.trim()
            : undefined;
        const edition = await sendEdition(body.id, { scheduledAt });

        return { edition, ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  return {
    create_edition: createEditionHandler,
    send_edition: sendEditionHandler,
    update_edition: updateEditionHandler,
  };
}
