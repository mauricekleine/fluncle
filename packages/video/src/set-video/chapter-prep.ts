import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type NostalgicCosmosProps } from "../remotion/types";

export const SET_FPS = 30;

const MEDIA_BASE = process.env.FLUNCLE_MEDIA_URL ?? "https://found.fluncle.com";

type ConstMap = Map<string, number>;

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

export type ClockVar = { name: string; domain: "sec" | "frame" };

export function findClockVars(source: string): ClockVar[] {
  const vars: ClockVar[] = [];

  const secRe = /const\s+([A-Za-z_$][\w$]*)\s*=\s*frame\s*\/\s*fps\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = secRe.exec(source))) {
    if (m[1]) {
      vars.push({ domain: "sec", name: m[1] });
    }
  }

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

export function extractInterpolateCalls(source: string): InterpolateCall[] {
  const calls: InterpolateCall[] = [];
  const needle = "interpolate";
  let i = 0;
  while ((i = source.indexOf(needle, i)) !== -1) {
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

export function parseNumericArray(text: string, consts: ConstMap): (number | null)[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return null;
  }
  const inner = trimmed.slice(1, -1);
  if (inner.trim() === "") {
    return [];
  }

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

const lit = (n: number): string => {
  const r = Number(n.toFixed(4));
  return String(r);
};

type Plan = {
  report: DriverReport;

  edit?: { start: number; end: number; replacement: string };
};

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

  if (firstFrac <= 0.25 && lastFrac >= 0.7) {
    base.classification = "whole-clip-ramp";
    base.action = "rescaled";
    const replacement = rewriteInputs((mm) => `(${mm}) * ${lit(ctx.scale)}`);
    return { edit: { end: inputArg.end, replacement, start: inputArg.start }, report: base };
  }

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

    base.action = "suppressed";
    flags.push("interior chapter — suppressed the tail settle-dim (held at the pre-settle value)");
    return {
      edit: { end: call.callEnd, replacement: lit(outFirst), start: call.callStart },
      report: base,
    };
  }

  base.classification = "mid-event";
  base.action = "left";
  flags.push(
    `interior one-shot at ~${lit(firstFrac)}–${lit(lastFrac)} of the authored clip — left as data; it fires once near the chapter's head. Consider driving it from the chapter drop envelope if it should re-slam.`,
  );
  return { report: base };
}

export type TransformInput = {
  logId: string;
  source: string;
  authoredDurationMs: number;
  chapterDurationMs: number;
  isFinalChapter: boolean;
};

export type TransformResult = { code: string; report: PrepReport };

function stripTrackAudio(source: string): { code: string; stripped: boolean } {
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

    let clock = clockByName.get(arg0);
    if (!clock && /^frame\s*\/\s*fps$/.test(arg0)) {
      clock = { domain: "sec", name: "frame / fps" };
    }
    if (!clock) {
      continue;
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

export type ArchivedChapter = {
  logId: string;
  source: string;
  props: NostalgicCosmosProps;
};

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

  writeFileSync(path.join(SET_WORKBENCH, `${opts.logId}.tsx`), code);
  return { archived, authoredDurationMs, report };
}

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
