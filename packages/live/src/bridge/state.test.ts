// THE SHOW STATE MACHINE — the bridge's single source of truth (state.ts). These pin the
// fused ShowState it emits: per-channel audio health across the stale/silent thresholds, the
// operator dials (intensity clamp, blackout), the plan pointer under manual goto/advance/rewind,
// the watchdog heartbeat — AND the WS never-crash rail at the state boundary (a malformed mel
// frame or a non-finite dial must never throw, poison the broadcast match, or drive the glass).
// Pure of I/O (no socket, no clock): the host feeds synthetic ShowCommands + wall-clock ms.

import { describe, expect, test } from "bun:test";

import { MEL_BINS, type PlanEntry, type ShowCommand } from "../contract";
import { type Fingerprint } from "./matcher";
import { shapeNormalize } from "./mel";
import { createShowState } from "./state";

/** A deterministic SHAPE-normalized mel frame from a seed (mirrors matcher.test.ts): a
 * seed-keyed spectral bump, so distinct seeds are near-orthogonal after mean-subtraction. */
function frame(seed: number): Float32Array {
  const v = new Float32Array(MEL_BINS);
  const center = (seed * 7) % MEL_BINS;
  for (let i = 0; i < MEL_BINS; i++) {
    const d = Math.min(Math.abs(i - center), MEL_BINS - Math.abs(i - center));
    v[i] = Math.exp(-(d * d) / 8);
  }
  return shapeNormalize(v);
}

/** A run of frames sharing one seed = one track's stable "sound". */
function track(seed: number, count: number): Float32Array[] {
  return Array.from({ length: count }, () => frame(seed));
}

/** A raw (un-normalized) wire frame of MEL_BINS finite numbers, for the ingest path. */
function wireFrame(seed: number): number[] {
  const center = (seed * 7) % MEL_BINS;
  return Array.from({ length: MEL_BINS }, (_, i) => {
    const d = Math.min(Math.abs(i - center), MEL_BINS - Math.abs(i - center));
    return Math.exp(-(d * d) / 8) + 0.5; // + a positive offset so it reads as energy
  });
}

function plan(n: number): PlanEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    artists: [`Artist ${i}`],
    logId: `T${i}`,
    title: `Track ${i}`,
  }));
}

function fps(seeds: (number | null)[]): Fingerprint[] {
  return seeds.map((s, i) => ({ frames: s === null ? null : track(s, 300), logId: `T${i}` }));
}

/** A short config so the matcher fills + advances in a few virtual seconds. */
const cfg = { firstDwellMs: 1_000, minDwellMs: 1_000, sustainMs: 1_500, windowFrames: 60 };

/** Feed a malformed command through the typed boundary (mirrors how serve.ts casts). */
function ingestRaw(state: ReturnType<typeof createShowState>, raw: unknown, tMs: number): void {
  state.ingest(raw as ShowCommand, tMs);
}

describe("boot snapshot", () => {
  test("starts at pointer 0, source boot, dials at rest", () => {
    const state = createShowState(plan(3), fps([1, 2, 3]), cfg);
    const s = state.snapshot(0);
    expect(s.plan).toEqual({ pointer: 0, source: "boot", total: 3 });
    expect(s.current).toEqual({ artists: ["Artist 0"], logId: "T0", title: "Track 0" });
    expect(s.intensity).toBe(1);
    expect(s.blackout).toBe(false);
    expect(s.prearmed).toBe(false);
    expect(s.channels.matcher).toBe("ready");
  });

  test("matcher channel is off when no fingerprint has frames", () => {
    const state = createShowState(plan(2), fps([null, null]), cfg);
    expect(state.snapshot(0).channels.matcher).toBe("off");
    expect(state.matcherReady).toBe(false);
  });

  test("seq is monotonic across snapshots", () => {
    const state = createShowState(plan(1), fps([1]), cfg);
    expect(state.snapshot(0).seq).toBe(0);
    expect(state.snapshot(0).seq).toBe(1);
    expect(state.snapshot(0).seq).toBe(2);
  });
});

