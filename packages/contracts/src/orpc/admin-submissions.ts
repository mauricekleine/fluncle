import { oc } from "@orpc/contract";
import * as z from "zod";
import { SubmissionSchema } from "./_shared";

const TriageSubmissionBodySchema = z.looseObject({
  promptVersion: z.number().int().min(0).optional(),
  verdict: z.unknown().optional(),
});

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

export const adminSubmissionsContract = {
  approve_submission: approveSubmission,
  get_submission: getSubmission,
  list_submissions: listSubmissions,
  reject_submission: rejectSubmission,
  triage_submission: triageSubmission,
};
