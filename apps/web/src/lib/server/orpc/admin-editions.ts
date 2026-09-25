import {
  createEdition,
  deleteEdition,
  listEditions,
  sendEdition,
  updateEdition,
} from "../editions";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { apiFault, type Implementer } from "./_shared";

export function adminEditionsHandlers(os: Implementer) {
  const listEditionsAdminHandler = os.list_editions_admin.use(adminAuth).handler(async () => {
    try {
      return { editions: await listEditions({ includeDrafts: true }), ok: true as const };
    } catch (error) {
      throw apiFault(error);
    }
  });

  const createEditionHandler = os.create_edition.use(adminAuth).handler(async ({ input }) => {
    try {
      return { edition: await createEdition(input), ok: true as const };
    } catch (error) {
      throw apiFault(error);
    }
  });

  const updateEditionHandler = os.update_edition.use(adminAuth).handler(async ({ input }) => {
    try {
      const { id, ...body } = input;
      const edition = await updateEdition(id, body);

      return { edition, ok: true as const };
    } catch (error) {
      throw apiFault(error);
    }
  });

  const sendEditionHandler = os.send_edition
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const scheduledAt =
          typeof input.scheduledAt === "string" && input.scheduledAt.trim()
            ? input.scheduledAt.trim()
            : undefined;
        const edition = await sendEdition(input.id, { scheduledAt });

        return { edition, ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

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
