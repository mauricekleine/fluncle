// The `mixtapes` domain router module. Implements the public mixtape-list
// contract op off the shared implementer the root (../orpc.ts) hands in. A
// future wave adds an op here and one spread line in the root — no other
// domain's file is touched.

import { listMixtapes } from "../mixtapes";
import { apiFault, type Implementer } from "./_shared";

/**
 * Build the `mixtapes` domain's handlers — a direct port of the live
 * /api/mixtapes route, preserving the `{ ok: true, mixtapes }` envelope
 * byte-for-byte. Errors are converted through the shared `apiFault` so the rails
 * encoder reproduces the legacy `jsonError` body.
 */
export function mixtapesHandlers(os: Implementer) {
  // `list_mixtapes` — every published mixtape, newest first. Port of
  // /api/mixtapes GET: `listMixtapes()` with the live defaults (published-only),
  // wrapped in the `{ ok: true, mixtapes }` envelope the live route emits.
  const listMixtapesHandler = os.list_mixtapes.handler(async () => {
    try {
      return { mixtapes: await listMixtapes(), ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  return { list_mixtapes: listMixtapesHandler };
}
