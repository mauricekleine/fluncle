import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_TOKEN, OPERATOR_TOKEN, readJson, req, setAdminTokenEnv } from "./orpc-test-kit";

// The `admin-editions` auth proof, driven end-to-end through `handleOrpc` so the
// REAL admin auth spine (../orpc-auth) runs; only the `editions` data layer is
// mocked. The security-critical claim: `delete_edition` is OPERATOR tier — a hard
// delete that reaches a SENT edition (the archive pull), and a valid AGENT token is
// a 403. The other ops are covered here for tier completeness:
//   - list_editions_admin / create_edition / update_edition — admin (agent-allowed).
//   - send_edition / delete_edition — operator (agent → 403).

const createEdition = vi.fn();
const deleteEdition = vi.fn();
const listEditions = vi.fn();
const sendEdition = vi.fn();
const updateEdition = vi.fn();

vi.mock("./editions", () => ({
  createEdition: (...args: unknown[]) => createEdition(...args),
  deleteEdition: (...args: unknown[]) => deleteEdition(...args),
  listEditions: (...args: unknown[]) => listEditions(...args),
  sendEdition: (...args: unknown[]) => sendEdition(...args),
  updateEdition: (...args: unknown[]) => updateEdition(...args),
}));

const EDITION_ID = "edition-123";

// A schema-complete EditionDTO — oRPC validates the response body against the
// contract, so the create/update/send envelopes need the full shape.
const EDITION = {
  content: { intro: "Ahoy cosmonauts." },
  createdAt: "2026-06-26T00:00:00.000Z",
  id: EDITION_ID,
  status: "draft" as const,
  subject: "First dispatch",
};

beforeAll(setAdminTokenEnv);

beforeEach(() => {
  createEdition.mockReset();
  deleteEdition.mockReset();
  listEditions.mockReset();
  sendEdition.mockReset();
  updateEdition.mockReset();
});

// ── list_editions_admin — admin tier ─────────────────────────────────────────
describe("oRPC list_editions_admin (GET /admin/newsletter/editions)", () => {
  it("401s with no token", async () => {
    const { handleOrpc } = await import("./orpc");
    expect((await handleOrpc(req("/admin/newsletter/editions", "GET", undefined)))?.status).toBe(
      401,
    );
    expect(listEditions).not.toHaveBeenCalled();
  });

  it("lets the AGENT read (drafts inclusive)", async () => {
    listEditions.mockResolvedValueOnce([EDITION]);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/newsletter/editions", "GET", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    expect(((await readJson(response)) as { ok: boolean }).ok).toBe(true);
    expect(listEditions).toHaveBeenCalledWith({ includeDrafts: true });
  });
});

// ── delete_edition — operator tier (the archive pull) ────────────────────────
describe("oRPC delete_edition (DELETE /admin/newsletter/editions/{id})", () => {
  it("401s with no token", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/newsletter/editions/${EDITION_ID}`, "DELETE", undefined),
    );

    expect(response?.status).toBe(401);
    expect(deleteEdition).not.toHaveBeenCalled();
  });

  it("403s the AGENT (operator-only — the agent token cannot delete)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/newsletter/editions/${EDITION_ID}`, "DELETE", AGENT_TOKEN),
    );

    expect(response?.status).toBe(403);
    expect(deleteEdition).not.toHaveBeenCalled();
  });

  it("deletes for the operator and returns `{ id, ok }`", async () => {
    deleteEdition.mockResolvedValueOnce({ id: EDITION_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/newsletter/editions/${EDITION_ID}`, "DELETE", OPERATOR_TOKEN),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ id: EDITION_ID, ok: true });
    expect(deleteEdition).toHaveBeenCalledWith(EDITION_ID);
  });

  it("surfaces the not-found code when the row is absent", async () => {
    const { ApiError } = await import("./spotify");
    deleteEdition.mockRejectedValueOnce(
      new ApiError("edition_not_found", "Edition not found", 404),
    );

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/newsletter/editions/missing-id`, "DELETE", OPERATOR_TOKEN),
    );

    expect(response?.status).toBe(404);
    expect(((await readJson(response)) as { code: string }).code).toBe("edition_not_found");
  });
});

// ── send_edition — operator tier ─────────────────────────────────────────────
describe("oRPC send_edition (POST /admin/newsletter/editions/{id}/send)", () => {
  it("403s the AGENT", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/newsletter/editions/${EDITION_ID}/send`, "POST", AGENT_TOKEN, {}),
    );

    expect(response?.status).toBe(403);
    expect(sendEdition).not.toHaveBeenCalled();
  });
});
