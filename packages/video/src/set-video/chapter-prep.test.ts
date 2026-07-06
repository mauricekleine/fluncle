import { describe, expect, test } from "bun:test";

import {
  evalArithmetic,
  extractInterpolateCalls,
  findClockVars,
  parseConsts,
  parseNumericArray,
  transformChapterSource,
} from "./chapter-prep";

// A fixture modeled on the real 012.2.4L (caustic web): a whole-clip RAMP
// (`rise`), a TAIL SETTLE (`settle`), a pinned drop peak, a <TrackAudio>, and a
// TypePlate/CloseCard the overlay policy leaves untouched.
const RAMP_AND_SETTLE = `import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
const DROP_MS = 13_000;
const Comp = ({ audio }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sec = frame / fps;
  const rise = interpolate(sec, [0, DROP_MS / 1000, 20], [0, 0.5, 1], {
    extrapolateRight: "clamp",
  });
  const settle = interpolate(sec, [18.3, 20], [1, 0.66], { extrapolateRight: "clamp" });
  return (
    <ShaderLayer uniforms={{ u_rise: rise, u_settle: settle }} reactivity={{ drop: { peakTimeMs: DROP_MS } }} />
  );
};`;

// A "clean" 032-class comp: no absolute-clock drivers — drives only off the
// duration-scoped useJourney + the audio bus, so it needs no rescale.
const CLEAN_032 = `import { useJourney } from "../cosmos";
const Comp = ({ audio }) => {
  const { arc, progress } = useJourney();
  const bump = interpolate(progress, [0, 0.5, 1], [0, 1, 0]);
  return <ShaderLayer progress={arc} uniforms={{ u_bump: bump }} />;
};`;

describe("evalArithmetic", () => {
  test("numbers, separators, arithmetic, consts", () => {
    const consts = new Map([["DROP_MS", 13000]]);
    expect(evalArithmetic("13_000", consts)).toBe(13000);
    expect(evalArithmetic("DROP_MS / 1000", consts)).toBe(13);
    expect(evalArithmetic("(2 + 3) * 4", consts)).toBe(20);
    expect(evalArithmetic("-0.5", consts)).toBe(-0.5);
    expect(evalArithmetic(".25", consts)).toBe(0.25);
    expect(evalArithmetic("someVar", consts)).toBeNull();
    expect(evalArithmetic("2 +", consts)).toBeNull();
  });
});

describe("parseConsts", () => {
  test("collects numeric top-level consts", () => {
    const consts = parseConsts(RAMP_AND_SETTLE);
    expect(consts.get("DROP_MS")).toBe(13000);
  });
});

describe("findClockVars", () => {
  test("detects sec (frame/fps) and frame (useCurrentFrame) clocks", () => {
    const vars = findClockVars(RAMP_AND_SETTLE);
    expect(vars).toContainEqual({ domain: "sec", name: "sec" });
    expect(vars).toContainEqual({ domain: "frame", name: "frame" });
  });
});

describe("extractInterpolateCalls + parseNumericArray", () => {
  test("finds calls with balanced spans and parses input arrays", () => {
    const calls = extractInterpolateCalls(RAMP_AND_SETTLE);
    expect(calls.length).toBe(2);
    const consts = parseConsts(RAMP_AND_SETTLE);
    const first = calls[0];
    if (!first) {
      throw new Error("expected a call");
    }
    const inputs = parseNumericArray(first.args[1]?.text ?? "", consts);
    expect(inputs).toEqual([0, 13, 20]);
  });

  test("does not match interpolateColors or member calls", () => {
    const calls = extractInterpolateCalls("foo.interpolate(x, [0,1], [0,1]); interpolateColors(t)");
    expect(calls.length).toBe(0);
  });
});

describe("transformChapterSource", () => {
  const authoredDurationMs = 20_000;
  const chapterDurationMs = 148_200; // the real 012.2.4L chapter length in 019.F.1A

  test("interior chapter: rescales the ramp, suppresses the settle, strips TrackAudio", () => {
    const withAudio = RAMP_AND_SETTLE.replace(
      "<ShaderLayer",
      "<TrackAudio audio={audio} />\n    <ShaderLayer",
    );
    const { code, report } = transformChapterSource({
      authoredDurationMs,
      chapterDurationMs,
      isFinalChapter: false,
      logId: "012.2.4L",
      source: withAudio,
    });

    const ramp = report.drivers.find((d) => d.classification === "whole-clip-ramp");
    const settle = report.drivers.find((d) => d.classification === "tail-settle");
    expect(ramp?.action).toBe("rescaled");
    expect(settle?.action).toBe("suppressed");
    expect(report.scale).toBeCloseTo(7.41, 1);

    // The ramp keyframes are multiplied by the scale so the ease spans the chapter.
    expect(code).toContain("(0) * 7.41");
    expect(code).toContain("(20) * 7.41");
    // The settle collapses to its pre-settle constant (no mid-set dim).
    expect(code).toContain("const settle = 1;");
    expect(code).not.toContain("18.3");
    // TrackAudio is gone; the type layer (self-suppressing) is untouched.
    expect(code).not.toContain("TrackAudio");
    expect(report.strippedTrackAudio).toBe(true);
    // The pinned drop peak is surfaced as a judgment note.
    expect(report.notes.join(" ")).toContain("peakTimeMs");
  });

  test("final chapter: shifts the settle to the set's own tail", () => {
    const { code, report } = transformChapterSource({
      authoredDurationMs,
      chapterDurationMs,
      isFinalChapter: true,
      logId: "012.2.4L",
      source: RAMP_AND_SETTLE,
    });
    const settle = report.drivers.find((d) => d.classification === "tail-settle");
    expect(settle?.action).toBe("shifted");
    // delta = (148.2 - 20) = 128.2 s added to each settle keyframe.
    expect(code).toContain("(18.3) + 128.2");
    expect(code).toContain("(20) + 128.2");
  });

  test("clean 032-class comp: no rescale, only the overlay/free-reflow note", () => {
    const { code, report } = transformChapterSource({
      authoredDurationMs,
      chapterDurationMs,
      isFinalChapter: false,
      logId: "032.0.4L",
      source: CLEAN_032,
    });
    // interpolate(progress, …) is duration-scoped — left untouched.
    expect(code).toContain("interpolate(progress, [0, 0.5, 1], [0, 1, 0])");
    expect(report.drivers.length).toBe(0);
    expect(report.notes.join(" ")).toContain("032-class");
  });
});