describe("audio channel health (stale/silent thresholds)", () => {
  test("silent before any mel frame arrives", () => {
    const state = createShowState(plan(1), fps([1]), cfg);
    expect(state.snapshot(10_000).channels.audio).toBe("silent");
  });

  test("live within 1500ms, stale past it, silent past 5000ms", () => {
    const state = createShowState(plan(2), fps([1, 2]), cfg);
    state.ingest({ cmd: "mel", frame: wireFrame(1), t: 0 }, 0);
    expect(state.snapshot(1_000).channels.audio).toBe("live"); // < 1500
    expect(state.snapshot(1_500).channels.audio).toBe("live"); // boundary is exclusive
    expect(state.snapshot(2_000).channels.audio).toBe("stale"); // > 1500, < 5000
    expect(state.snapshot(5_000).channels.audio).toBe("stale"); // boundary is exclusive
    expect(state.snapshot(6_000).channels.audio).toBe("silent"); // > 5000
  });
});

describe("operator dials", () => {
  test("blackout on then off", () => {
    const state = createShowState(plan(1), fps([1]), cfg);
    state.ingest({ cmd: "blackout", on: true }, 0);
    expect(state.snapshot(0).blackout).toBe(true);
    state.ingest({ cmd: "blackout", on: false }, 0);
    expect(state.snapshot(0).blackout).toBe(false);
  });

  test("intensity is stored in range and clamped outside it", () => {
    const state = createShowState(plan(1), fps([1]), cfg);
    state.ingest({ cmd: "intensity", value: 1.2 }, 0);
    expect(state.snapshot(0).intensity).toBe(1.2);
    state.ingest({ cmd: "intensity", value: 999 }, 0);
    expect(state.snapshot(0).intensity).toBe(1.6); // clamped to the glass's ceiling
    state.ingest({ cmd: "intensity", value: -5 }, 0);
    expect(state.snapshot(0).intensity).toBe(0.4); // clamped to the floor
  });
});

describe("plan pointer under manual commands", () => {
  test("advance / goto / rewind win instantly and set the manual source", () => {
    const state = createShowState(plan(4), fps([1, 2, 3, 4]), cfg);
    state.ingest({ cmd: "advance" }, 0);
    expect(state.snapshot(0).plan).toEqual({ pointer: 1, source: "manual", total: 4 });
    state.ingest({ cmd: "goto", index: 3 }, 100);
    expect(state.snapshot(0).plan.pointer).toBe(3);
    state.ingest({ cmd: "rewind" }, 200);
    expect(state.snapshot(0).plan.pointer).toBe(2);
  });

  test("goto is clamped to the plan bounds", () => {
    const state = createShowState(plan(4), fps([1, 2, 3, 4]), cfg);
    state.ingest({ cmd: "goto", index: 99 }, 0);
    expect(state.snapshot(0).plan.pointer).toBe(3);
    state.ingest({ cmd: "goto", index: -5 }, 0);
    expect(state.snapshot(0).plan.pointer).toBe(0);
  });

  test("current + pending reflect the pointer", () => {
    const state = createShowState(plan(4), fps([1, 2, 3, 4]), cfg);
    state.ingest({ cmd: "goto", index: 1 }, 0);
    const s = state.snapshot(0);
    expect(s.current?.logId).toBe("T1");
    expect(s.pending?.logId).toBe("T2");
  });
});

describe("heartbeat watchdog feed", () => {
  test("records the frame counter and reports its age", () => {
    const state = createShowState(plan(1), fps([1]), cfg);
    expect(state.heartbeatAgeMs(1_000)).toBe(-1); // never fed
    state.ingest({ cmd: "heartbeat", renderFrame: 42 }, 1_000);
    expect(state.heartbeatAgeMs(1_500)).toBe(500);
    expect(state.lastHeartbeatFrame()).toBe(42);
  });
});

