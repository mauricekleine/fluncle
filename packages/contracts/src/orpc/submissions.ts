// The `submissions` domain contract module. Owns the public finding-submission
// write op; a future wave adds an op here and one import line in `./index.ts`,
// touching no other domain's file.

import { oc } from "@orpc/contract";
import * as z from "zod";
import { SubmissionSchema } from "./_shared";

/**
 * The submission request body (`SubmissionInput` in the server `submissions`
 * module). Every field is an OPTIONAL UNKNOWN and the object is LOOSE: the live
 * route does NOT schema-validate the body — it hands the raw parsed JSON to
 * `createSubmission`, whose `validateSubmissionInput` owns every check and emits
 * the exact `invalid_request`/`rate_limited` codes. Keeping the contract input
 * permissive (no required fields, unknown keys like `honeypot` preserved) means
 * oRPC never pre-rejects a valid-JSON body, so that validation — and its precise
 * error codes — stays byte-for-byte the live behavior.
 */
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

/**
 * `submit_track` → `POST /submissions` (operationId `submitTrack`).
 *
 * Submit a finding for review (a recommendation, not a publish). The success
 * body is the `{ ok: true, submission }` envelope (mirrors `SubmissionResponse`
 * in ../index.ts). Validation faults (`invalid_request`/400, `rate_limited`/429)
 * and the upstream Spotify `ApiError` are carried through the rails fault
 * encoder, preserving the exact legacy `{ code, message, ok: false }` body.
 */
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

/** The `submissions` domain's ops, merged into the root contract by `./index.ts`. */
export const submissionsContract = {
  submit_track: submitTrack,
};
