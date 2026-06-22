// The `submissions` domain router module. Implements the public
// finding-submission write op off the shared implementer the root (../orpc.ts)
// hands in. A future wave adds an op here and one spread line in the root — no
// other domain's file is touched.

import { ORPCError } from "@orpc/server";
import { createSubmission } from "../submissions";
import { apiFault, type Implementer } from "./_shared";

/**
 * Build the `submissions` domain's handlers — a direct port of the live
 * /api/submissions route, preserving the `{ ok: true, submission }` envelope
 * byte-for-byte. The body is handed straight to `createSubmission`, whose
 * `validateSubmissionInput` owns every check and emits the exact
 * `invalid_request`/400, `rate_limited`/429 codes; an upstream Spotify
 * `ApiError` keeps its own status/code. All flow through `apiFault` so the rails
 * encoder reproduces the legacy `jsonError` body.
 */
export function submissionsHandlers(os: Implementer) {
  // `submit_track` — submit a finding for review. Port of /api/submissions POST:
  // the contract has already parsed the JSON body into `input` (the inferred
  // `SubmissionBody` — the same type the server accepts, so no cast); pass it
  // through and shape the success envelope.
  const submitTrackHandler = os.submit_track.handler(async ({ context, input }) => {
    try {
      const submission = await createSubmission(input, context.request);

      return { ok: true, submission } as const;
    } catch (error) {
      if (error instanceof ORPCError) {
        throw error;
      }

      throw apiFault(error);
    }
  });

  return { submit_track: submitTrackHandler };
}
