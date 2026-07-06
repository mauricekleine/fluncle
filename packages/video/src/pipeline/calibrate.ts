// The calibration harness — makes the gates' thresholds RE-EARNABLE as operator
// verdicts accumulate. Reads the labeled corpus (calibration/verdicts.json), runs
// the relevant deterministic gate on each entry's PUBLIC artifacts, and prints a
// classification table: gate verdict vs operator verdict, flagging disagreements
// with a threshold-nudge suggestion. Thresholds are only trustworthy while they
// keep reproducing the labels; this is how you notice drift.
//
// Honesty about reach: the full metrics.json is NOT publicly served, so this cannot
// replay the whole report from the web — it recomputes locally from what IS public:
//   - poster.jpg (always) → the diversity poster-pair distance (offline, no footage).
//   - footage.social.mp4 (ONLY with --footage, since the files are large) → the arc
//     gate. Without --footage, arc rows are marked "skipped (needs --footage)".
//
// Usage:
//   bun src/pipeline/calibrate.ts            # poster-only (diversity rows)
//   bun src/pipeline/calibrate.ts --footage  # also downloads footage → arc rows
//   bun src/pipeline/calibrate.ts --json

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { GLSL } from "../remotion/journey/glsl";

import { scoreArc } from "./analyze-motion";
import { decodeImageRgb, extractRgbFrames } from "./frames";
import { diversityDistance, DIVERSITY_MIN, featureOf } from "./judge-diversity";
import { classifyCompositionStructure } from "./shader-structure";

const POSTER_SIZE = 160;
const posterUrl = (logId: string): string => `https://found.fluncle.com/${logId}/poster.jpg`;
const footageUrl = (logId: string): string =>
  `https://found.fluncle.com/${logId}/footage.social.mp4`;
const compositionUrl = (logId: string): string =>
  `https://found.fluncle.com/${logId}/composition.tsx`;
const glslSnippets = GLSL as unknown as Record<string, string>;

type Entry = {
  logId: string;
  // "arc" / "diversity" run a deterministic gate and are scored against the label.
  // "judge" is a documented coverage BOUNDARY: a failure no current deterministic
  // gate measures (aesthetic monotony, palette). We print any available signal for
  // transparency but do NOT score it or let it move the exit code.
  dimension: "arc" | "diversity" | "judge" | "structure";
  verdict: "pass" | "fail";
  pairedWith?: string;
  // For "structure" rows: the operator's labeled dominant shader family. The gate
  // fetches the composition, classifies it OFFLINE, and agrees when the classified
  // dominant matches this label — scoring the CLASSIFIER against the ground truth.
  structure?: string;
  notes?: string;
};
type Corpus = { schema: string; note?: string; entries: Entry[] };

type Row = {
  logId: string;
  dimension: string;
  operator: "pass" | "fail";
  gate: "pass" | "fail" | "skipped" | "advisory";
  score: number | null;
  threshold: number | null;
  agree: boolean | null;
  suggestion: string;
};

