// The `admin-editions` domain router module — newsletter edition authoring + the
// Resend send. Each handler reuses the live `editions` server logic; the auth tier
// lives in the oRPC procedure middleware (../orpc-auth).
//
// VERIFIED auth tiers:
//   - `list_editions_admin` / `create_edition` / `update_edition` — admin tier
//     (`adminAuth`): reading the draft list + drafting are AGENT-ALLOWED (the Friday
//     cron persists the draft and reads back its own unsent draft from a fresh session).
//   - `send_edition` — operator tier (`adminAuth` + `operatorGuard`): the explicit
//     human gate. A valid agent token gets a 403.
//   - `delete_edition` — operator tier (same as send): the hard delete that pulls an
//     edition (drafts AND sent) from the archive. A valid agent token gets a 403.

import {
  createEdition,
  deleteEdition,
  listEditions,
  sendEdition,
  updateEdition,
} from "../editions";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { apiFault, type Implementer } from "./_shared";

/** Build the `admin-editions` domain's handlers. */
export function adminEditionsHandlers(os: Implementer) {
  // GET /admin/newsletter/editions — admin tier. The full list INCLUDING drafts (the
  // public list_editions is sent-only). The Friday cron reads this from a fresh
  // session to find an unsent draft to re-offer + the last sent edition's window.
  const listEditionsAdminHandler = os.list_editions_admin.use(adminAuth).handler(async () => {
    try {
      return { editions: await listEditions({ includeDrafts: true }), ok: true as const };
    } catch (error) {
      throw apiFault(error);
    }
  });

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

  // DELETE /admin/newsletter/editions/{id} — OPERATOR tier. The hard delete that
  // reaches a SENT edition too (pulling a sent test edition from the public archive
  // is the point). Removes only the row; the already-sent broadcast is untouched.
  const deleteEditionHandler = os.delete_edition
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const { id } = await deleteEdition(input.id);

        return { id, ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  return {
    create_edition: createEditionHandler,
    delete_edition: deleteEditionHandler,
    list_editions_admin: listEditionsAdminHandler,
    send_edition: sendEditionHandler,
    update_edition: updateEditionHandler,
  };
}
