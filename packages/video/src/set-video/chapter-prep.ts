// Unit O · chapter prep — turn an archived per-track composition into a
// chapter-ready one for the hour-long set render.
//
// THE PROBLEM (proven by the 2026-07-03 de-risk spike on 012.2.4L): an archived
// composition re-drives correctly at chapter length INSIDE a <Sequence> — Remotion
// scopes `useVideoConfig().durationInFrames` to the sequence and `useCurrentFrame()`
// to its start, so everything driven off `useJourney()`/`u_progress`/the audio bus
// reflows for free. The ONE defect is ABSOLUTE-SECOND keyframes: a scene that eases
// its arc with `interpolate(sec, [0, 13, 20], …)` (sec = frame / fps) clamps at the
// authored 20 s — so in a 4-minute chapter the ramp hits 1 at 20 s and FREEZES for
// the rest (a permanent settle-dim + a spent one-shot climax over an otherwise-alive
// field). The fix is semi-mechanical: find each sec/frame-clock `interpolate(…)`,
// CLASSIFY it, and rescale/suppress it onto chapter length.
//
// This module is the transform (pure, tested), plus the R2 fetch + orchestration
// that writes chapter-ready comps into the gitignored set-workbench and a per-comp
// audit report (what was rescaled/suppressed, judgment flags where the classifier is
// unsure) for an agent/human to eyeball. It does NOT fork the video kit — the
// prepped comp still imports the exact same `../cosmos` surface and renders through
// the same ShaderLayer; only its clock keyframes change.
//
// Overlay policy (shared with 032-class comps that need no rescale): the parent set
// composition renders with `hideOverlay: true`, so every chapter's own TypePlate +
// CloseCard self-suppress (they read `getInputProps().hideOverlay`). The set draws
// the per-chapter Log-ID moment + the final F-coordinate CloseCard itself. So the
// transform leaves the type layer untouched and only strips <TrackAudio> (the set
// audio is muxed once, at the end, from the mastered set — never per chapter).

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type NostalgicCosmosProps } from "../remotion/types";

// The composition FPS (root.tsx / set-root.tsx both render at 30). A frame-domain
// clock keyframe is normalized against authoredDurationMs/1000 * FPS.
export const SET_FPS = 30;

const MEDIA_BASE = process.env.FLUNCLE_MEDIA_URL ?? "https://found.fluncle.com";

// ---------------------------------------------------------------------------
// Arithmetic evaluator (no eval): numbers with `_` separators, + - * /, parens,
// and identifiers resolved from a const map. Returns null when un-evaluable.
// ---------------------------------------------------------------------------

type ConstMap = Map<string, number>;

/** Tokenize + evaluate a small arithmetic expression against a const map. */
export function evalArithmetic(expr: string, consts: ConstMap): number | null {
  const src = expr.trim();
  if (src === "") {
    return null;
  }
  let pos = 0;

  const skipWs = (): void => {
    while (pos < src.length && /\s/.test(src[pos] ?? "")) {
      pos += 1;
    }
  };

  // Grammar: expr = term (('+'|'-') term)*; term = factor (('*'|'/') factor)*;
  // factor = number | ident | '(' expr ')' | ('+'|'-') factor.
  const parseExpr = (): number | null => {
    let left = parseTerm();
    if (left === null) {
      return null;
    }
    for (;;) {
      skipWs();
      const op = src[pos];
      if (op !== "+" && op !== "-") {
        break;
      }
      pos += 1;
      const right = parseTerm();
      if (right === null) {
        return null;
      }
      left = op === "+" ? left + right : left - right;
    }
    return left;
  };

  const parseTerm = (): number | null => {
    let left = parseFactor();
    if (left === null) {
      return null;
    }
    for (;;) {
      skipWs();
      const op = src[pos];
      if (op !== "*" && op !== "/") {
        break;
      }
      pos += 1;
      const right = parseFactor();
      if (right === null) {
        return null;
      }
      left = op === "*" ? left * right : left / right;
    }
    return left;
  };

  const parseFactor = (): number | null => {
    skipWs();
    const ch = src[pos];
    if (ch === "+" || ch === "-") {
      pos += 1;
      const inner = parseFactor();
      return inner === null ? null : ch === "-" ? -inner : inner;
    }
    if (ch === "(") {
      pos += 1;
      const inner = parseExpr();
      skipWs();
      if (src[pos] !== ")") {
        return null;
      }
      pos += 1;
      return inner;
    }
    // Number literal (with `_` digit separators + exponent).
    const numMatch = /^[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9]+)?/.exec(src.slice(pos));
    if (numMatch) {
      pos += numMatch[0].length;
      return Number(numMatch[0].replace(/_/g, ""));
    }
    const floatMatch = /^\.[0-9_]+(?:[eE][+-]?[0-9]+)?/.exec(src.slice(pos));
    if (floatMatch) {
      pos += floatMatch[0].length;
      return Number(floatMatch[0].replace(/_/g, ""));
    }
    // Identifier resolved from the const map.
    const idMatch = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(pos));
    if (idMatch) {
      pos += idMatch[0].length;
      const value = consts.get(idMatch[0]);
      return value === undefined ? null : value;
    }
    return null;
  };

  const result = parseExpr();
  skipWs();
  return pos === src.length ? result : null;
}