const CORPUS_PATH = path.resolve(import.meta.dirname, "..", "..", "calibration", "verdicts.json");

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url} → ${res.status} ${res.statusText}`);
  }
  writeFileSync(dest, new Uint8Array(await res.arrayBuffer()));
}

async function posterFeature(logId: string, scratch: string) {
  const dest = path.join(scratch, `${logId}.jpg`);
  await download(posterUrl(logId), dest);
  return featureOf(decodeImageRgb(dest, { height: POSTER_SIZE, width: POSTER_SIZE }));
}

/** Suggest a threshold nudge when the gate disagrees with the operator. */
function suggest(
  dimension: string,
  operator: "pass" | "fail",
  score: number,
  threshold: number,
): string {
  if (dimension === "arc") {
    // higher score = more alive. gate passes when score >= floor.
    if (operator === "fail") {
      return `operator FAIL but score ${score.toFixed(3)} >= floor ${threshold} → raise ARC_FLOOR above ${score.toFixed(3)}`;
    }
    return `operator PASS but score ${score.toFixed(3)} < floor ${threshold} → lower ARC_FLOOR below ${score.toFixed(3)}`;
  }
  // diversity: higher score = more distinct. "fail" = too similar → gate should read below min.
  if (operator === "fail") {
    return `operator FAIL (too similar) but distance ${score.toFixed(3)} >= min ${threshold} → raise DIVERSITY_MIN above ${score.toFixed(3)}`;
  }
  return `operator PASS (distinct) but distance ${score.toFixed(3)} < min ${threshold} → lower DIVERSITY_MIN below ${score.toFixed(3)}`;
}

async function classify(entry: Entry, scratch: string, withFootage: boolean): Promise<Row> {
  const base: Row = {
    agree: null,
    dimension: entry.dimension,
    gate: "skipped",
    logId: entry.logId,
    operator: entry.verdict,
    score: null,
    suggestion: "",
    threshold: null,
  };

  if (entry.dimension === "diversity") {
    if (!entry.pairedWith) {
      return { ...base, suggestion: "diversity entry missing pairedWith" };
    }
    const a = await posterFeature(entry.logId, scratch);
    const b = await posterFeature(entry.pairedWith, scratch);
    const d = diversityDistance(a, b).combined;
    // predicted fail = too similar (below min); pass = distinct (>= min).
    const gate: "pass" | "fail" = d >= DIVERSITY_MIN ? "pass" : "fail";
    const agree = gate === entry.verdict;
    return {
      ...base,
      agree,
      gate,
      score: d,
      suggestion: agree ? "" : suggest("diversity", entry.verdict, d, DIVERSITY_MIN),
      threshold: DIVERSITY_MIN,
    };
  }

  if (entry.dimension === "structure") {
    // Offline + footage-free: fetch the composition source, classify the RESOLVED
    // shader body, and check the classified dominant against the operator's labeled
    // family. This scores the CLASSIFIER (does it read the body the way the operator
    // does?), independent of poster/footage.
    const res = await fetch(compositionUrl(entry.logId));
    if (!res.ok) {
      return { ...base, suggestion: `composition fetch failed: ${res.status} ${res.statusText}` };
    }
    const classified = classifyCompositionStructure(await res.text(), glslSnippets);
    if (!classified) {
      return { ...base, suggestion: "composition body could not be located/resolved" };
    }
    const agree = entry.structure ? classified.dominant === entry.structure : null;
    return {
      ...base,
      agree,
      gate: agree === null ? "advisory" : agree ? "pass" : "fail",
      suggestion:
        entry.structure && !agree
          ? `classifier read '${classified.dominant}' but operator labeled '${entry.structure}' → check the classifier heuristics for this body`
          : `classified '${classified.dominant}'${classified.secondary ? ` (+${classified.secondary})` : ""} @ confidence ${classified.confidence}`,
    };
  }

  // arc + judge both read the footage; judge is reported for transparency only.
  if (!withFootage) {
    return { ...base, suggestion: "needs --footage (footage.social.mp4 not fetched)" };
  }
  const dest = path.join(scratch, `${entry.logId}.mp4`);
  await download(footageUrl(entry.logId), dest);
  const rgb = extractRgbFrames(dest, { height: 114, probeFps: true, width: 64 });
  const arc = scoreArc({ fps: rgb.fps, intent: null, rgb });

  if (entry.dimension === "judge") {
    // A documented coverage boundary — print the arc scores, do NOT score it.
    return {
      ...base,
      agree: null,
      gate: "advisory",
      score: arc.wholeClipChange,
      suggestion: `out of deterministic reach — arc reads ${arc.verdict} (whole ${arc.wholeClipChange.toFixed(3)}, best-window ${arc.bestWindowChange.toFixed(3)} vs region ${arc.regionFloor}); the operator FAIL is aesthetic (monotony/palette) → the LLM judge's call`,
      threshold: arc.floor,
    };
  }

  const gate: "pass" | "fail" = arc.dead ? "fail" : "pass";
  const agree = gate === entry.verdict;
  // The best-window read is the presence carve-out: report which read carried the
  // pass so a re-calibration can see whether it was whole-frame or a subregion.
  const via = arc.dead
    ? "dead on both reads"
    : arc.wholeClipChange >= arc.floor
      ? "whole-frame"
      : `subregion (best-window ${arc.bestWindowChange.toFixed(3)} >= ${arc.regionFloor})`;
  return {
    ...base,
    agree,
    gate,
    score: arc.wholeClipChange,
    suggestion: agree
      ? `${via}; best-window ${arc.bestWindowChange.toFixed(3)}`
      : suggest("arc", entry.verdict, arc.wholeClipChange, arc.floor),
    threshold: arc.floor,
  };
}

export async function calibrate(withFootage: boolean): Promise<Row[]> {
  const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as Corpus;
  const scratch = mkdtempSync(path.join(tmpdir(), "fluncle-calibrate-"));
  try {
    const rows: Row[] = [];
    for (const entry of corpus.entries) {
      try {
        rows.push(await classify(entry, scratch, withFootage));
      } catch (e) {
        rows.push({
          agree: null,
          dimension: entry.dimension,
          gate: "skipped",
          logId: entry.logId,
          operator: entry.verdict,
          score: null,
          suggestion: `error: ${e instanceof Error ? e.message : String(e)}`,
          threshold: null,
        });
      }
    }
    return rows;
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const withFootage = args.includes("--footage");
  const rows = await calibrate(withFootage);

  if (asJson) {
    console.log(JSON.stringify({ rows, withFootage }, null, 2));
  } else {
    console.log(
      `calibration — gate vs operator (${withFootage ? "poster + footage" : "poster only; pass --footage for arc rows"})\n`,
    );
    console.log("  logId       dim         operator  gate      score    agree");
    console.log("  ─────────── ─────────── ───────── ───────── ──────── ─────");
    for (const r of rows) {
      const score = r.score === null ? "   —   " : r.score.toFixed(3).padStart(7);
      const agree = r.agree === null ? " · " : r.agree ? " ✓ " : " ✗ ";
      console.log(
        `  ${r.logId.padEnd(11)} ${r.dimension.padEnd(11)} ${r.operator.padEnd(9)} ${r.gate.padEnd(9)} ${score}  ${agree}`,
      );
      if (r.suggestion) {
        console.log(`               ↳ ${r.suggestion}`);
      }
    }
    const scored = rows.filter((r) => r.agree !== null);
    const agreed = scored.filter((r) => r.agree).length;
    console.log(`\n  ${agreed}/${scored.length} scored rows agree with the operator labels.`);
    const skipped = rows.filter((r) => r.gate === "skipped");
    if (skipped.length > 0) {
      console.log(`  ${skipped.length} row(s) skipped (see notes above).`);
    }
  }
  // Non-zero only when a SCORED row disagrees (a real calibration drift), never for
  // skipped rows (a skipped row is a reach limitation, not a threshold failure).
  const disagreed = rows.some((r) => r.agree === false);
  process.exit(disagreed ? 1 : 0);
}
