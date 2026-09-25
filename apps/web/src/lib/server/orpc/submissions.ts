import { ORPCError } from "@orpc/server";
import { createSubmission } from "../submissions";
import { apiFault, type Implementer } from "./_shared";

export function submissionsHandlers(os: Implementer) {
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
