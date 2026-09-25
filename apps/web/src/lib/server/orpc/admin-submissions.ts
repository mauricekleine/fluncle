import { adminAuth, operatorGuard } from "../orpc-auth";
import {
  approveSubmission,
  getSubmission,
  listPendingSubmissions,
  rejectSubmission,
  triageSubmission,
} from "../submissions";
import { apiFault, type Implementer } from "./_shared";

export function adminSubmissionsHandlers(os: Implementer) {
  const listSubmissionsHandler = os.list_submissions.use(adminAuth).handler(async () => {
    try {
      const submissions = await listPendingSubmissions();

      return { ok: true as const, submissions };
    } catch (error) {
      throw apiFault(error);
    }
  });

  const getSubmissionHandler = os.get_submission.use(adminAuth).handler(async ({ input }) => {
    try {
      const submission = await getSubmission(input.submissionId);

      return { ok: true as const, submission };
    } catch (error) {
      throw apiFault(error);
    }
  });

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

  const triageSubmissionHandler = os.triage_submission.use(adminAuth).handler(async ({ input }) => {
    try {
      const submission = await triageSubmission(
        input.submissionId,
        input.verdict,

        typeof input.promptVersion === "number" ? input.promptVersion : null,
      );

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
    triage_submission: triageSubmissionHandler,
  };
}
