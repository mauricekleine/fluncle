import { beforeEach, describe, expect, it, vi } from "vitest";
import { BASE, get, jsonRequest as body, readJson } from "./orpc-test-kit";

// Wave B — the thirteen `/me` PRIVATE-SESSION ops fanned out off the user-auth
// tier (orpc-auth.ts). As in orpc-wave-a.test.ts, the underlying server helpers
// are mocked: each handler's job is the auth/CSRF framing + the contract response
// shape, not to touch Turso. These assertions pin the body the live `/me` route
// emitted, now served by oRPC — byte-for-byte — plus the 401-without-session and
// CSRF-rejection cases the tier introduces.

// ── account-data: the auth-tier resolvers + every business helper ────────────
const requirePublicUser = vi.fn();
const requireAccountMutation = vi.fn();
const meResponse = vi.fn();
const getGalaxyProgress = vi.fn();
const mergeGalaxyProgress = vi.fn();
const collectLogId = vi.fn();
const listSavedFindings = vi.fn();
const saveFinding = vi.fn();
const deleteSavedFinding = vi.fn();
const listSavedSets = vi.fn();
const saveSet = vi.fn();
const updateSavedSet = vi.fn();
const deleteSavedSet = vi.fn();
const listUserSubmissions = vi.fn();
const exportAccountData = vi.fn();
const getAccountExport = vi.fn();
const deleteAccount = vi.fn();
const updatePrivateUsername = vi.fn();

vi.mock("./account-data", () => ({
  collectLogId: (...a: unknown[]) => collectLogId(...a),
  deleteAccount: (...a: unknown[]) => deleteAccount(...a),
  deleteSavedFinding: (...a: unknown[]) => deleteSavedFinding(...a),
  deleteSavedSet: (...a: unknown[]) => deleteSavedSet(...a),
  exportAccountData: (...a: unknown[]) => exportAccountData(...a),
  getAccountExport: (...a: unknown[]) => getAccountExport(...a),
  getGalaxyProgress: (...a: unknown[]) => getGalaxyProgress(...a),
  listSavedFindings: (...a: unknown[]) => listSavedFindings(...a),
  listSavedSets: (...a: unknown[]) => listSavedSets(...a),
  listUserSubmissions: (...a: unknown[]) => listUserSubmissions(...a),
  meResponse: (...a: unknown[]) => meResponse(...a),
  mergeGalaxyProgress: (...a: unknown[]) => mergeGalaxyProgress(...a),
  requireAccountMutation: (...a: unknown[]) => requireAccountMutation(...a),
  saveFinding: (...a: unknown[]) => saveFinding(...a),
  saveSet: (...a: unknown[]) => saveSet(...a),
  updatePrivateUsername: (...a: unknown[]) => updatePrivateUsername(...a),
  updateSavedSet: (...a: unknown[]) => updateSavedSet(...a),
}));

// ── public-auth: the session resolver + the CSRF token issuer ────────────────
const createCsrfToken = vi.fn();

vi.mock("./public-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./public-auth")>();

  return {
    ...actual,
    createCsrfToken: (...a: unknown[]) => createCsrfToken(...a),
    requirePublicUser: (...a: unknown[]) => requirePublicUser(...a),
  };
});

const USER = {
  createdAt: "2026-01-01T00:00:00.000Z",
  displayUsername: "Fan",
  // Required on the wire since #647 (the verified-email arc): PublicUserSchema
  // carries the requester's own email + verified state.
  email: "fan@example.com",
  emailVerified: false,
  id: "user-1",
  name: "Fan",
  username: "fan",
};

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ code, message, ok: false }, { status });
}

// A signed-in session for the read tier, and a passed CSRF guard for writes.
function signIn(): void {
  requirePublicUser.mockResolvedValue(USER);
  requireAccountMutation.mockResolvedValue(USER);
}

