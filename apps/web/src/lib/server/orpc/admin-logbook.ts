// The `admin-logbook` domain router module — Fluncle's Logbook write path + the
// nightly sweep's gap/gather read. Each handler reuses the live `logbook` server
// logic; the auth tier lives in the oRPC procedure middleware (../orpc-auth).
//
// VERIFIED auth tiers:
//   - `list_logbook_gaps`    — admin tier (`adminAuth`): the sweep's queue+material
//     read is AGENT-ALLOWED (the box's `fluncle-logbook` cron drives it, the note
//     queue / `list_editions_admin` precedent).
//   - `create_logbook_entry` — admin tier (`adminAuth`): the fill-empty-only author
//     the on-box sweep drives with its agent token (`note_track` precedent). A sector
//     that already has an entry is a no-op (`skipped: true`) — never a clobber.
//   - `update_logbook_entry` — OPERATOR tier (`adminAuth` + `operatorGuard`): the
//     operator's overwrite path CAN replace an entry, so a valid agent token 403s.

import {
  createLogbookEntry,
  listLogbookGaps,
  listSpentMoves,
  requireSector,
  updateLogbookEntry,
} from "../logbook";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { apiFault, parseLimit, type Implementer } from "./_shared";

/** Build the `admin-logbook` domain's handlers. */
export function adminLogbookHandlers(os: Implementer) {
  // GET /admin/logbook/gaps — admin tier (agent-allowed). The sweep's self-healing
  // window + material read.
  const listLogbookGapsHandler = os.list_logbook_gaps.use(adminAuth).handler(async ({ input }) => {
    try {
      const limit = parseLimit(input.limit, 5, 30);
      // The worklist AND the anti-sameness fuel in one read: the eligible gaps + the recent
      // authored entries' spent titles/moves, so the sweep authors against both at once.
      const [gaps, spent] = await Promise.all([listLogbookGaps({ limit }), listSpentMoves()]);

      return { gaps, ok: true as const, spent };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // POST /admin/logbook/{sector} — admin tier (agent-allowed). The fill-empty-only
  // author: a sector that already has an entry is a no-op (`skipped: true`).
  const createLogbookEntryHandler = os.create_logbook_entry
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const sector = requireSector(input.sector);
        const { entry, skipped } = await createLogbookEntry(sector, {
          body: input.body,
          // PROVENANCE — the prompt version the sweep authored this entry under.
          promptVersion: typeof input.promptVersion === "number" ? input.promptVersion : null,
          title: input.title,
        });

        return { entry, ok: true as const, ...(skipped ? { skipped: true as const } : {}) };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // PATCH /admin/logbook/{sector} — OPERATOR tier. Create-or-overwrite; stamps the
  // entry operator-authored so the agent create thereafter treats it as sacred.
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
