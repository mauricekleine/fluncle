import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ApiError } from "./api-error";
import { OPERATOR_TOKEN, readJson, req, setAdminTokenEnv, warmOrpcRouter } from "./orpc-test-kit";

const captureException = vi.fn();
const recordLabelTriage = vi.fn();

vi.mock("@sentry/cloudflare", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/cloudflare")>()),
  captureException: (...args: unknown[]) => captureException(...args),
}));

vi.mock("./labels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./labels")>()),
  recordLabelTriage: (...args: unknown[]) => recordLabelTriage(...args),
}));

beforeAll(() => {
  setAdminTokenEnv();
});
warmOrpcRouter();

afterEach(() => {
  captureException.mockClear();
  recordLabelTriage.mockReset();
});

const triage = () =>
  import("./orpc").then(({ handleOrpc }) =>
    handleOrpc(
      req("/admin/labels/some-label/triage", "POST", OPERATOR_TOKEN, {
        confidence: "high",
        evidence: "census",
        roundId: "round-1",
        verdict: "dnb",
      }),
    ),
  );

describe("record_label_triage keeps a typed ApiError typed", () => {
  it("answers database_busy as its own 503 without a Sentry capture", async () => {
    recordLabelTriage.mockRejectedValue(
      new ApiError("database_busy", "Try again in a minute.", 503),
    );

    const response = await triage();

    expect(response?.status).toBe(503);
    expect(await readJson(response)).toMatchObject({
      code: "database_busy",
      message: "Try again in a minute.",
      ok: false,
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown slug without a Sentry capture", async () => {
    recordLabelTriage.mockResolvedValue(undefined);

    const response = await triage();

    expect(response?.status).toBe(404);
    expect(captureException).not.toHaveBeenCalled();
  });

  it("still reports an unexpected throw once as a 500", async () => {
    recordLabelTriage.mockRejectedValue(new Error("boom"));

    const response = await triage();

    expect(response?.status).toBe(500);
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