beforeEach(() => {
  for (const fn of [
    requirePublicUser,
    requireAccountMutation,
    meResponse,
    getGalaxyProgress,
    mergeGalaxyProgress,
    collectLogId,
    listSavedFindings,
    saveFinding,
    deleteSavedFinding,
    listSavedSets,
    saveSet,
    updateSavedSet,
    deleteSavedSet,
    listUserSubmissions,
    exportAccountData,
    getAccountExport,
    deleteAccount,
    updatePrivateUsername,
    createCsrfToken,
  ]) {
    fn.mockReset();
  }
});

// ── get_current_private_user (GET /me) — never 401s; user-or-null ────────────

describe("oRPC /me — GET /me (get_current_private_user)", () => {
  it("serves { ok: true, user } for a session", async () => {
    meResponse.mockResolvedValueOnce({ googleEnabled: false, ok: true, user: USER });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get(`${BASE}/me`));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ googleEnabled: false, ok: true, user: USER });
  });

  it("serves { ok: true, user: null } with NO session (does not 401)", async () => {
    meResponse.mockResolvedValueOnce({ googleEnabled: false, ok: true, user: null });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get(`${BASE}/me`));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ googleEnabled: false, ok: true, user: null });
  });
});

// ── get_private_mutation_token (GET /me/csrf) ────────────────────────────────

describe("oRPC /me — GET /me/csrf (get_private_mutation_token)", () => {
  it("serves { csrfToken, ok: true } for a session", async () => {
    signIn();
    createCsrfToken.mockReturnValueOnce("user-1.123.sig");

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get(`${BASE}/me/csrf`));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ csrfToken: "user-1.123.sig", ok: true });
    expect(createCsrfToken).toHaveBeenCalledWith(USER);
  });

  it("401s the live auth_required body with NO session", async () => {
    requirePublicUser.mockResolvedValueOnce(
      jsonError(401, "auth_required", "Sign in to use this private account route"),
    );

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get(`${BASE}/me/csrf`));

    expect(response?.status).toBe(401);
    expect(await readJson(response)).toEqual({
      code: "auth_required",
      message: "Sign in to use this private account route",
      ok: false,
    });
  });
});

// ── list_private_saved_findings (GET /me/saved-findings) ─────────────────────

describe("oRPC /me — GET /me/saved-findings (list_private_saved_findings)", () => {
  it("serves { ok: true, savedFindings }", async () => {
    signIn();
    const savedFindings = [
      {
        artists: ["Some Artist"],
        logId: "0001",
        savedAt: "2026-01-01T00:00:00.000Z",
        title: "Some Banger",
        trackId: "abc",
      },
    ];
    listSavedFindings.mockResolvedValueOnce({ ok: true, savedFindings });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get(`${BASE}/me/saved-findings`));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true, savedFindings });
  });

  it("401s with NO session (the read tier guard)", async () => {
    requirePublicUser.mockResolvedValueOnce(
      jsonError(401, "auth_required", "Sign in to use this private account route"),
    );

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get(`${BASE}/me/saved-findings`));

    expect(response?.status).toBe(401);
    expect(await readJson(response)).toEqual({
      code: "auth_required",
      message: "Sign in to use this private account route",
      ok: false,
    });
  });
});

// ── save_private_finding (POST /me/saved-findings) ───────────────────────────

