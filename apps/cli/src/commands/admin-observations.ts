// The `fluncle admin observations` commands — the observation echo gate's ledger from the
// terminal. The spoken sibling of `fluncle admin notes` (admin-notes.ts), same two verbs:
//
//   `held` — the observation scripts the gate refused to RENDER (held before the Cartesia
//            spend, so a rejection never cost a cent), with the neighbour each echoed and the
//            score next to the threshold it was judged against.
//   `gate` — read or retune the gate's dials (their own `settings` KV keys, independent of the
//            note gate's — the two corpora differ, so their honest thresholds can drift apart).
//
// Ruling on a held observation (render it / bin it) is OPERATOR-tier and lives on the web
// admin (the observation dialog's held panel), per the persona law.

import { type ObservationGate, type ObservationRejection } from "@fluncle/contracts";
import { adminApiGet, adminApiPatch } from "../api";

export type { ObservationGate, ObservationRejection };

type ObservationRejectionsResponse = {
  gate: ObservationGate;
  rejections: ObservationRejection[];
};
type ObservationGateResponse = { gate: ObservationGate };

/**
 * The held observations + the gate's current dials. `--settled` reads the ones already ruled
 * on (what he rendered, what he binned) — the retune evidence.
 *
 * `fluncle admin observations held [--settled] [--json]`
 */
export async function observationHeldCommand(options: {
  settled?: boolean;
}): Promise<ObservationRejectionsResponse> {
  const query = options.settled ? "?open=false" : "";

  return adminApiGet<ObservationRejectionsResponse>(`/api/v1/admin/observation-rejections${query}`);
}

/**
 * Read or retune the observation echo gate. With no dial given it reports the current values;
 * with one or both it sets them and reports the result.
 *
 * `fluncle admin observations gate [--min-phrase-words <n>] [--max-overlap <x>] [--json]`
 */
export async function observationGateCommand(options: {
  maxOverlap?: number;
  minPhraseWords?: number;
}): Promise<ObservationGate> {
  const patch: Record<string, number> = {};

  if (options.minPhraseWords !== undefined) {
    patch.minPhraseWords = options.minPhraseWords;
  }

  if (options.maxOverlap !== undefined) {
    patch.maxOverlap = options.maxOverlap;
  }

  // No dial named ⇒ a pure read, off the ledger response it already carries.
  if (Object.keys(patch).length === 0) {
    const response = await adminApiGet<ObservationRejectionsResponse>(
      "/api/v1/admin/observation-rejections",
    );

    return response.gate;
  }

  const response = await adminApiPatch<ObservationGateResponse>(
    "/api/v1/admin/observation-gate",
    patch,
  );

  return response.gate;
}
