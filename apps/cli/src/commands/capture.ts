// THE CAPTURE BUDGET — the operator's handle on the only thing Fluncle does that bills per
// unit of work (docs/the-ear.md § The capture budget).
//
// Audio capture pulls a full song through a residential proxy that charges per GB. For the
// FINDINGS that is a handful a week and nobody notices. For the CATALOGUE — the crawler writes
// uncertified rows by the thousand — the same sweep would drain ~1,150 songs a day, forever,
// and the bill would be the first thing to tell him.
//
// So the catalogue half of the capture queue has a rolling-24h budget and a kill switch, both
// on the `settings` KV, and these are the same three moves the `/admin/catalogue` card makes:
// read what it spent, cap what it may spend, and stop it dead. The Worker owns every gate; the
// CLI is a thin HTTP client, exactly like `admin publish pause` (commands/publish.ts).

import { type CaptureBudgetResponse, type CaptureBudgetState } from "@fluncle/contracts";
import { adminApiGet, adminApiPut } from "../api";

/** The spend readout: what the catalogue captured in the last 24h, and what is left. */
export async function captureBudgetCommand(): Promise<CaptureBudgetState> {
  return adminApiGet<CaptureBudgetResponse>("/api/v1/admin/catalogue/capture-budget");
}

/**
 * Set the budget and/or flip the kill switch — OPERATOR tier (an agent may never raise its own
 * budget). Returns the FULL state as the server recomputed it, so the caller prints the real
 * new verdict rather than an echo of what it asked for.
 */
export async function setCaptureBudgetCommand(input: {
  dailyBytes?: number;
  dailyTracks?: number;
  paused?: boolean;
}): Promise<CaptureBudgetState> {
  return adminApiPut<CaptureBudgetResponse>("/api/v1/admin/catalogue/capture-budget", input);
}
