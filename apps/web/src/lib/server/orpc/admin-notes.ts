import {
  getNoteEchoThresholds,
  listNoteRejections,
  resolveNoteRejection,
  setNoteEchoThresholds,
} from "../note-rejections";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { apiFault, type Implementer } from "./_shared";

export function adminNotesHandlers(os: Implementer) {
  const listNoteRejectionsHandler = os.list_note_rejections
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const open = input.open !== "false";
        const [rejections, gate] = await Promise.all([
          listNoteRejections({
            open,
            ...(input.trackId ? { trackId: input.trackId } : {}),
          }),
          getNoteEchoThresholds(),
        ]);

        return { gate, ok: true, rejections } as const;
      } catch (error) {
        throw apiFault(error);
      }
    });

  const resolveNoteRejectionHandler = os.resolve_note_rejection
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const { note, rejection, skipped } = await resolveNoteRejection(input.id, input.resolution);

        return { ...(note ? { note } : {}), ok: true, rejection, skipped } as const;
      } catch (error) {
        throw apiFault(error);
      }
    });

  const updateNoteGateHandler = os.update_note_gate
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const gate = await setNoteEchoThresholds({
          ...(input.maxOverlap !== undefined ? { maxOverlap: input.maxOverlap } : {}),
          ...(input.minPhraseWords !== undefined ? { minPhraseWords: input.minPhraseWords } : {}),
        });

        return { gate, ok: true } as const;
      } catch (error) {
        throw apiFault(error);
      }
    });

  return {
    list_note_rejections: listNoteRejectionsHandler,
    resolve_note_rejection: resolveNoteRejectionHandler,
    update_note_gate: updateNoteGateHandler,
  };
}
