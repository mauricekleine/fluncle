import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_TOKEN, readJson, setAdminTokenEnv, warmOrpcRouter } from "./orpc-test-kit";

const listTrackWork = vi.fn();
const countTrackWork = vi.fn();
const readCatalogueCaptureAdmission = vi.fn();

vi.mock("./track-work", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./track-work")>();

  return {
    ...actual,
    countTrackWork: (...args: unknown[]) => countTrackWork(...args),
    listTrackWork: (...args: unknown[]) => listTrackWork(...args),
  };
});

vi.mock("./capture-budget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./capture-budget")>();

  return {
    ...actual,
    readCatalogueCaptureAdmission: (...args: unknown[]) => readCatalogueCaptureAdmission(...args),
  };
});

beforeAll(setAdminTokenEnv);

warmOrpcRouter();

beforeEach(() => {
  listTrackWork.mockReset().mockResolvedValue([]);
  countTrackWork.mockReset().mockResolvedValue(0);
  readCatalogueCaptureAdmission.mockReset();
});

function work(query: string, token: string | undefined): Request {
  const headers: Record<string, string> = {};

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return new Request(`https://www.fluncle.com/api/v1/admin/tracks/work${query}`, { headers });
}

describe("oRPC list_track_work (GET /admin/tracks/work)", () => {
  it("401s with no admin token and reads no worklist", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(work("?kind=capture", undefined));

    expect(response?.status).toBe(401);
    expect(listTrackWork).not.toHaveBeenCalled();
    expect(readCatalogueCaptureAdmission).not.toHaveBeenCalled();
  });

  it("reports a closed catalogue capture budget and hands the same admission to list and count", async () => {
    const admission = { closedReason: "tracks_spent", open: false, remainingTracks: 0 };
    readCatalogueCaptureAdmission.mockResolvedValueOnce(admission);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(work("?kind=capture&count=true", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      catalogueCapture: { closedReason: "tracks_spent", open: false },
      ok: true,
      queued: 0,
      tracks: [],
    });
    expect(readCatalogueCaptureAdmission).toHaveBeenCalledTimes(1);
    expect(listTrackWork).toHaveBeenCalledWith(
      expect.objectContaining({ captureState: admission, kind: "capture", scope: "all" }),
    );
    expect(countTrackWork).toHaveBeenCalledWith(
      expect.objectContaining({ captureState: admission, kind: "capture", scope: "all" }),
    );
  });

  it("omits catalogueCapture while the budget is open", async () => {
    readCatalogueCaptureAdmission.mockResolvedValueOnce({
      closedReason: null,
      open: true,
      remainingTracks: 12,
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(work("?kind=youtube-provenance", AGENT_TOKEN));
    const body = (await readJson(response)) as Record<string, unknown>;

    expect(response?.status).toBe(200);
    expect(body.catalogueCapture).toBeUndefined();
    expect(readCatalogueCaptureAdmission).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a findings-scoped capture list", "?kind=capture&scope=findings"],
    ["an unmetered kind", "?kind=embed"],
  ])("never reads the catalogue budget for %s", async (_label, query) => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(work(query, AGENT_TOKEN));
    const body = (await readJson(response)) as Record<string, unknown>;

    expect(response?.status).toBe(200);
    expect(body.catalogueCapture).toBeUndefined();
    expect(readCatalogueCaptureAdmission).not.toHaveBeenCalled();
    expect(listTrackWork).toHaveBeenCalledWith(
      expect.objectContaining({ captureState: undefined }),
    );
  });
});
