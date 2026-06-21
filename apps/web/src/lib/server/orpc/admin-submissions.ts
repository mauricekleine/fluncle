// The `admin-submissions` domain router module — the submission-review queue.
// Each handler reuses the live `/api/admin/submissions/*` route logic verbatim;
// the auth tier moves to the oRPC procedure middleware (../orpc-auth).
//
//   - `list_submissions` / `get_submission` — admin tier (live `requireAdmin`):
//     `adminAuth` only.
//   - `approve_submission` / `reject_submission` — operator tier (live
//     `requireOperator`): `adminAuth` + `operatorGuard`.

import { adminAuth, operatorGuard } from "../orpc-auth";
import {
  approveSubmission,
  getSubmission,
  listPendingSubmissions,
  rejectSubmission,
} from "../submissions";
import { apiFault, type Implementer } from "./_shared";

/**
 * Build the `admin-submissions` domain's handlers. Each reuses the live route
 * logic verbatim; only the auth gate is relocated to the procedure middleware.
 */
export function adminSubmissionsHandlers(os: Implementer) {
  // GET /admin/submissions — admin tier (live `requireAdmin`).
  const listSubmissionsHandler = os.list_submissions.use(adminAuth).handler(async () => {
    try {
      const submissions = await listPendingSubmissions();

      return { ok: true as const, submissions };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // GET /admin/submissions/{submissionId} — admin tier (live `requireAdmin`).
  const getSubmissionHandler = os.get_submission.use(adminAuth).handler(async ({ input }) => {
    try {
      const submission = await getSubmission(input.submissionId);

      return { ok: true as const, submission };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // POST /admin/submissions/{submissionId}/approve — operator tier (live
  // `requireOperator`).
  const approveSubmissionHandler = os.approve_submission
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const submission = await approveSubmission(input.submissionId);

        return { ok: true as const, submission };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // POST /admin/submissions/{submissionId}/reject — operator tier (live
  // `requireOperator`).
  const rejectSubmissionHandler = os.reject_submission
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const submission = await rejectSubmission(input.submissionId);

        return { ok: true as const, submission };
      } catch (error) {
        throw apiFault(error);
      }
    });

  return {
    approve_submission: approveSubmissionHandler,
    get_submission: getSubmissionHandler,
    list_submissions: listSubmissionsHandler,
    reject_submission: rejectSubmissionHandler,
  };
}