describe("oRPC /me — POST /me/saved-findings (save_private_finding)", () => {
  it("serves { ok: true, savedFinding } on a valid save", async () => {
    signIn();
    const savedFinding = {
      logId: "0001",
      savedAt: "2026-01-01T00:00:00.000Z",
      trackId: "abc",
    };
    saveFinding.mockResolvedValueOnce({ ok: true, savedFinding });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      body(`${BASE}/me/saved-findings`, "POST", { trackId: "abc" }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true, savedFinding });
    expect(saveFinding.mock.calls[0]?.[1]).toEqual({ trackId: "abc" });
  });

  it("carries the helper's track_not_found/404 Response byte-for-byte", async () => {
    signIn();
    saveFinding.mockResolvedValueOnce(
      jsonError(404, "track_not_found", "No finding at that coordinate"),
    );

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      body(`${BASE}/me/saved-findings`, "POST", { trackId: "nope" }),
    );

    expect(response?.status).toBe(404);
    expect(await readJson(response)).toEqual({
      code: "track_not_found",
      message: "No finding at that coordinate",
      ok: false,
    });
  });

  it("403s a CSRF-rejected write byte-for-byte (the mutation guard)", async () => {
    requireAccountMutation.mockResolvedValueOnce(
      jsonError(403, "csrf_required", "Invalid account mutation token"),
    );

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      body(`${BASE}/me/saved-findings`, "POST", { trackId: "abc" }),
    );

    expect(response?.status).toBe(403);
    expect(await readJson(response)).toEqual({
      code: "csrf_required",
      message: "Invalid account mutation token",
      ok: false,
    });
    expect(saveFinding).not.toHaveBeenCalled();
  });
});

// ── unsave_private_finding (DELETE /me/saved-findings/{trackId}) ─────────────

describe("oRPC /me — DELETE /me/saved-findings/{trackId} (unsave_private_finding)", () => {
  it("serves the bare { ok: true } on success", async () => {
    signIn();
    deleteSavedFinding.mockResolvedValueOnce({ ok: true });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      new Request(`${BASE}/me/saved-findings/abc`, {
        headers: { "Content-Type": "application/json" },
        method: "DELETE",
      }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true });
    expect(deleteSavedFinding.mock.calls[0]?.[1]).toBe("abc");
  });
});

// ── list_private_saved_sets (GET /me/saved-sets) ─────────────────────────────

const SAVED_SET = {
  createdAt: "2026-01-01T00:00:00.000Z",
  id: "set-1",
  name: "My set",
  setTokens: "4iV5W9uYEdYUVa79Axb7Rh,1301WleyT98MSxVHPZCA6M",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("oRPC /me — GET /me/saved-sets (list_private_saved_sets)", () => {
  it("serves { ok: true, savedSets }", async () => {
    signIn();
    listSavedSets.mockResolvedValueOnce({ ok: true, savedSets: [SAVED_SET] });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get(`${BASE}/me/saved-sets`));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true, savedSets: [SAVED_SET] });
  });

  it("401s with NO session (the read tier guard)", async () => {
    requirePublicUser.mockResolvedValueOnce(
      jsonError(401, "auth_required", "Sign in to use this private account route"),
    );

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get(`${BASE}/me/saved-sets`));

    expect(response?.status).toBe(401);
  });
});

// ── save_private_set (POST /me/saved-sets) ───────────────────────────────────

describe("oRPC /me — POST /me/saved-sets (save_private_set)", () => {
  it("serves { ok: true, savedSet } on a valid save", async () => {
    signIn();
    saveSet.mockResolvedValueOnce({ ok: true, savedSet: SAVED_SET });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      body(`${BASE}/me/saved-sets`, "POST", { set: SAVED_SET.setTokens }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true, savedSet: SAVED_SET });
    expect(saveSet.mock.calls[0]?.[1]).toEqual({ set: SAVED_SET.setTokens });
  });

  it("carries the helper's empty_set/400 Response byte-for-byte", async () => {
    signIn();
    saveSet.mockResolvedValueOnce(jsonError(400, "empty_set", "There's no set to save yet"));

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(body(`${BASE}/me/saved-sets`, "POST", { set: "" }));

    expect(response?.status).toBe(400);
    expect(await readJson(response)).toEqual({
      code: "empty_set",
      message: "There's no set to save yet",
      ok: false,
    });
  });

  it("403s a CSRF-rejected write byte-for-byte (the mutation guard)", async () => {
    requireAccountMutation.mockResolvedValueOnce(
      jsonError(403, "csrf_required", "Invalid account mutation token"),
    );

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      body(`${BASE}/me/saved-sets`, "POST", { set: SAVED_SET.setTokens }),
    );

    expect(response?.status).toBe(403);
    expect(saveSet).not.toHaveBeenCalled();
  });
});