/** Top-level numeric `const NAME = <expr>;` declarations, evaluated in file order. */
export function parseConsts(source: string): ConstMap {
  const consts: ConstMap = new Map();
  const re = /(?:^|\n)\s*const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([^;\n]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const name = m[1];
    const value = evalArithmetic(m[2] ?? "", consts);
    if (name && value !== null && Number.isFinite(value)) {
      consts.set(name, value);
    }
  }
  return consts;
}

// ---------------------------------------------------------------------------
// Clock-var detection + interpolate() extraction
// ---------------------------------------------------------------------------

export type ClockVar = { name: string; domain: "sec" | "frame" };

/**
 * The clock variables an interpolate() input can be a function of. `sec` vars are
 * `frame / fps` (seconds domain); the raw `frame` from `useCurrentFrame()` is the
 * frames domain. Both are sequence-relative but authored against the CLIP length,
 * so both clamp at chapter length and need rescaling.
 */
export function findClockVars(source: string): ClockVar[] {
  const vars: ClockVar[] = [];
  // sec = frame / fps  (any identifier assigned frame/fps)
  const secRe = /const\s+([A-Za-z_$][\w$]*)\s*=\s*frame\s*\/\s*fps\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = secRe.exec(source))) {
    if (m[1]) {
      vars.push({ domain: "sec", name: m[1] });
    }
  }
  // frame = useCurrentFrame()  (the frames-domain clock)
  const frameRe = /const\s+([A-Za-z_$][\w$]*)\s*=\s*useCurrentFrame\s*\(\s*\)\s*;/g;
  while ((m = frameRe.exec(source))) {
    if (m[1]) {
      vars.push({ domain: "frame", name: m[1] });
    }
  }
  return vars;
}

export type CallArg = { text: string; start: number; end: number };
export type InterpolateCall = { callStart: number; callEnd: number; args: CallArg[] };

/**
 * Every `interpolate(...)` call in the source, with balanced-paren spans and the
 * absolute offsets of each top-level argument (so a rewrite can target one arg
 * without disturbing the rest). String/template/comment-agnostic bracket matching.
 */
export function extractInterpolateCalls(source: string): InterpolateCall[] {
  const calls: InterpolateCall[] = [];
  const needle = "interpolate";
  let i = 0;
  while ((i = source.indexOf(needle, i)) !== -1) {
    // Must be a call to the identifier `interpolate` (not `…interpolateColors`).
    const before = source[i - 1];
    const afterIdx = i + needle.length;
    if (before && /[\w$.]/.test(before)) {
      i = afterIdx;
      continue;
    }
    let j = afterIdx;
    while (j < source.length && /\s/.test(source[j] ?? "")) {
      j += 1;
    }
    if (source[j] !== "(") {
      i = afterIdx;
      continue;
    }
    const parsed = scanArgs(source, j);
    if (parsed) {
      calls.push({ args: parsed.args, callEnd: parsed.end, callStart: i });
      i = parsed.end;
    } else {
      i = afterIdx;
    }
  }
  return calls;
}

