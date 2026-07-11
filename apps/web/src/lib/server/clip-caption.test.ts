import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildClipCaption } from "./clip-caption";

// buildClipCaption (RFC plan→recording→mixtape §5). The coordinate shapes:
//   - PUBLISHED source recording → ONE line (the promoted mixtape's `.F.` Log ID);
//   - un-promoted, window over ONE finding → one line;
//   - un-promoted, window straddling TWO cues → a BLEND (two lines);
//   - a non-finding cue → honest silence (no coordinate).
// A clip's only owner is its recording since the plan→recording→mixtape Deploy-2
// cutover dropped `mixtape_clips.mixtape_id`. The clip/recording reads are mocked;
// only the finding_id→log_id lookup hits the (mocked) DB, so the test drives the
// derivation, not libsql.

type Clip = {
  caption?: string;
  id: string;
  inMs: number;
  outMs: number;
  recordingId?: string;
};

type Recording = { durationMs?: number; logId?: string };

const state = vi.hoisted(() => ({
  clip: {} as Clip,
  // finding_id (trackId) → log_id, for published findings only.
  logIdByFinding: {} as Record<string, string>,
  recording: {} as Recording,
  // The recording's raw cues (with finding_id).
  recordingCues: [] as Array<{
    artists_text: string | null;
    finding_id: string | null;
    start_ms: number | null;
    title_text: string | null;
  }>,
}));

const getClip = vi.hoisted(() => vi.fn(async () => state.clip));
const getRecording = vi.hoisted(() => vi.fn(async () => state.recording));
const getRecordingCues = vi.hoisted(() => vi.fn(async () => state.recordingCues));

const execute = vi.hoisted(() =>
  vi.fn(async (query: { args: unknown[]; sql: string }) => {
    // The finding_id → log_id lookup (published findings only).
    if (query.sql.includes("from findings") && query.sql.includes("track_id in")) {
      const rows = (query.args as string[])
        .filter((trackId) => state.logIdByFinding[trackId])
        .map((trackId) => ({ log_id: state.logIdByFinding[trackId], track_id: trackId }));

      return { rows };
    }

    return { rows: [] };
  }),
);

vi.mock("./clips", () => ({ getClip }));
vi.mock("./recordings", () => ({ getRecording, getRecordingCues }));
vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

beforeEach(() => {
  state.clip = { id: "clip-1", inMs: 0, outMs: 60_000 };
  state.recording = {};
  state.recordingCues = [];
  state.logIdByFinding = {};
  getClip.mockClear();
  getRecording.mockClear();
  getRecordingCues.mockClear();
  execute.mockClear();
});

describe("buildClipCaption", () => {
  it("published source recording → the promoted mixtape's single coordinate", async () => {
    state.clip = {
      caption: "rolling out",
      id: "c",
      inMs: 10_000,
      outMs: 40_000,
      recordingId: "rec-1",
    };
    state.recording = { durationMs: 3_600_000, logId: "019.F.1A" };

    const built = await buildClipCaption("c");

    expect(built.coordinates).toEqual(["fluncle://019.F.1A"]);
    expect(built.builtCaption).toBe("rolling out\n\nfluncle://019.F.1A");
    // A published recording never needs the per-finding cue read.
    expect(getRecordingCues).not.toHaveBeenCalled();
  });

  it("un-promoted, window over ONE finding → that finding's coordinate", async () => {
    state.clip = { id: "c", inMs: 30_000, outMs: 50_000, recordingId: "rec-1" };
    state.recording = { durationMs: 600_000 };
    state.recordingCues = [
      { artists_text: "Alix Perez", finding_id: "t1", start_ms: 0, title_text: "A" },
      { artists_text: "Calibre", finding_id: "t2", start_ms: 120_000, title_text: "B" },
    ];
    state.logIdByFinding = { t1: "019.F.1A", t2: "019.F.1B" };

    const built = await buildClipCaption("c");

    // The window [30s,50s) sits inside t1's interval [0,120s) → only t1.
    expect(built.coordinates).toEqual(["fluncle://019.F.1A"]);
    expect(built.builtCaption).toBe("fluncle://019.F.1A");
  });

  it("un-promoted, window straddling two cues → a BLEND (multiple lines)", async () => {
    state.clip = {
      caption: "the switch",
      id: "c",
      inMs: 100_000,
      outMs: 140_000,
      recordingId: "rec-1",
    };
    state.recording = { durationMs: 600_000 };
    state.recordingCues = [
      { artists_text: "A", finding_id: "t1", start_ms: 0, title_text: "One" },
      { artists_text: "B", finding_id: "t2", start_ms: 120_000, title_text: "Two" },
    ];
    state.logIdByFinding = { t1: "019.F.1A", t2: "019.F.1B" };

    const built = await buildClipCaption("c");

    // [100s,140s) overlaps t1 [0,120s) AND t2 [120s,end) → both, in play order.
    expect(built.coordinates).toEqual(["fluncle://019.F.1A", "fluncle://019.F.1B"]);
    expect(built.builtCaption).toBe("the switch\n\nfluncle://019.F.1A\nfluncle://019.F.1B");
  });

  it("skips a non-finding cue (no coordinate to emit) — honest silence", async () => {
    state.clip = { id: "c", inMs: 10_000, outMs: 20_000, recordingId: "rec-1" };
    state.recording = { durationMs: 600_000 };
    // The only overlapping cue is a played-but-not-a-finding track: no logId.
    state.recordingCues = [
      { artists_text: "White Label", finding_id: null, start_ms: 0, title_text: "Dubplate" },
    ];

    const built = await buildClipCaption("c");

    expect(built.coordinates).toEqual([]);
    expect(built.builtCaption).toBe("");
  });

  it("a clip with no recording links nothing (honest silence)", async () => {
    state.clip = { id: "c", inMs: 0, outMs: 30_000 };

    const built = await buildClipCaption("c");

    expect(built.coordinates).toEqual([]);
    expect(built.builtCaption).toBe("");
  });
});