// ── update_private_saved_set (PATCH /me/saved-sets/{id}) ──────────────────────

describe("oRPC /me — PATCH /me/saved-sets/{id} (update_private_saved_set)", () => {
  it("serves { ok: true, savedSet } and passes the path id + body to the helper", async () => {
    signIn();
    updateSavedSet.mockResolvedValueOnce({ ok: true, savedSet: { ...SAVED_SET, name: "Renamed" } });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      body(`${BASE}/me/saved-sets/set-1`, "PATCH", { name: "Renamed" }),
    );

    expect(response?.status).toBe(200);
    expect(updateSavedSet.mock.calls[0]?.[1]).toBe("set-1");
    expect(updateSavedSet.mock.calls[0]?.[2]).toMatchObject({ name: "Renamed" });
  });

  it("carries the helper's set_not_found/404 (another user's id)", async () => {
    signIn();
    updateSavedSet.mockResolvedValueOnce(jsonError(404, "set_not_found", "No set to update"));

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(body(`${BASE}/me/saved-sets/nope`, "PATCH", { name: "x" }));

    expect(response?.status).toBe(404);
  });
});

// ── delete_private_saved_set (DELETE /me/saved-sets/{id}) ─────────────────────

describe("oRPC /me — DELETE /me/saved-sets/{id} (delete_private_saved_set)", () => {
  it("serves the bare { ok: true } and passes the path id", async () => {
    signIn();
    deleteSavedSet.mockResolvedValueOnce({ ok: true });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      new Request(`${BASE}/me/saved-sets/set-1`, {
        headers: { "Content-Type": "application/json" },
        method: "DELETE",
      }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true });
    expect(deleteSavedSet.mock.calls[0]?.[1]).toBe("set-1");
  });
});

// ── get_private_galaxy_progress (GET /me/galaxy-progress) ────────────────────

describe("oRPC /me — GET /me/galaxy-progress (get_private_galaxy_progress)", () => {
  it("serves the progress body verbatim (carries its own ok)", async () => {
    signIn();
    const progress = {
      collectedLogIds: ["0001"],
      deaths: 3,
      ok: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
      wins: 1,
    };
    getGalaxyProgress.mockResolvedValueOnce(progress);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get(`${BASE}/me/galaxy-progress`));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual(progress);
  });
});

// ── merge_private_galaxy_progress (PUT /me/galaxy-progress) ──────────────────

describe("oRPC /me — PUT /me/galaxy-progress (merge_private_galaxy_progress)", () => {
  it("serves the merged progress body", async () => {
    signIn();
    const progress = { collectedLogIds: ["0001"], deaths: 0, ok: true, wins: 0 };
    mergeGalaxyProgress.mockResolvedValueOnce(progress);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      body(`${BASE}/me/galaxy-progress`, "PUT", { collectedLogIds: ["0001"] }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual(progress);
    expect(mergeGalaxyProgress.mock.calls[0]?.[1]).toEqual({ collectedLogIds: ["0001"] });
  });
});

// ── collect_private_galaxy_log (POST /me/galaxy-progress/logs) ───────────────

describe("oRPC /me — POST /me/galaxy-progress/logs (collect_private_galaxy_log)", () => {
  it("serves { logId, ok: true } on a valid collect", async () => {
    signIn();
    collectLogId.mockResolvedValueOnce({ logId: "0001", ok: true });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      body(`${BASE}/me/galaxy-progress/logs`, "POST", { logId: "0001" }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ logId: "0001", ok: true });
    expect(collectLogId.mock.calls[0]?.[1]).toBe("0001");
  });

  it("400s a non-string logId with the live invalid_request body", async () => {
    signIn();

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(body(`${BASE}/me/galaxy-progress/logs`, "POST", {}));

    expect(response?.status).toBe(400);
    expect(await readJson(response)).toEqual({
      code: "invalid_request",
      message: "Missing Log ID",
      ok: false,
    });
    expect(collectLogId).not.toHaveBeenCalled();
  });

  it("carries the helper's log_not_found/404 byte-for-byte", async () => {
    signIn();
    collectLogId.mockResolvedValueOnce(
      jsonError(404, "log_not_found", "No finding at that coordinate"),
    );

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      body(`${BASE}/me/galaxy-progress/logs`, "POST", { logId: "nope" }),
    );

    expect(response?.status).toBe(404);
    expect(await readJson(response)).toEqual({
      code: "log_not_found",
      message: "No finding at that coordinate",
      ok: false,
    });
  });
});