describe("fingerprint-driven advance", () => {
  test("advances the pointer when the pending track's audio plays", () => {
    const state = createShowState(plan(3), fps([1, 2, 3]), cfg);
    for (let i = 0, t = 0; i < 120; i++, t += 100) {
      state.ingest({ cmd: "mel", frame: wireFrame(2), t }, t); // track 1's sound
    }
    const s = state.snapshot(12_000);
    expect(s.plan.pointer).toBe(1);
    expect(s.plan.source).toBe("fingerprint");
    expect(s.match).toBeDefined();
    expect(Number.isFinite(s.match?.confidence)).toBe(true); // confidence never NaN
    expect(typeof s.match?.logId).toBe("string"); // a real plan entry, never undefined
  });
});

describe("WS never-crash rail at the state boundary", () => {
  test("a mel command with no frame is dropped (no throw, audio stays silent, no match)", () => {
    const state = createShowState(plan(2), fps([1, 2]), cfg);
    expect(() => ingestRaw(state, { cmd: "mel", t: 0 }, 0)).not.toThrow();
    const s = state.snapshot(100);
    expect(s.channels.audio).toBe("silent"); // never marked live
    expect(s.match).toBeUndefined();
  });

  test("a null frame is dropped without throwing", () => {
    const state = createShowState(plan(2), fps([1, 2]), cfg);
    expect(() => ingestRaw(state, { cmd: "mel", frame: null, t: 0 }, 0)).not.toThrow();
    expect(state.snapshot(100).channels.audio).toBe("silent");
  });

  test("a frame SHORTER than MEL_BINS is dropped — no NaN escapes into the match", () => {
    const state = createShowState(plan(2), fps([1, 2]), cfg);
    // Feed many short frames; a naive slice would feed the matcher undefined bins → NaN cosine.
    for (let i = 0, t = 0; i < 120; i++, t += 100) {
      ingestRaw(state, { cmd: "mel", frame: [1, 2, 3], t }, t);
    }
    const s = state.snapshot(12_100);
    expect(s.channels.audio).toBe("silent"); // dropped: not live audio
    expect(s.match).toBeUndefined(); // never a NaN-poisoned confidence
    expect(s.plan.pointer).toBe(0); // and never a phantom advance
  });

  test("a full-length frame carrying a non-finite bin is dropped", () => {
    const state = createShowState(plan(2), fps([1, 2]), cfg);
    const bad = wireFrame(2);
    bad[10] = Number.NaN;
    for (let i = 0, t = 0; i < 120; i++, t += 100) {
      ingestRaw(state, { cmd: "mel", frame: bad, t }, t);
    }
    const s = state.snapshot(12_100);
    expect(s.channels.audio).toBe("silent");
    expect(s.match).toBeUndefined();
  });

  test("a non-finite intensity is rejected — the last good value holds, never NaN", () => {
    const state = createShowState(plan(1), fps([1]), cfg);
    state.ingest({ cmd: "intensity", value: 1.1 }, 0);
    ingestRaw(state, { cmd: "intensity", value: Number.NaN }, 0);
    ingestRaw(state, { cmd: "intensity", value: Number.POSITIVE_INFINITY }, 0);
    const s = state.snapshot(0);
    expect(s.intensity).toBe(1.1);
    expect(Number.isFinite(s.intensity)).toBe(true);
  });

  test("a non-finite goto index is rejected — the pointer never becomes NaN", () => {
    const state = createShowState(plan(4), fps([1, 2, 3, 4]), cfg);
    state.ingest({ cmd: "goto", index: 2 }, 0);
    ingestRaw(state, { cmd: "goto", index: Number.NaN }, 100);
    const s = state.snapshot(0);
    expect(s.plan.pointer).toBe(2); // held; not NaN
    expect(Number.isFinite(s.plan.pointer)).toBe(true);
  });

  test("a non-finite heartbeat frame is ignored (watchdog age stays trustworthy)", () => {
    const state = createShowState(plan(1), fps([1]), cfg);
    ingestRaw(state, { cmd: "heartbeat", renderFrame: Number.NaN }, 1_000);
    expect(state.heartbeatAgeMs(1_500)).toBe(-1); // never recorded
  });
});
