import { oc } from "@orpc/contract";
import * as z from "zod";
import { SubmissionSchema } from "./_shared";

const SubmissionBodySchema = z.looseObject({
  album: z.unknown().optional(),
  artists: z.unknown().optional(),
  artworkUrl: z.unknown().optional(),
  contact: z.unknown().optional(),
  honeypot: z.unknown().optional(),
  note: z.unknown().optional(),
  source: z.unknown().optional(),
  spotifyTrackId: z.unknown().optional(),
  spotifyUrl: z.unknown().optional(),
  title: z.unknown().optional(),
});

export type SubmissionBody = z.infer<typeof SubmissionBodySchema>;

export const submitTrack = oc
  .route({
    method: "POST",
    operationId: "submitTrack",
    path: "/submissions",
    summary: "Submit a finding for review",
    tags: ["Submissions"],
  })
  .input(SubmissionBodySchema)
  .output(z.object({ ok: z.literal(true), submission: SubmissionSchema }));

export const submissionsContract = {
  submit_track: submitTrack,
};
