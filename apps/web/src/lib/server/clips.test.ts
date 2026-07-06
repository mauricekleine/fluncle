import { beforeEach, describe, expect, it, vi } from "vitest";

// The clip data layer's AUTO-QUEUE-ON-CREATE wiring (lib/server/clips.ts `createClip`).
// After inserting the clip, createClip enrols it onto the Instagram drip-feed: build the
// caption snapshot, roll the next jittered slot (`nextDripSlot`), and `upsertClipPost`.
// The scheduling is BEST-EFFORT — a hiccup must not fail the create (the clip is already
// made; the operator can re-schedule). The jitter math itself is unit-tested in
// clip-social.test.ts; here we pin the wiring + the best-effort guard.

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

const buildClipCaption = vi.fn();

vi.mock("./clip-caption", () => ({
  buildClipCaption: (...a: unknown[]) => buildClipCaption(...a),
}));

const nextDripSlot = vi.fn();
const upsertClipPost = vi.fn();

vi.mock("./clip-social", () => ({
  nextDripSlot: (...a: unknown[]) => nextDripSlot(...a),
  upsertClipPost: (...a: unknown[]) => upsertClipPost(...a),
}));

import { createClip } from "./clips";

// The `select … from mixtape_clips where id = ?` read createClip does twice (once to
// return the created row). Return a plausible clip row shape.
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
  // insert, then the read-back select → the created row.
  execute.mockImplementation(async (q: { sql: string }) => {
    if (q.sql.trim().startsWith("select")) {
      return { rows: [clipRow("generated-id")] };
    }
    return { rows: [] };
  });
  buildClipCaption.mockResolvedValue({ builtCaption: "the caption", coordinates: [] });
  nextDripSlot.mockResolvedValue("2026-07-06T12:00:00.000Z");
});

describe("createClip auto-queue-on-create", () => {
  it("enrols the new clip onto the IG drip-feed with the rolled slot + caption snapshot", async () => {
    await createClip("rec-1", { inMs: 0, outMs: 30_000, xOffset: 240 });

    expect(nextDripSlot).toHaveBeenCalledTimes(1);
    expect(buildClipCaption).toHaveBeenCalledTimes(1);
    expect(upsertClipPost).toHaveBeenCalledTimes(1);

    const arg = upsertClipPost.mock.calls[0]?.[0] as {
      caption: string;
      clipId: string;
      scheduledFor: string;
    };
    expect(arg.caption).toBe("the caption");
    expect(arg.scheduledFor).toBe("2026-07-06T12:00:00.000Z");
    // The clipId scheduled is the same id the insert used (createClip mints it).
    expect(typeof arg.clipId).toBe("string");
    expect(arg.clipId.length).toBeGreaterThan(0);
  });

  it("still returns the created clip when scheduling throws (best-effort)", async () => {
    upsertClipPost.mockRejectedValue(new Error("db down"));

    // Must NOT throw — the clip is already created.
    const clip = await createClip("rec-1", { inMs: 0, outMs: 30_000, xOffset: 240 });

    expect(clip.id).toBe("generated-id");
    expect(clip.status).toBe("pending");
  });
});
