import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();

vi.mock("./db", () => ({
  getDb: async () => ({ execute: (...a: unknown[]) => execute(...a) }),
  typedRow: <T>(rows: T[]): T | undefined => rows[0],
  typedRows: <T>(rows: T[]): T[] => rows,
}));

const getRecording = vi.fn();

vi.mock("./recordings", () => ({
  getRecording: (...a: unknown[]) => getRecording(...a),
}));

const buildCaptionForClip = vi.fn();

vi.mock("./clip-caption-builder", () => ({
  buildCaptionForClip: (...a: unknown[]) => buildCaptionForClip(...a),
}));

const nextDripSlot = vi.fn();
const upsertClipPost = vi.fn();

vi.mock("./clip-social", () => ({
  nextDripSlot: (...a: unknown[]) => nextDripSlot(...a),
  upsertClipPost: (...a: unknown[]) => upsertClipPost(...a),
}));

import { createClip } from "./clips";

function clipRow(id: string) {
  return {
    caption: null,
    created_at: "2026-07-05T00:00:00.000Z",
    id,
    in_ms: 0,
    out_ms: 30_000,
    recording_id: "rec-1",
    status: "pending",
    updated_at: "2026-07-05T00:00:00.000Z",
    x_offset: 240,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getRecording.mockResolvedValue({ id: "rec-1" });

  execute.mockImplementation(async (q: { sql: string }) => {
    if (q.sql.trim().startsWith("select")) {
      return { rows: [clipRow("generated-id")] };
    }
    return { rows: [] };
  });
  buildCaptionForClip.mockResolvedValue({ builtCaption: "the caption", coordinates: [] });
  nextDripSlot.mockResolvedValue("2026-07-06T12:00:00.000Z");
});

describe("createClip auto-queue-on-create", () => {
  it("enrols the new clip onto the IG drip-feed with the rolled slot + caption snapshot", async () => {
    await createClip("rec-1", { inMs: 0, outMs: 30_000, xOffset: 240 });

    expect(nextDripSlot).toHaveBeenCalledTimes(1);
    expect(buildCaptionForClip).toHaveBeenCalledTimes(1);
    expect(upsertClipPost).toHaveBeenCalledTimes(1);

    const arg = upsertClipPost.mock.calls[0]?.[0] as {
      caption: string;
      clipId: string;
      scheduledFor: string;
    };
    expect(arg.caption).toBe("the caption");
    expect(arg.scheduledFor).toBe("2026-07-06T12:00:00.000Z");

    expect(typeof arg.clipId).toBe("string");
    expect(arg.clipId.length).toBeGreaterThan(0);
  });

  it("still returns the created clip when scheduling throws (best-effort)", async () => {
    upsertClipPost.mockRejectedValue(new Error("db down"));

    const clip = await createClip("rec-1", { inMs: 0, outMs: 30_000, xOffset: 240 });

    expect(clip.id).toBe("generated-id");
    expect(clip.status).toBe("pending");
  });
});
