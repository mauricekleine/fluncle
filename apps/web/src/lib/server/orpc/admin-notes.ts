// The `admin-notes` domain router module — the echo gate's ledger, made visible. Three
// ops, on the `admin-labels` pattern:
//
//   - `list_note_rejections` — `adminAuth` (agent-allowed read): the held notes + the
//     gate's current dials.
//   - `resolve_note_rejection` — `adminAuth` + `operatorGuard` (OPERATOR): the ruling.
//     Accepting a held note puts a line on the public `/log` page, so the box's agent token
//     403s — the `update_label` / `update_galaxy` precedent. The agent authors; only the
//     operator overrules the gate.
//   - `update_note_gate` — `adminAuth` + `operatorGuard` (OPERATOR): retune the dials.
//
// The gate is not weakened here. `note_track` still rejects exactly what it rejected
// before; these ops exist so the rejection is READABLE and REVERSIBLE instead of silent.
// See docs/agents/note-agent.md.

import {
  getNoteEchoThresholds,
  listNoteRejections,
  resolveNoteRejection,
  setNoteEchoThresholds,
} from "../note-rejections";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { apiFault, type Implementer } from "./_shared";

/** Build the `admin-notes` domain's handlers. */
export function adminNotesHandlers(os: Implementer) {
  // GET /admin/note-rejections — `adminAuth` (operator OR agent): the held notes, with the
  // gate's dials alongside so any surface rendering a rejection can also render what it was
  // judged against (a score with no threshold beside it is not evidence, it is a number).
  const listNoteRejectionsHandler = os.list_note_rejections
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        // Default OPEN: the operator's working set is the notes still waiting on his eye.
        // `open=false` reads the settled ones — the corpus-level evidence behind a retune.
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

  // POST /admin/note-rejections/{id}/resolve — OPERATOR tier: keep the held note (writes it
  // through the atomic fill-empty-only predicate) or bin it. An agent token 403s at
  // `operatorGuard` — overruling the voice gate is publish-class.
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

  // PATCH /admin/note-gate — OPERATOR tier: retune the echo gate. The dials live in the
  // `settings` KV, so this takes effect on the very next sweep tick with no deploy.
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
