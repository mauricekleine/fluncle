import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readJson } from "./orpc-test-helpers";

// The admin wave's `admin-backfills` parity + auth proof: the maintenance sweeps
// driven end-to-end through `handleOrpc` against `/api/v1/admin/...`, so the REAL
// admin auth spine (../orpc-auth) runs — only the data-layer helpers are mocked.
//
//   - backfill_discogs / backfill_lastfm — agent tier (`adminAuth`): 401 no token,
//     the AGENT token now passes (the box cron drives it), the operator passes too;
//     the live `?limit/dryRun/cursor` params parse in-handler and the success
//     envelope is byte-for-byte.

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

// ── backfill_discogs — agent tier ─────────────────────────────────────────────────────────────────────────────────────
describe("oRPC backfill_discogs (POST /admin/backfill/discogs)", () => {
  it("401s with no admin token", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/admin/backfill/discogs", undefined));

    expect(response?.status).toBe(401);
    expect(backfillDiscogsIds).not.toHaveBeenCalled();
  });

  it("allows the AGENT (agent tier — the box cron drives it)", async () => {
    backfillDiscogsIds.mockResolvedValueOnce({
      dryRun: false,
      nextCursor: null,
      rateLimited: false,
      resolved: [],
      resolvedCount: 0,
      skipped: [],
      skippedCount: 0,
      unresolved: [],
      unresolvedCount: 0,
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/admin/backfill/discogs", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    expect(backfillDiscogsIds).toHaveBeenCalled();
  });

  it("runs a pass for the operator and returns the live envelope", async () => {
    backfillDiscogsIds.mockResolvedValueOnce({
      dryRun: false,
      nextCursor: "cur-2",
      rateLimited: false,
      resolved: [{ logId: "004.7.2I", releaseId: 12, source: "discogs" }],
      resolvedCount: 1,
      skipped: ["004.7.4K"],
      skippedCount: 1,
      unresolved: ["004.7.3J"],
      unresolvedCount: 1,
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      post("/admin/backfill/discogs?limit=10&dryRun=1&cursor=cur-1", OPERATOR_TOKEN),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      dryRun: false,
      nextCursor: "cur-2",
      ok: true,
      rateLimited: false,
      resolved: [{ logId: "004.7.2I", releaseId: 12, source: "discogs" }],
      resolvedCount: 1,
      skipped: ["004.7.4K"],
      skippedCount: 1,
      unresolved: ["004.7.3J"],
      unresolvedCount: 1,
    });
    // The query params parsed in-handler (limit clamped, dryRun=1 → true, cursor).
    expect(backfillDiscogsIds).toHaveBeenCalledWith(10, true, "cur-1");
  });
});

// ── backfill_lastfm — agent tier ───────────────────────────────────────────────────────────────────────────────────────
describe("oRPC backfill_lastfm (POST /admin/backfill/lastfm)", () => {
  it("allows the AGENT (agent tier — the box cron drives it)", async () => {
    backfillLastfmLoves.mockResolvedValueOnce({
      dryRun: false,
      failed: [],
      failedCount: 0,
      loved: [],
      lovedCount: 0,
      nextCursor: null,
      rateLimited: false,
      skipped: [],
      skippedCount: 0,
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/admin/backfill/lastfm", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    expect(backfillLastfmLoves).toHaveBeenCalled();
  });

  it("runs a pass for the operator and returns the live envelope", async () => {
    backfillLastfmLoves.mockResolvedValueOnce({
      dryRun: true,
      failed: [{ error: "boom", logId: "004.7.3J" }],
      failedCount: 1,
      loved: ["004.7.2I"],
      lovedCount: 1,
      nextCursor: null,
      rateLimited: false,
      skipped: ["004.7.4K"],
      skippedCount: 1,
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/admin/backfill/lastfm?dryRun=true", OPERATOR_TOKEN));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      dryRun: true,
      failed: [{ error: "boom", logId: "004.7.3J" }],
      failedCount: 1,
      loved: ["004.7.2I"],
      lovedCount: 1,
      nextCursor: null,
      ok: true,
      rateLimited: false,
      skipped: ["004.7.4K"],
      skippedCount: 1,
    });
    // Default limit (50), dryRun=true → true, no cursor.
    expect(backfillLastfmLoves).toHaveBeenCalledWith(50, true, undefined);
  });
});