/** Scan a balanced `( … )` starting at `open`, splitting top-level `,` into args. */
function scanArgs(source: string, open: number): { args: CallArg[]; end: number } | null {
  let depth = 0;
  const args: CallArg[] = [];
  let argStart = open + 1;
  let stringCh: string | null = null;
  for (let k = open; k < source.length; k += 1) {
    const ch = source[k];
    const prev = source[k - 1];
    if (stringCh) {
      if (ch === stringCh && prev !== "\\") {
        stringCh = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      stringCh = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const text = source.slice(argStart, k);
        if (text.trim() !== "" || args.length > 0) {
          args.push({ end: k, start: argStart, text });
        }
        return { args, end: k + 1 };
      }
      continue;
    }
    if (ch === "," && depth === 1) {
      args.push({ end: k, start: argStart, text: source.slice(argStart, k) });
      argStart = k + 1;
    }
  }
  return null;
}

/** Parse a `[a, b, c]` array-literal arg into evaluated numbers (null when a member is non-numeric). */
export function parseNumericArray(text: string, consts: ConstMap): (number | null)[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return null;
  }
  const inner = trimmed.slice(1, -1);
  if (inner.trim() === "") {
    return [];
  }
  // Split on top-level commas (members may contain parens/other brackets).
  const members: string[] = [];
  let depth = 0;
  let start = 0;
  for (let k = 0; k < inner.length; k += 1) {
    const ch = inner[k];
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
    } else if (ch === "," && depth === 0) {
      members.push(inner.slice(start, k));
      start = k + 1;
    }
  }
  members.push(inner.slice(start));
  return members.map((mm) => evalArithmetic(mm, consts));
}

// ---------------------------------------------------------------------------
// Classification + the plan
// ---------------------------------------------------------------------------

export type DriverClass =
  | "whole-clip-ramp"
  | "tail-settle"
  | "tail-event"
  | "mid-event"
  | "unclassified";

export type DriverAction = "rescaled" | "suppressed" | "shifted" | "left";

export type DriverReport = {
  raw: string;
  clock: string;
  domain: "sec" | "frame";
  /** Input keyframes as fractions of the authored clip length (0..1+). */
  inputFractions: (number | null)[];
  outputs: (number | null)[];
  classification: DriverClass;
  action: DriverAction;
  flags: string[];
};

export type PrepReport = {
  logId: string;
  authoredDurationMs: number;
  chapterDurationMs: number;
  scale: number;
  isFinalChapter: boolean;
  clocks: ClockVar[];
  drivers: DriverReport[];
  strippedTrackAudio: boolean;
  overlayPolicy: string;
  notes: string[];
};

/** Round to a compact literal (drops trailing zeros; keeps determinism readable). */
const lit = (n: number): string => {
  const r = Number(n.toFixed(4));
  return String(r);
};

type Plan = {
  report: DriverReport;
  /** A source edit: replace [start,end) with `replacement`. Omitted = no rewrite. */
  edit?: { start: number; end: number; replacement: string };
};

/**
 * Classify one clock-driven interpolate() and plan its rewrite.
 *
 * authoredUnit / chapterUnit are in the clock's own domain (seconds for `sec`
 * clocks, frames for the `frame` clock). scale = chapterUnit / authoredUnit is
 * dimensionless and identical across domains.
 *
 * - whole-clip ramp (starts ~0, ends ~authored length): RESCALE the input
 *   keyframes by `scale` so the ease spans the whole chapter.
 * - tail settle/event (a short window pinned to the authored end, output dips):
 *   interior chapter → SUPPRESS (collapse to the pre-settle constant, so the
 *   field never dims mid-set); final chapter → SHIFT to the chapter's own tail.
 * - mid-event (an interior one-shot, e.g. a hard-timed climax): LEAVE — it is
 *   data; flag it so an agent can decide to drive it from the chapter drop.
 * - unclassified (non-numeric keyframes): LEAVE + flag.
 */
