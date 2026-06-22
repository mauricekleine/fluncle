import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The admin wave's `admin-backfills` parity + auth proof: the maintenance sweeps
// driven end-to-end through `handleOrpc` against `/api/v1/admin/...`, so the REAL
// admin auth spine (../orpc-auth) runs — only the data-layer helpers are mocked.
//
//   - backfill_discogs / backfill_lastfm — operator tier (live `requireOperator`):
//     401 no token, 403 agent, the operator passes; the live `?limit/dryRun/cursor`
//     query params parse in-handler and the success envelope is byte-for-byte.

const backfillDiscogsIds = vi.fn();
const backfillLastfmLoves = vi.fn();

vi.mock("./backfill", () => ({
  backfillDiscogsIds: (...args: unknown[]) => backfillDiscogsIds(...args),
  backfillLastfmLoves: (...args: unknown[]) => backfillLastfmLoves(...args),
}));

const OPERATOR_TOKEN = "test-token-admin-operator";
const AGENT_TOKEN = "test-token-admin-agent";

beforeAll(() => {
  process.env.FLUNCLE_API_TOKEN = OPERATOR_TOKEN;
  process.env.FLUNCLE_AGENT_TOKEN = AGENT_TOKEN;
});

beforeEach(() => {
  backfillDiscogsIds.mockReset();
  backfillLastfmLoves.mockReset();
});

// A bodyless POST (no Content-Type), the exact shape the CLI's `adminApiPost`
// sends for these query-only ops after the wave (it no longer claims a JSON
// content-type without a body).
function post(path: string, token: string | undefined): Request {
  const headers: Record<string, string> = {};

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return new Request(`https://www.fluncle.com/api/v1${path}`, { headers, method: "POST" });
}

// ── backfill_discogs — operator tier ─────────────────────────────────────────
describe("oRPC backfill_discogs (POST /admin/backfill/discogs)", () => {
  it("401s with no admin token", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/admin/backfill/discogs", undefined));

    expect(response?.status).toBe(401);
    expect(backfillDiscogsIds).not.toHaveBeenCalled();
  });

  it("403s the AGENT (operator-only)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/admin/backfill/discogs", AGENT_TOKEN));

    expect(response?.status).toBe(403);
    expect(((await response?.json()) as { code: string }).code).toBe("forbidden");
    expect(backfillDiscogsIds).not.toHaveBeenCalled();
  });

  it("runs a pass for the operator and returns the live envelope", async () => {
    backfillDiscogsIds.mockResolvedValueOnce({
      dryRun: false,
      nextCursor: "cur-2",
      resolved: [{ logId: "004.7.2I", releaseId: 12, source: "discogs" }],
      resolvedCount: 1,
      unresolved: ["004.7.3J"],
      unresolvedCount: 1,
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      post("/admin/backfill/discogs?limit=10&dryRun=1&cursor=cur-1", OPERATOR_TOKEN),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      dryRun: false,
      nextCursor: "cur-2",
      ok: true,
      resolved: [{ logId: "004.7.2I", releaseId: 12, source: "discogs" }],
      resolvedCount: 1,
      unresolved: ["004.7.3J"],
      unresolvedCount: 1,
    });
    // The query params parsed in-handler (limit clamped, dryRun=1 → true, cursor).
    expect(backfillDiscogsIds).toHaveBeenCalledWith(10, true, "cur-1");
  });
});

// ── backfill_lastfm — operator tier ──────────────────────────────────────────
describe("oRPC backfill_lastfm (POST /admin/backfill/lastfm)", () => {
  it("403s the AGENT (operator-only)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/admin/backfill/lastfm", AGENT_TOKEN));

    expect(response?.status).toBe(403);
    expect(backfillLastfmLoves).not.toHaveBeenCalled();
  });

  it("runs a pass for the operator and returns the live envelope", async () => {
    backfillLastfmLoves.mockResolvedValueOnce({
      dryRun: true,
      failed: [{ error: "boom", logId: "004.7.3J" }],
      failedCount: 1,
      loved: ["004.7.2I"],
      lovedCount: 1,
      nextCursor: null,
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/admin/backfill/lastfm?dryRun=true", OPERATOR_TOKEN));

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      dryRun: true,
      failed: [{ error: "boom", logId: "004.7.3J" }],
      failedCount: 1,
      loved: ["004.7.2I"],
      lovedCount: 1,
      nextCursor: null,
      ok: true,
    });
    // Default limit (50), dryRun=true → true, no cursor.
    expect(backfillLastfmLoves).toHaveBeenCalledWith(50, true, undefined);
  });
});
