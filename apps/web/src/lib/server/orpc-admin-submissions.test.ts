import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_TOKEN, OPERATOR_TOKEN, readJson, req, setAdminTokenEnv } from "./orpc-test-kit";

// The admin wave's `admin-submissions` parity + auth proof, driven end-to-end
// through `handleOrpc` so the REAL admin auth spine runs.
//
//   - list_submissions / get_submission — admin tier (live `requireAdmin`): the
//     agent passes (200), a non-admin is a 401.
//   - approve_submission / reject_submission — operator tier (live
//     `requireOperator`): the agent is a 403, the operator passes.

const listPendingSubmissions = vi.fn();
const getSubmission = vi.fn();
const approveSubmission = vi.fn();
const rejectSubmission = vi.fn();

vi.mock("./submissions", () => ({
  approveSubmission: (...args: unknown[]) => approveSubmission(...args),
  getSubmission: (...args: unknown[]) => getSubmission(...args),
  listPendingSubmissions: (...args: unknown[]) => listPendingSubmissions(...args),
  rejectSubmission: (...args: unknown[]) => rejectSubmission(...args),
}));

const SUBMISSION_ID = "sub-123";

const SUBMISSION = {
  artists: ["Calibre"],
  createdAt: "2026-06-01T00:00:00.000Z",
  id: SUBMISSION_ID,
  source: "cli",
  spotifyTrackId: "spot-1",
  spotifyUrl: "https://open.spotify.com/track/spot-1",
  status: "pending",
  title: "Mr Right On",
};

beforeAll(setAdminTokenEnv);

beforeEach(() => {
  listPendingSubmissions.mockReset();
  getSubmission.mockReset();
  approveSubmission.mockReset();
  rejectSubmission.mockReset();
});

// ── list_submissions — admin tier ────────────────────────────────────────────
describe("oRPC list_submissions (GET /admin/submissions)", () => {
  it("401s with no admin token", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/submissions", "GET", undefined));

    expect(response?.status).toBe(401);
    expect(listPendingSubmissions).not.toHaveBeenCalled();
  });

  it("lets the AGENT read (admin tier) and returns the live envelope", async () => {
    listPendingSubmissions.mockResolvedValueOnce([SUBMISSION]);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/submissions", "GET", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true, submissions: [SUBMISSION] });
  });
});

// ── get_submission — admin tier ──────────────────────────────────────────────
describe("oRPC get_submission (GET /admin/submissions/{submissionId})", () => {
  it("returns the live envelope for the operator", async () => {
    getSubmission.mockResolvedValueOnce(SUBMISSION);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/submissions/${SUBMISSION_ID}`, "GET", OPERATOR_TOKEN),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true, submission: SUBMISSION });
    expect(getSubmission).toHaveBeenCalledWith(SUBMISSION_ID);
  });
});

// ── approve_submission — operator tier ───────────────────────────────────────
describe("oRPC approve_submission (POST .../approve)", () => {
  it("401s with no token", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/submissions/${SUBMISSION_ID}/approve`, "POST", undefined),
    );

    expect(response?.status).toBe(401);
    expect(approveSubmission).not.toHaveBeenCalled();
  });

  it("403s the AGENT (operator-only)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/submissions/${SUBMISSION_ID}/approve`, "POST", AGENT_TOKEN),
    );

    expect(response?.status).toBe(403);
    expect(((await readJson(response)) as { code: string }).code).toBe("forbidden");
    expect(approveSubmission).not.toHaveBeenCalled();
  });

  it("approves for the operator and returns the live envelope", async () => {
    approveSubmission.mockResolvedValueOnce({ ...SUBMISSION, status: "approved" });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/submissions/${SUBMISSION_ID}/approve`, "POST", OPERATOR_TOKEN),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      ok: true,
      submission: { ...SUBMISSION, status: "approved" },
    });
    expect(approveSubmission).toHaveBeenCalledWith(SUBMISSION_ID);
  });
});

// ── reject_submission — operator tier ────────────────────────────────────────
describe("oRPC reject_submission (POST .../reject)", () => {
  it("403s the AGENT (operator-only)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/submissions/${SUBMISSION_ID}/reject`, "POST", AGENT_TOKEN),
    );

    expect(response?.status).toBe(403);
    expect(rejectSubmission).not.toHaveBeenCalled();
  });

  it("rejects for the operator and returns the live envelope", async () => {
    rejectSubmission.mockResolvedValueOnce({ ...SUBMISSION, status: "rejected" });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/submissions/${SUBMISSION_ID}/reject`, "POST", OPERATOR_TOKEN),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      ok: true,
      submission: { ...SUBMISSION, status: "rejected" },
    });
    expect(rejectSubmission).toHaveBeenCalledWith(SUBMISSION_ID);
  });
});