export function planDriver(
  call: InterpolateCall,
  clock: ClockVar,
  inputArg: CallArg,
  outputArg: CallArg | undefined,
  consts: ConstMap,
  ctx: { authoredUnit: number; chapterUnit: number; scale: number; isFinalChapter: boolean },
): Plan {
  const inputs = parseNumericArray(inputArg.text, consts);
  const outputs = outputArg ? (parseNumericArray(outputArg.text, consts) ?? []) : [];
  const flags: string[] = [];
  const fractions = (inputs ?? []).map((v) => (v === null ? null : v / ctx.authoredUnit));

  const base: DriverReport = {
    action: "left",
    classification: "unclassified",
    clock: clock.name,
    domain: clock.domain,
    flags,
    inputFractions: fractions,
    outputs,
    raw: `interpolate(${clock.name}, ${inputArg.text.trim()}${outputArg ? `, ${outputArg.text.trim()}` : ""})`,
  };

  if (!inputs || inputs.some((v) => v === null) || inputs.length < 2) {
    flags.push("non-numeric keyframes — left as-is; eyeball whether it clamps at chapter length");
    return { report: base };
  }
  const numericInputs = inputs.filter((v): v is number => v !== null);
  const first = numericInputs[0] ?? 0;
  const last = numericInputs[numericInputs.length - 1] ?? 0;
  const firstFrac = first / ctx.authoredUnit;
  const lastFrac = last / ctx.authoredUnit;

  const numericOut = outputs.filter((v): v is number => v !== null);
  const outFirst = numericOut[0] ?? 0;
  const outLast = numericOut[numericOut.length - 1] ?? 0;

  // Rewrite the input array with each member transformed by `fn` (member TEXT
  // preserved for provenance, wrapped so the arithmetic is explicit).
  const rewriteInputs = (fn: (memberText: string) => string): string => {
    const inner = inputArg.text.trim().slice(1, -1);
    const members: string[] = [];
    let depth = 0;
    let start = 0;
    for (let k = 0; k < inner.length; k += 1) {
      const ch = inner[k];
      if (ch === "(" || ch === "[" || ch === "{") {
        depth += 1;
      } else if (ch === ")" || ch === "]" || ch === "}") {
        depth -= 1;
      } else if (ch === "," && depth === 0) {
        members.push(inner.slice(start, k));
        start = k + 1;
      }
    }
    members.push(inner.slice(start));
    return `[${members.map((mm) => fn(mm.trim())).join(", ")}]`;
  };

  // whole-clip ramp: from the top, spanning most of the clip.
  if (firstFrac <= 0.25 && lastFrac >= 0.7) {
    base.classification = "whole-clip-ramp";
    base.action = "rescaled";
    const replacement = rewriteInputs((mm) => `(${mm}) * ${lit(ctx.scale)}`);
    return { edit: { end: inputArg.end, replacement, start: inputArg.start }, report: base };
  }

  // tail window: pinned near the authored end.
  if (firstFrac >= 0.55 && lastFrac >= 0.85) {
    const isSettle = outLast < outFirst;
    base.classification = isSettle ? "tail-settle" : "tail-event";
    if (ctx.isFinalChapter) {
      base.action = "shifted";
      const delta = ctx.chapterUnit - ctx.authoredUnit;
      const replacement = rewriteInputs((mm) => `(${mm}) + ${lit(delta)}`);
      flags.push("final chapter — shifted to the set's own tail so the piece resolves");
      return { edit: { end: inputArg.end, replacement, start: inputArg.start }, report: base };
    }
    // Interior chapter — collapse to the pre-settle constant (no mid-set dim).
    base.action = "suppressed";
    flags.push("interior chapter — suppressed the tail settle-dim (held at the pre-settle value)");
    return {
      edit: { end: call.callEnd, replacement: lit(outFirst), start: call.callStart },
      report: base,
    };
  }

  // interior one-shot — leave it; it fires once, early in the chapter.
  base.classification = "mid-event";
  base.action = "left";
  flags.push(
    `interior one-shot at ~${lit(firstFrac)}–${lit(lastFrac)} of the authored clip — left as data; it fires once near the chapter's head. Consider driving it from the chapter drop envelope if it should re-slam.`,
  );
  return { report: base };
}