// ── update_private_profile (PATCH /me/profile) ──────────────────────────────

describe("oRPC /me — PATCH /me/profile (update_private_profile)", () => {
  it("serves { ok: true, user } on a valid update", async () => {
    signIn();
    const updated = { ...USER, displayUsername: "New", username: "newname" };
    updatePrivateUsername.mockResolvedValueOnce({ ok: true, user: updated });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(body(`${BASE}/me/profile`, "PATCH", { username: "newname" }));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true, user: updated });
  });

  it("carries the username_taken/409 byte-for-byte", async () => {
    signIn();
    updatePrivateUsername.mockResolvedValueOnce(
      jsonError(409, "username_taken", "That username is already aboard"),
    );

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(body(`${BASE}/me/profile`, "PATCH", { username: "taken" }));

    expect(response?.status).toBe(409);
    expect(await readJson(response)).toEqual({
      code: "username_taken",
      message: "That username is already aboard",
      ok: false,
    });
  });
});

// ── delete_private_account (POST /me/delete) ─────────────────────────────────

describe("oRPC /me — POST /me/delete (delete_private_account)", () => {
  it("serves { ok: true, summary }", async () => {
    signIn();
    const summary = {
      credentials: "deleted",
      galaxyProgress: "deleted",
      savedFindings: "deleted",
      sessions: "revoked",
      submissions: "anonymized",
      user: "marked_deleted",
      verifications: "deleted",
    };
    deleteAccount.mockResolvedValueOnce({ ok: true, summary });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(body(`${BASE}/me/delete`, "POST", {}));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true, summary });
  });
});

// ── export_private_account_data (POST /me/export) ────────────────────────────

describe("oRPC /me — POST /me/export (export_private_account_data)", () => {
  it("serves the { export, ok: true } envelope", async () => {
    signIn();
    const payload = {
      export: {
        account: USER,
        generatedAt: "2026-01-01T00:00:00.000Z",
        id: "exp-1",
        preferences: { keyNotation: "camelot" },
        privacyNotes: ["a", "b"],
        progress: { collectedLogIds: [], deaths: 0, ok: true, wins: 0 },
        savedFindings: [],
        submissions: [],
      },
      ok: true,
    };
    exportAccountData.mockResolvedValueOnce(payload);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(body(`${BASE}/me/export`, "POST", {}));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual(payload);
  });
});

// ── get_private_account_export (GET /me/export/{exportId}) ───────────────────

describe("oRPC /me — GET /me/export/{exportId} (get_private_account_export)", () => {
  it("serves the export-status envelope", async () => {
    signIn();
    const payload = {
      export: {
        completedAt: "2026-01-01T00:00:01.000Z",
        expiresAt: "2026-01-02T00:00:00.000Z",
        id: "exp-1",
        requestedAt: "2026-01-01T00:00:00.000Z",
        status: "completed",
      },
      ok: true,
    };
    getAccountExport.mockResolvedValueOnce(payload);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get(`${BASE}/me/export/exp-1`));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual(payload);
    expect(getAccountExport.mock.calls[0]?.[1]).toBe("exp-1");
  });

  it("carries the export_not_found/404 byte-for-byte", async () => {
    signIn();
    getAccountExport.mockResolvedValueOnce(jsonError(404, "export_not_found", "Export not found"));

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get(`${BASE}/me/export/nope`));

    expect(response?.status).toBe(404);
    expect(await readJson(response)).toEqual({
      code: "export_not_found",
      message: "Export not found",
      ok: false,
    });
  });
});

