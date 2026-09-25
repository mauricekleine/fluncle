import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildClipCaption } from "./clip-caption";

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

  logIdByFinding: {} as Record<string, string>,
  recording: {} as Recording,

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

    expect(built.coordinates).toEqual(["fluncle://019.F.1A", "fluncle://019.F.1B"]);
    expect(built.builtCaption).toBe("the switch\n\nfluncle://019.F.1A\nfluncle://019.F.1B");
  });

  it("a non-finding cue emits no coordinate but credits the track by label", async () => {
    state.clip = { id: "c", inMs: 10_000, outMs: 20_000, recordingId: "rec-1" };
    state.recording = { durationMs: 600_000 };

    state.recordingCues = [
      { artists_text: "White Label", finding_id: null, start_ms: 0, title_text: "Dubplate" },
    ];

    const built = await buildClipCaption("c");

    expect(built.coordinates).toEqual([]);
    expect(built.builtCaption).toBe("White Label — Dubplate");
  });

  it("keeps a stored caption above the fallback label, blank line between", async () => {
    state.clip = {
      caption: "cut from the rolling set",
      id: "c",
      inMs: 10_000,
      outMs: 20_000,
      recordingId: "rec-1",
    };
    state.recording = { durationMs: 600_000 };
    state.recordingCues = [
      { artists_text: "Nucleus, Paradox", finding_id: null, start_ms: 0, title_text: "Airborne" },
    ];

    const built = await buildClipCaption("c");

    expect(built.builtCaption).toBe("cut from the rolling set\n\nNucleus, Paradox — Airborne");
  });

  it("credits both tracks of a non-finding BLEND, deduped in play order", async () => {
    state.clip = { id: "c", inMs: 100_000, outMs: 140_000, recordingId: "rec-1" };
    state.recording = { durationMs: 600_000 };
    state.recordingCues = [
      { artists_text: "A", finding_id: null, start_ms: 0, title_text: "One" },
      { artists_text: "B", finding_id: null, start_ms: 120_000, title_text: "Two" },
    ];

    const built = await buildClipCaption("c");

    expect(built.coordinates).toEqual([]);
    expect(built.builtCaption).toBe("A — One\nB — Two");
  });

  it("prefers the coordinate over the label when the blend has ONE finding", async () => {
    state.clip = { id: "c", inMs: 100_000, outMs: 140_000, recordingId: "rec-1" };
    state.recording = { durationMs: 600_000 };
    state.recordingCues = [
      { artists_text: "A", finding_id: null, start_ms: 0, title_text: "One" },
      { artists_text: "B", finding_id: "t2", start_ms: 120_000, title_text: "Two" },
    ];
    state.logIdByFinding = { t2: "019.F.1B" };

    const built = await buildClipCaption("c");

    expect(built.coordinates).toEqual(["fluncle://019.F.1B"]);
    expect(built.builtCaption).toBe("fluncle://019.F.1B");
  });

  it("an UN-CUED recording still builds the empty caption (honest silence)", async () => {
    state.clip = { id: "c", inMs: 10_000, outMs: 20_000, recordingId: "rec-1" };
    state.recording = { durationMs: 600_000 };

    state.recordingCues = [
      { artists_text: "White Label", finding_id: null, start_ms: null, title_text: "Dubplate" },
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
