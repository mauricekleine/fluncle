import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OPERATOR_TOKEN, readJson, req, setAdminTokenEnv, warmOrpcRouter } from "./orpc-test-kit";

const batch = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => []));

const execute = vi.hoisted(() =>
  vi.fn(async () => ({
    rows: [
      {
        created_at: "2026-10-01T00:00:00.000Z",
        duration_ms: 3_600_000,
        id: "rec-1",
        parent_id: null,
        planned_for: null,
        r2_key: null,
        recorded_at: null,
        title: "Set",
        updated_at: "2026-10-01T00:00:00.000Z",
        version: 1,
      },
    ],
  })),
);

vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db")>()),
  getDb: async () => ({ batch, execute }),
}));

beforeAll(setAdminTokenEnv);

warmOrpcRouter();

beforeEach(() => {
  batch.mockClear();
  execute.mockClear();
});

describe("oRPC replace_recording_cues (PUT /admin/recordings/{recordingId}/cues)", () => {
  it.each([
    ["a wrapped cues file", { cues: { cues: [{ titleText: "Mr Right On" }] } }],
    ["a missing cues field", {}],
  ])("400s `invalid_cues` on %s without touching the stored cues", async (_label, body) => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/recordings/rec-1/cues", "PUT", OPERATOR_TOKEN, body),
    );

    expect(response?.status).toBe(400);
    expect(((await readJson(response)) as { code?: string }).code).toBe("invalid_cues");
    expect(batch).not.toHaveBeenCalled();
  });
});
