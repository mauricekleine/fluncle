// The `fluncle admin notes` commands — the echo gate's ledger from the terminal.
//
// The auto-note's echo gate refuses to STORE a note that echoes a sonic neighbour. It kept
// doing that silently, which meant the operator could never read what was binned, never
// judge whether the gate was right, and never prove its thresholds wrong — the evidence was
// the thing being destroyed. Now every rejection is HELD, and these are the reads + the
// dials over it.
//
// `held` is the terminal's window onto the same ledger the /admin queue shows; `gate` is the
// retune. The dials live in the `settings` KV, the house's one flag store, so a retune is a
// flip that the very next sweep tick reads — never a deploy.

import { type NoteGate, type NoteRejection } from "@fluncle/contracts";
import { adminApiGet, adminApiPatch } from "../api";

export type { NoteGate, NoteRejection };

type NoteRejectionsResponse = { gate: NoteGate; rejections: NoteRejection[] };
type NoteGateResponse = { gate: NoteGate };

/**
 * The held notes + the gate's current dials. `--settled` reads the ones already ruled on
 * (what he kept, what he binned) — the corpus-level evidence behind a retune, which is the
 * whole reason the rejections are kept rather than dropped.
 *
 * `fluncle admin notes held [--settled] [--json]`
 */
export async function noteHeldCommand(options: {
  settled?: boolean;
}): Promise<NoteRejectionsResponse> {
  const query = options.settled ? "?open=false" : "";

  return adminApiGet<NoteRejectionsResponse>(`/api/v1/admin/note-rejections${query}`);
}

/**
 * Read or retune the echo gate. With no dial given it just reports the current values (the
 * inspect path); with one or both it sets them and reports the result.
 *
 * `fluncle admin notes gate [--min-phrase-words <n>] [--max-overlap <x>] [--json]`
 */
export async function noteGateCommand(options: {
  maxOverlap?: number;
  minPhraseWords?: number;
}): Promise<NoteGate> {
  const patch: Record<string, number> = {};

  if (options.minPhraseWords !== undefined) {
    patch.minPhraseWords = options.minPhraseWords;
  }

  if (options.maxOverlap !== undefined) {
    patch.maxOverlap = options.maxOverlap;
  }

  // No dial named ⇒ a pure read. Reuse the ledger read rather than adding a second GET op
  // for a value it already carries.
  if (Object.keys(patch).length === 0) {
    const response = await adminApiGet<NoteRejectionsResponse>("/api/v1/admin/note-rejections");

    return response.gate;
  }

  const response = await adminApiPatch<NoteGateResponse>("/api/v1/admin/note-gate", patch);

  return response.gate;
}
