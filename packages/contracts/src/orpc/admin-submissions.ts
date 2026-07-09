// The `admin-submissions` domain contract module — the submission-review queue
// (list/show + approve/reject). Part of the admin fan-out, built on the same
// pattern as `./admin-tracks.ts`.
//
//   - `list_submissions` / `get_submission` — admin tier (live `requireAdmin`):
//     reads, so the agent role authenticates too.
//   - `approve_submission` / `reject_submission` — operator tier (live
//     `requireOperator`): they mutate the archive, so the agent gets a 403.
//
// The `Submission` DTO already has its Zod mirror in `./_shared`; reuse it so the
// generated OpenAPI components stay deduplicated.

import { oc } from "@orpc/contract";
import * as z from "zod";
import { SubmissionSchema } from "./_shared";

/**
 * The triage body (POST /admin/submissions/{submissionId}/triage). LOOSE: the live
 * handler gates the `verdict` itself (`no_verdict`/`verdict_too_short`/
 * `verdict_too_long`), so the contract stays permissive to keep those codes exact.
 */
const TriageSubmissionBodySchema = z.looseObject({
  verdict: z.unknown().optional(),
});

/**
 * `list_submissions` → `GET /admin/submissions` (operationId `listSubmissions`).
 *
 * Admin tier (live `requireAdmin`). The pending-review queue. Preserves the live
 * `{ ok: true, submissions }` envelope.
 */
export const listSubmissions = oc
  .route({
    method: "GET",
    operationId: "listSubmissions",
    path: "/admin/submissions",
    summary: "List the pending submission-review queue",
    tags: ["Admin"],
  })
  .output(
    z.object({
      ok: z.literal(true),
      submissions: z.array(SubmissionSchema),
    }),
  );

/**
 * `get_submission` → `GET /admin/submissions/{submissionId}` (operationId
 * `getSubmission`).
 *
 * Admin tier (live `requireAdmin`). One submission by id. Preserves the live
 * `{ ok: true, submission }` envelope and the `not_found`/404 the helper throws.
 */
export const getSubmission = oc
  .route({
    method: "GET",
    operationId: "getSubmission",
    path: "/admin/submissions/{submissionId}",
    summary: "Get one submission by id",
    tags: ["Admin"],
  })
  .input(z.object({ submissionId: z.string() }))
  .output(
    z.object({
      ok: z.literal(true),
      submission: SubmissionSchema,
    }),
  );

/**
 * `approve_submission` → `POST /admin/submissions/{submissionId}/approve`
 * (operationId `approveSubmission`).
 *
 * Operator tier (live `requireOperator`). Flips a submission to `approved`.
 * Preserves the live `{ ok: true, submission }` envelope.
 */
export const approveSubmission = oc
  .route({
    method: "POST",
    operationId: "approveSubmission",
    path: "/admin/submissions/{submissionId}/approve",
    summary: "Approve a pending submission",
    tags: ["Admin"],
  })
  .input(z.object({ submissionId: z.string() }))
  .output(
    z.object({
      ok: z.literal(true),
      submission: SubmissionSchema,
    }),
  );

/**
 * `reject_submission` → `POST /admin/submissions/{submissionId}/reject`
 * (operationId `rejectSubmission`).
 *
 * Operator tier (live `requireOperator`). Flips a submission to `rejected`.
 * Preserves the live `{ ok: true, submission }` envelope.
 */
export const rejectSubmission = oc
  .route({
    method: "POST",
    operationId: "rejectSubmission",
    path: "/admin/submissions/{submissionId}/reject",
    summary: "Reject a pending submission",
    tags: ["Admin"],
  })
  .input(z.object({ submissionId: z.string() }))
  .output(
    z.object({
      ok: z.literal(true),
      submission: SubmissionSchema,
    }),
  );

/**
 * `triage_submission` → `POST /admin/submissions/{submissionId}/triage` (operationId
 * `triageSubmission`).
 *
 * ADMIN tier (agent-allowed, no `operatorGuard`) — the written-verdict sibling of
 * `note_track`: the on-box `fluncle-triage` sweep pre-chews a pending submission and
 * writes an advisory one-line verdict (a "looks like a find / already logged / not our
 * lane" read) so it lands in the operator's attention queue already assessed. The
 * verdict is OPERATOR-INTERNAL and ADVISORY only: approve/reject stays operator tier
 * and untouched — this moves no publishing authority. Writes onto a PENDING submission
 * only (a reviewed one is a 409). Preserves the `{ ok: true, submission }` envelope.
 * Codes: `submission_not_found`/404, `invalid_status`/409, `no_verdict`/400,
 * `verdict_too_short`/422, `verdict_too_long`/422.
 */
export const triageSubmission = oc
  .route({
    method: "POST",
    operationId: "triageSubmission",
    path: "/admin/submissions/{submissionId}/triage",
    summary: "Write the pre-chew triage verdict onto a pending submission",
    tags: ["Admin"],
  })
  .input(TriageSubmissionBodySchema.extend({ submissionId: z.string() }))
  .output(
    z.object({
      ok: z.literal(true),
      submission: SubmissionSchema,
    }),
  );

/** The `admin-submissions` domain's ops, merged into the root contract by `./index.ts`. */
export const adminSubmissionsContract = {
  approve_submission: approveSubmission,
  get_submission: getSubmission,
  list_submissions: listSubmissions,
  reject_submission: rejectSubmission,
  triage_submission: triageSubmission,
};