// ── list_private_submissions (GET /me/submissions) ───────────────────────────

describe("oRPC /me — GET /me/submissions (list_private_submissions)", () => {
  it("serves { ok: true, submissions }", async () => {
    signIn();
    const submissions = [
      {
        artists: ["Some Artist"],
        createdAt: "2026-01-01T00:00:00.000Z",
        id: "sub-1",
        source: "web",
        spotifyUrl: "https://open.spotify.com/track/abc",
        status: "pending_review",
        title: "Some Banger",
      },
    ];
    listUserSubmissions.mockResolvedValueOnce({ ok: true, submissions });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get(`${BASE}/me/submissions`));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true, submissions });
  });
});

// ── The bare /api alias is GONE (the vocabulary cut) — the /me tier is /api/v1 only ──

describe("oRPC /me — the bare /api alias is retired", () => {
  it("no longer serves get_current_private_user on the bare /api/me (falls through)", async () => {
    meResponse.mockResolvedValueOnce({ googleEnabled: false, ok: true, user: null });

    const { handleOrpc } = await import("./orpc");
    // The vocabulary cut removed the bare `/api` alias: the /me tier serves at /api/v1/me only.
    expect(await handleOrpc(get("https://www.fluncle.com/api/me"))).toBeNull();
    expect(meResponse).not.toHaveBeenCalled();
  });

  it("serves get_current_private_user on the canonical /api/v1/me mount", async () => {
    meResponse.mockResolvedValueOnce({ googleEnabled: false, ok: true, user: null });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/me"));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ googleEnabled: false, ok: true, user: null });
  });
});

// ── OpenAPI doc emits all thirteen operationIds ──────────────────────────────

describe("oRPC OpenAPI generation — Wave B operationIds", () => {
  it("emits all thirteen /me operations", async () => {
    const { generateOpenApiDocument } = await import("./orpc");
    const document = (await generateOpenApiDocument()) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };

    expect(document.paths["/me"]?.get?.operationId).toBe("getCurrentPrivateUser");
    expect(document.paths["/me/csrf"]?.get?.operationId).toBe("getPrivateMutationToken");
    expect(document.paths["/me/saved-findings"]?.get?.operationId).toBe("listPrivateSavedFindings");
    expect(document.paths["/me/saved-findings"]?.post?.operationId).toBe("savePrivateFinding");
    expect(document.paths["/me/saved-findings/{trackId}"]?.delete?.operationId).toBe(
      "unsavePrivateFinding",
    );
    expect(document.paths["/me/galaxy-progress"]?.get?.operationId).toBe(
      "getPrivateGalaxyProgress",
    );
    expect(document.paths["/me/galaxy-progress"]?.put?.operationId).toBe(
      "mergePrivateGalaxyProgress",
    );
    expect(document.paths["/me/galaxy-progress/logs"]?.post?.operationId).toBe(
      "collectPrivateGalaxyLog",
    );
    expect(document.paths["/me/profile"]?.patch?.operationId).toBe("updatePrivateProfile");
    expect(document.paths["/me/delete"]?.post?.operationId).toBe("deletePrivateAccount");
    expect(document.paths["/me/export"]?.post?.operationId).toBe("exportPrivateAccountData");
    expect(document.paths["/me/export/{exportId}"]?.get?.operationId).toBe(
      "getPrivateAccountExport",
    );
    expect(document.paths["/me/submissions"]?.get?.operationId).toBe("listPrivateSubmissions");
    expect(document.paths["/me/saved-sets"]?.get?.operationId).toBe("listPrivateSavedSets");
    expect(document.paths["/me/saved-sets"]?.post?.operationId).toBe("savePrivateSet");
    expect(document.paths["/me/saved-sets/{id}"]?.patch?.operationId).toBe("updatePrivateSavedSet");
    expect(document.paths["/me/saved-sets/{id}"]?.delete?.operationId).toBe(
      "deletePrivateSavedSet",
    );
  });
});
