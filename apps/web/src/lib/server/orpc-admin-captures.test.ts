import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { OPERATOR_TOKEN, readJson, req, setAdminTokenEnv, warmOrpcRouter } from "./orpc-test-kit";

const listUnverifiedCapturesMock = vi.fn();
const countUnverifiedCapturesMock = vi.fn();

vi.mock("./catalogue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./catalogue")>();

  return {
    ...actual,
    countUnverifiedCaptures: () => countUnverifiedCapturesMock(),
    listUnverifiedCaptures: (...args: unknown[]) => listUnverifiedCapturesMock(...args),
  };
});

beforeAll(setAdminTokenEnv);

warmOrpcRouter();

beforeEach(() => {
  listUnverifiedCapturesMock.mockReset();
  listUnverifiedCapturesMock.mockResolvedValue([]);
  countUnverifiedCapturesMock.mockReset();
  countUnverifiedCapturesMock.mockResolvedValue(7);
});

describe("oRPC list_unverified_captures (GET /admin/catalogue/captures/unverified)", () => {
  it("counts the worklist only when count=true", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/catalogue/captures/unverified?limit=5&count=true", "GET", OPERATOR_TOKEN),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true, queued: 7, tracks: [] });
    expect(listUnverifiedCapturesMock).toHaveBeenCalledWith(5);
    expect(countUnverifiedCapturesMock).toHaveBeenCalledTimes(1);
  });

  it.each(["count=false", ""])("skips the count for %j", async (query) => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/catalogue/captures/unverified?${query}`, "GET", OPERATOR_TOKEN),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true, tracks: [] });
    expect(listUnverifiedCapturesMock).toHaveBeenCalledWith(50);
    expect(countUnverifiedCapturesMock).not.toHaveBeenCalled();
  });
});