// ---------------------------------------------------------------------------
// The transform
// ---------------------------------------------------------------------------

export type TransformInput = {
  logId: string;
  source: string;
  authoredDurationMs: number;
  chapterDurationMs: number;
  isFinalChapter: boolean;
};

export type TransformResult = { code: string; report: PrepReport };

/** Strip every `<TrackAudio … />` element (the set audio is muxed once, at the end). */
function stripTrackAudio(source: string): { code: string; stripped: boolean } {
  // Self-closing (the canonical form) and paired, non-greedy.
  const selfClosing = /\n?[ \t]*<TrackAudio\b[^>]*\/>/g;
  const paired = /\n?[ \t]*<TrackAudio\b[\s\S]*?<\/TrackAudio>/g;
  let stripped = false;
  let code = source.replace(selfClosing, () => {
    stripped = true;
    return "";
  });
  code = code.replace(paired, () => {
    stripped = true;
    return "";
  });
  return { code, stripped };
}

/**
 * Transform an archived composition into a chapter-ready one: rescale/suppress the
 * absolute-clock interpolate() drivers, strip <TrackAudio>, and report every
 * decision. Pure — no I/O — so it is fully unit-testable on fixture sources.
 */
export function transformChapterSource(input: TransformInput): TransformResult {
  const { logId, source, authoredDurationMs, chapterDurationMs, isFinalChapter } = input;
  const scale = chapterDurationMs / authoredDurationMs;
  const authoredSec = authoredDurationMs / 1000;
  const chapterSec = chapterDurationMs / 1000;
  const consts = parseConsts(source);
  const clocks = findClockVars(source);
  const clockByName = new Map(clocks.map((c) => [c.name, c] as const));

  const calls = extractInterpolateCalls(source);
  const plans: Plan[] = [];
  for (const call of calls) {
    const arg0 = call.args[0]?.text.trim() ?? "";
    // The clock is either a detected clock var or the raw `frame / fps` token.
    let clock = clockByName.get(arg0);
    if (!clock && /^frame\s*\/\s*fps$/.test(arg0)) {
      clock = { domain: "sec", name: "frame / fps" };
    }
    if (!clock) {
      continue; // duration-scoped input (progress/arc/an audio value) — reflows for free.
    }
    const input1 = call.args[1];
    if (!input1) {
      continue;
    }
    const authoredUnit = clock.domain === "frame" ? authoredSec * SET_FPS : authoredSec;
    const chapterUnit = clock.domain === "frame" ? chapterSec * SET_FPS : chapterSec;
    plans.push(
      planDriver(call, clock, input1, call.args[2], consts, {
        authoredUnit,
        chapterUnit,
        isFinalChapter,
        scale,
      }),
    );
  }

  // Apply edits descending so earlier offsets stay valid.
  const edits = plans.flatMap((p) => (p.edit ? [p.edit] : [])).sort((a, b) => b.start - a.start);
  let code = source;
  for (const edit of edits) {
    code = code.slice(0, edit.start) + edit.replacement + code.slice(edit.end);
  }

  const audioStrip = stripTrackAudio(code);
  code = audioStrip.code;

  const notes: string[] = [];
  if (/peakTimeMs\s*:/.test(source)) {
    notes.push(
      "This comp pins a drop peak (reactivity.drop.peakTimeMs). It fires ONCE, at that ms into the chapter; the field otherwise stays alive on the continuous energy/swell/bass envelopes. To let a long chapter re-slam, unpin peakTimeMs (falls back to the chapter's analyzed dropMs) or wire it to a dropCandidates entry.",
    );
  }
  if (plans.length === 0 && clocks.length === 0) {
    notes.push(
      "No absolute-clock drivers found (032-class): this comp reflows to chapter length for free; only the shared overlay policy applies.",
    );
  }

  return {
    code,
    report: {
      authoredDurationMs,
      chapterDurationMs,
      clocks,
      drivers: plans.map((p) => p.report),
      isFinalChapter,
      logId,
      notes,
      overlayPolicy:
        "set renders hideOverlay:true → the chapter's TypePlate + CloseCard self-suppress; the set draws the Log-ID moment + the F-coordinate close",
      scale: Number(scale.toFixed(4)),
      strippedTrackAudio: audioStrip.stripped,
    },
  };
}

