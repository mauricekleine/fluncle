import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { evaluatePaletteGate } from "./judge-palette";
import { metricsGateVerdict, paletteGateVerdict, sha256File } from "./ship-gates";

const RENDER = "a".repeat(64);
const OTHER_RENDER = "b".repeat(64);

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    allowFlash: false,
    arc: { dead: false, verdict: "evolving" },
    beatPull: { beatLocked: false },
    flashSafety: { unsafe: false, verdict: "safe" },
    gate: { advisories: [], blockingFailures: [], hardPass: true },
    trackId: "t1",
    videoSha256: RENDER,
    ...overrides,
  };
}

function refusal(verdict: ReturnType<typeof metricsGateVerdict>): string {
  if (verdict.ok) {
    throw new Error("expected a refusal");
  }
  return verdict.reason;
}

describe("metricsGateVerdict", () => {
  test("refuses when there is no metrics record, naming the command to run", () => {
    const reason = refusal(
      metricsGateVerdict({ record: null, renderSha256: RENDER, trackId: "t1" }),
    );
    expect(reason).toContain("no judge:metrics record");
    expect(reason).toContain("judge:metrics t1");
  });

  test("refuses a record that carries no render digest", () => {
    const legacy = record();
    delete legacy.videoSha256;
    const reason = refusal(
      metricsGateVerdict({ record: legacy, renderSha256: RENDER, trackId: "t1" }),
    );
    expect(reason).toContain("no render digest");
  });

  test("refuses a stale record that measured a different render", () => {
    const reason = refusal(
      metricsGateVerdict({ record: record(), renderSha256: OTHER_RENDER, trackId: "t1" }),
    );
    expect(reason).toContain("stale record");
  });

  test("refuses a failed record and names the failing gates", () => {
    const failed = record({
      flashSafety: { unsafe: true, verdict: "unsafe" },
      gate: { advisories: [], blockingFailures: ["flashSafety", "beatPull"], hardPass: false },
    });
    const reason = refusal(
      metricsGateVerdict({ record: failed, renderSha256: RENDER, trackId: "t1" }),
    );
    expect(reason).toContain("judge:metrics FAILED (flashSafety, beatPull)");
  });

  test("refuses a record whose gate block is missing", () => {
    const noGate = record();
    delete noGate.gate;
    const reason = refusal(
      metricsGateVerdict({ record: noGate, renderSha256: RENDER, trackId: "t1" }),
    );
    expect(reason).toContain("FAILED");
  });

  test("accepts a passing record for this render", () => {
    const verdict = metricsGateVerdict({ record: record(), renderSha256: RENDER, trackId: "t1" });
    expect(verdict).toEqual({ notes: [], ok: true });
  });

  test("honours a recorded --allow-flash override and names it", () => {
    const overridden = record({
      allowFlash: true,
      flashSafety: { unsafe: true, verdict: "unsafe" },
      gate: {
        advisories: ["flashSafety.overridden(--allow-flash)"],
        blockingFailures: [],
        hardPass: true,
      },
    });
    const verdict = metricsGateVerdict({ record: overridden, renderSha256: RENDER, trackId: "t1" });
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.notes.join(" ")).toContain("--allow-flash");
  });

  test("refuses an unsafe flash that passed without a recorded override", () => {
    const unrecorded = record({ flashSafety: { unsafe: true, verdict: "unsafe" } });
    const reason = refusal(
      metricsGateVerdict({ record: unrecorded, renderSha256: RENDER, trackId: "t1" }),
    );
    expect(reason).toContain("no --allow-flash override");
  });
});

describe("paletteGateVerdict", () => {
  const one = (bin: number): Float32Array => {
    const h = new Float32Array(8);
    h[bin] = 1;
    return h;
  };

  test("refuses a palette too close to a published neighbour", () => {
    const verdict = paletteGateVerdict(
      evaluatePaletteGate("poster.jpg", one(0), [{ hist: one(0), logId: "n0" }]),
    );
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toContain("judge:palette FAILED");
  });

  test("accepts a first render with no neighbour to compare against", () => {
    const verdict = paletteGateVerdict(evaluatePaletteGate("poster.jpg", one(0), []));
    expect(verdict.ok).toBe(true);
  });

  test("accepts a distinct palette", () => {
    const verdict = paletteGateVerdict(
      evaluatePaletteGate("poster.jpg", one(0), [{ hist: one(5), logId: "n0" }]),
    );
    expect(verdict.ok).toBe(true);
  });
});

describe("sha256File", () => {
  test("digests file bytes, so a re-render with different bytes reads as a different render", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ship-gates-"));
    try {
      const a = path.join(dir, "a.mp4");
      const b = path.join(dir, "b.mp4");
      writeFileSync(a, "render one");
      writeFileSync(b, "render two");
      expect(sha256File(a)).toBe(createHash("sha256").update("render one").digest("hex"));
      expect(sha256File(a)).not.toBe(sha256File(b));
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
