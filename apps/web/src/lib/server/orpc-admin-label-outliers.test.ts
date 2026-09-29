import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_TOKEN,
  OPERATOR_TOKEN,
  readJson,
  req,
  setAdminTokenEnv,
  warmOrpcRouter,
} from "./orpc-test-kit";

const listLabelOutlierInputsPage = vi.hoisted(() => vi.fn());
const recordLabelOutliers = vi.hoisted(() => vi.fn());
const setLabelOutliersDismissed = vi.hoisted(() => vi.fn());

vi.mock("./label-outliers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./label-outliers")>();

  return { ...actual, listLabelOutlierInputsPage, recordLabelOutliers, setLabelOutliersDismissed };
});

beforeAll(setAdminTokenEnv);

warmOrpcRouter();
beforeEach(() => vi.clearAllMocks());

const RUN = {
  labelsScored: 3,
  outliers: [],
  replicaSyncedAt: null,
  totalFlagged: 0,
  tracksScored: 40,
  unitsScored: 12,
};

describe("record_label_outliers — PUT /admin/label-outliers", () => {
  it("answers a refused run with 409 label_outlier_run_rejected", async () => {
    const { LabelOutlierRunRejected } = await import("./label-outliers");
    recordLabelOutliers.mockRejectedValueOnce(
      new LabelOutlierRunRejected("the run scored no tracks"),
    );
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/label-outliers", "PUT", AGENT_TOKEN, RUN));

    expect(response?.status).toBe(409);
    expect(await readJson(response)).toEqual({
      code: "label_outlier_run_rejected",
      message: "the run scored no tracks",
      ok: false,
    });
  });

  it("401s an anonymous run before it reaches the store", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/label-outliers", "PUT", undefined, RUN));

    expect(response?.status).toBe(401);
    expect(recordLabelOutliers).not.toHaveBeenCalled();
  });
});

describe("list_label_outlier_inputs — GET /admin/label-outliers/inputs", () => {
  it("answers a cursor it never issued with 400 invalid_cursor", async () => {
    const { InvalidLabelOutlierInputsCursor } = await import("./label-outliers");
    listLabelOutlierInputsPage.mockRejectedValueOnce(
      new InvalidLabelOutlierInputsCursor("unknown cursor"),
    );
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/label-outliers/inputs?cursor=forged", "GET", AGENT_TOKEN),
    );

    expect(response?.status).toBe(400);
    expect(await readJson(response)).toEqual({
      code: "invalid_cursor",
      message: "unknown cursor",
      ok: false,
    });
  });

  it("caps an oversized page at the contract maximum", async () => {
    const { LABEL_OUTLIER_INPUTS_MAX_PAGE } = await import("@fluncle/contracts/orpc");
    listLabelOutlierInputsPage.mockResolvedValueOnce({ albums: [], nextCursor: null, tracks: [] });
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/label-outliers/inputs?limit=999999", "GET", AGENT_TOKEN),
    );

    expect(response?.status).toBe(200);
    expect(listLabelOutlierInputsPage).toHaveBeenCalledWith(
      undefined,
      LABEL_OUTLIER_INPUTS_MAX_PAGE,
    );
  });
});

describe("set_label_outliers_dismissed — PUT /admin/label-outliers/dismissed", () => {
  it("lets the operator dismiss an outlier", async () => {
    setLabelOutliersDismissed.mockResolvedValueOnce(1);
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/label-outliers/dismissed", "PUT", OPERATOR_TOKEN, {
        dismissed: true,
        unitIds: ["album:one"],
      }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ changed: 1, ok: true });
    expect(setLabelOutliersDismissed).toHaveBeenCalledWith(["album:one"], true);
  });

  it("refuses the agent token, since dismissing is an operator judgment", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/label-outliers/dismissed", "PUT", AGENT_TOKEN, {
        dismissed: true,
        unitIds: ["album:one"],
      }),
    );

    expect(response?.status).toBe(403);
    expect(setLabelOutliersDismissed).not.toHaveBeenCalled();
  });
});