// ---------------------------------------------------------------------------
// R2 fetch + orchestration
// ---------------------------------------------------------------------------

export type ArchivedChapter = {
  logId: string;
  source: string;
  props: NostalgicCosmosProps;
};

/** Fetch a finding's archived composition.tsx + props.json from the public R2 archive. */
export async function fetchArchivedChapter(logId: string): Promise<ArchivedChapter> {
  const base = `${MEDIA_BASE}/${encodeURIComponent(logId)}`;
  const [srcRes, propsRes] = await Promise.all([
    fetch(`${base}/composition.tsx`),
    fetch(`${base}/props.json`),
  ]);
  if (!srcRes.ok) {
    throw new Error(`chapter-prep: ${logId} composition.tsx → HTTP ${srcRes.status}`);
  }
  if (!propsRes.ok) {
    throw new Error(`chapter-prep: ${logId} props.json → HTTP ${propsRes.status}`);
  }
  const source = await srcRes.text();
  const props = (await propsRes.json()) as NostalgicCosmosProps;
  return { logId, props, source };
}

const SET_WORKBENCH = path.resolve(import.meta.dirname, "../remotion/set-workbench");

/**
 * Prep one chapter: fetch its archived comp + props, transform the source to
 * chapter length, write the chapter-ready comp into the set-workbench (keyed by
 * logId so the set composition can resolve it), and return the report + the
 * archived identity props (track/palette/seed — the finding's own look; the audio
 * is replaced by the freshly-analyzed chapter slice, see chapter-props.ts).
 */
export async function prepChapter(opts: {
  logId: string;
  chapterDurationMs: number;
  isFinalChapter: boolean;
}): Promise<{ report: PrepReport; archived: ArchivedChapter; authoredDurationMs: number }> {
  const archived = await fetchArchivedChapter(opts.logId);
  const authoredDurationMs = archived.props.audio.durationMs;
  const { code, report } = transformChapterSource({
    authoredDurationMs,
    chapterDurationMs: opts.chapterDurationMs,
    isFinalChapter: opts.isFinalChapter,
    logId: opts.logId,
    source: archived.source,
  });
  mkdirSync(SET_WORKBENCH, { recursive: true });
  // The set composition resolves chapter components by logId (the filename).
  writeFileSync(path.join(SET_WORKBENCH, `${opts.logId}.tsx`), code);
  return { archived, authoredDurationMs, report };
}

// Run directly to prep + audit a single chapter (fast eyeball of the transform):
//   bun src/set-video/chapter-prep.ts <logId> <chapterDurationMs> [--final]
if (import.meta.main) {
  const [, , logId, durMs, finalFlag] = process.argv;
  if (!logId || !durMs) {
    console.error("usage: chapter-prep <logId> <chapterDurationMs> [--final]");
    process.exit(1);
  }
  const { report } = await prepChapter({
    chapterDurationMs: Number(durMs),
    isFinalChapter: finalFlag === "--final",
    logId,
  });
  console.log(JSON.stringify(report, null, 2));
  console.error(
    `\n[chapter-prep] ${logId}: scale ${report.scale}×, ${report.drivers.length} clock driver(s) — ${report.drivers.map((d) => `${d.classification}:${d.action}`).join(", ") || "none"} → src/remotion/set-workbench/${logId}.tsx`,
  );
}
