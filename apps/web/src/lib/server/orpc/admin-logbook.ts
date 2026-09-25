import {
  createLogbookEntry,
  listLogbookGaps,
  listSpentMoves,
  requireSector,
  updateLogbookEntry,
} from "../logbook";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { apiFault, parseLimit, type Implementer } from "./_shared";

export function adminLogbookHandlers(os: Implementer) {
  const listLogbookGapsHandler = os.list_logbook_gaps.use(adminAuth).handler(async ({ input }) => {
    try {
      const limit = parseLimit(input.limit, 5, 30);

      const [gaps, spent] = await Promise.all([listLogbookGaps({ limit }), listSpentMoves()]);

      return { gaps, ok: true as const, spent };
    } catch (error) {
      throw apiFault(error);
    }
  });

  const createLogbookEntryHandler = os.create_logbook_entry
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const sector = requireSector(input.sector);
        const { entry, skipped } = await createLogbookEntry(sector, {
          body: input.body,

          promptVersion: typeof input.promptVersion === "number" ? input.promptVersion : null,
          title: input.title,
        });

        return { entry, ok: true as const, ...(skipped ? { skipped: true as const } : {}) };
      } catch (error) {
        throw apiFault(error);
      }
    });

  const updateLogbookEntryHandler = os.update_logbook_entry
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const sector = requireSector(input.sector);
        const entry = await updateLogbookEntry(sector, {
          body: input.body,
          title: input.title,
        });

        return { entry, ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  return {
    create_logbook_entry: createLogbookEntryHandler,
    list_logbook_gaps: listLogbookGapsHandler,
    update_logbook_entry: updateLogbookEntryHandler,
  };
}
