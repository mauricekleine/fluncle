// The PALETTE gate — the axis judge-diversity is deliberately blind to. The diversity
// metric is STRUCTURE-dominant (edge 0.60, colour 0.20) by design, so a shared-palette
// pair passes it whenever the two primitives differ (docs/planning/homogenisation-
// evidence.md, 07-13: four consecutive amber/halftone renders, all structurally
// distinct-enough to clear the poster gate). This gate closes exactly that hole: it
// compares ONLY the fresh poster's HSV colour histogram against the last three published
// posters and FAILS when the palette is too close to ANY of them — the same
// laundering-by-recolor law the diversity metric enforces, run the other way round.
//
// It reuses judge-diversity's histogram (`featureOf(...).colorHist`, a 12×4×4 HSV
// histogram) and its Bhattacharyya distance — no duplicated colour code. The pure
// decision (`evaluatePaletteGate`) takes histograms and a threshold, so it is fully
// tested without fs or network; the CLI wraps it with poster decoding.
//
// CLI: bun src/pipeline/judge-palette.ts <posterPathOrLogId> [--neighbours N]
//      [--threshold T] [--json]  (exits non-zero on FAIL — it is a hard ship gate.)

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { decodeImageRgb } from "./frames";
import { bhattacharyya, featureOf, fetchRecentVideoLogIds } from "./judge-diversity";

const DECODE_SIZE = 160;
const DEFAULT_NEIGHBOURS = 3;

// The FAIL floor: the palette must sit at least this far (12×4×4 HSV Bhattacharyya) from
// EVERY one of the last three posters. This gate is a NEAR-DUPLICATE BACKSTOP, and the
// threshold is set from measured reality, not aspiration. Measured 2026-07-18 on real
// posters (found.fluncle.com/<logId>/poster.jpg, 160²):
//   - the 07-13 amber-strip "twins" the operator flagged by eye read 0.358–0.929 apart
//     on this histogram (the halftone texture + background move the fine bins a lot even
//     when a human reads "same amber");
//   - a DELIBERATE recolor (same primitive, new palette — the GOOD outcome) reads 0.359;
//   - live consecutive neighbours read ≥ 0.51 (min over 28 pairs).
// So the histogram CANNOT cleanly separate an amber twin (0.358, bad) from a recolor
// (0.359, good) — they overlap. Setting the floor to catch 0.36 would false-fail
// legitimate recolors and block ships in an unattended pipeline. The honest role of this
// gate is therefore to catch a TRUE near-duplicate palette (distance → ~0), and the AMBER
// BASIN (structurally varied but one warm cast) is the axis assigner's job — it steers the
// next render off the worn COARSE hue bucket (palette-summary.ts) proactively. 0.18 sits
// at half the legitimate-recolor floor: no observed legit pair fails, an exact palette
// clone does. Tune up only with fresh measurement; raising it toward 0.36 re-introduces
// the false-fail overlap. See the PR's calibration note.
export const PALETTE_MIN = 0.18;

const posterUrl = (logId: string): string => `https://found.fluncle.com/${logId}/poster.jpg`;

export type PaletteGateStatus = "pass" | "fail" | "skipped";

export type PaletteNeighbourDistance = {
  logId: string;
  immediate: boolean;
  distance: number;
};

export type PaletteGate = {
  subject: string;
  threshold: number;
  neighbours: PaletteNeighbourDistance[];
  /** The SMALLEST distance to any neighbour — the one that decides the gate. Null when
   *  there is no neighbour to compare against. */
  nearestDistance: number | null;
  /** Index (0 = immediate) of the nearest (most-similar) neighbour, or null. */
  nearestAt: number | null;
  status: PaletteGateStatus;
  pass: boolean;
  verdict: string;
};

/**
 * The PURE palette decision: given the subject's colour histogram and the ordered
 * (newest-first) neighbour histograms, FAIL when the closest neighbour sits under the
 * threshold, else pass. No neighbours → skipped (pass): a first render has nothing to
 * clash with. No fs, no network — this is the tested core.
 */
export function evaluatePaletteGate(
  subject: string,
  subjectHist: Float32Array,
  neighbourHists: { logId: string; hist: Float32Array }[],
  threshold: number = PALETTE_MIN,
): PaletteGate {
  if (neighbourHists.length === 0) {
    return {
      nearestAt: null,
      nearestDistance: null,
      neighbours: [],
      pass: true,
      status: "skipped",
      subject,
      threshold,
      verdict: "no published neighbour to compare against (pass)",
    };
  }

  const neighbours: PaletteNeighbourDistance[] = neighbourHists.map((n, i) => ({
    distance: bhattacharyya(subjectHist, n.hist),
    immediate: i === 0,
    logId: n.logId,
  }));

  let nearestAt = 0;
  for (let i = 1; i < neighbours.length; i++) {
    if (neighbours[i].distance < neighbours[nearestAt].distance) {
      nearestAt = i;
    }
  }
  const nearestDistance = neighbours[nearestAt].distance;
  const pass = nearestDistance >= threshold;
  const nearest = neighbours[nearestAt];

  return {
    nearestAt,
    nearestDistance,
    neighbours,
    pass,
    status: pass ? "pass" : "fail",
    subject,
    threshold,
    verdict: pass
      ? `palette is distinct from the last ${neighbours.length} (nearest ${nearest.logId}: ${nearestDistance.toFixed(3)} >= ${threshold})`
      : `palette TOO CLOSE to ${nearest.logId} (${nearestDistance.toFixed(3)} < ${threshold}) — the same palette recolored at most; swing the hue`,
  };
}

/** Decode a poster given a local path or a logId (fetched from the public host). */
function decodePoster(pathOrLogId: string, scratchDir: string): Float32Array {
  const isLocal =
    pathOrLogId.endsWith(".jpg") || pathOrLogId.endsWith(".png") || existsSync(pathOrLogId);
  if (isLocal) {
    return featureOf(decodeImageRgb(pathOrLogId, { height: DECODE_SIZE, width: DECODE_SIZE }))
      .colorHist;
  }
  // Resolved synchronously by the caller after fetching bytes to a temp file.
  const tmp = path.join(scratchDir, `${pathOrLogId.replace(/[^\w.-]/g, "_")}.jpg`);
  return featureOf(decodeImageRgb(tmp, { height: DECODE_SIZE, width: DECODE_SIZE })).colorHist;
}

async function fetchPosterTo(logId: string, scratchDir: string): Promise<void> {
  const res = await fetch(posterUrl(logId));
  if (!res.ok) {
    throw new Error(`poster fetch failed for ${logId}: ${res.status} ${res.statusText}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  writeFileSync(path.join(scratchDir, `${logId.replace(/[^\w.-]/g, "_")}.jpg`), bytes);
}

/** Judge the subject poster's palette against the recent published neighbours. */
export async function judgePalette(
  subject: string,
  opts: { neighbours?: number; threshold?: number } = {},
): Promise<PaletteGate> {
  const wanted = opts.neighbours ?? DEFAULT_NEIGHBOURS;
  const threshold = opts.threshold ?? PALETTE_MIN;
  const scratchDir = mkdtempSync(path.join(tmpdir(), "fluncle-palette-"));
  try {
    const subjectLogId = subject.endsWith(".jpg") || subject.endsWith(".png") ? null : subject;
    if (subjectLogId && !existsSync(subject)) {
      await fetchPosterTo(subjectLogId, scratchDir);
    }
    const subjectHist = decodePoster(subject, scratchDir);

    const ids = (await fetchRecentVideoLogIds(wanted + 1))
      .filter((id) => id !== subjectLogId)
      .slice(0, wanted);

    const neighbourHists: { logId: string; hist: Float32Array }[] = [];
    for (const id of ids) {
      await fetchPosterTo(id, scratchDir);
      neighbourHists.push({ hist: decodePoster(id, scratchDir), logId: id });
    }

    return evaluatePaletteGate(subject, subjectHist, neighbourHists, threshold);
  } finally {
    rmSync(scratchDir, { force: true, recursive: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const flagValue = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const neighboursRaw = flagValue("--neighbours");
  const neighbours = neighboursRaw !== undefined ? Number(neighboursRaw) : undefined;
  const thresholdRaw = flagValue("--threshold");
  const threshold = thresholdRaw !== undefined ? Number(thresholdRaw) : undefined;
  const valueFlags = new Set(["--neighbours", "--threshold"]);
  const subject = args.find((a, i) => !a.startsWith("--") && !valueFlags.has(args[i - 1] ?? ""));

  if (!subject) {
    console.error(
      "usage: judge-palette <posterPathOrLogId> [--neighbours N] [--threshold T] [--json]",
    );
    process.exit(2);
  }

  const gate = await judgePalette(subject, { neighbours, threshold });
  if (asJson) {
    console.log(JSON.stringify(gate, null, 2));
  } else {
    console.log(`palette of ${gate.subject} vs the last ${gate.neighbours.length} published:`);
    for (const n of gate.neighbours) {
      const mark =
        gate.nearestAt !== null && gate.neighbours[gate.nearestAt] === n ? "←nearest" : "";
      console.log(
        `    ${n.immediate ? "→" : " "} ${n.logId}: ${n.distance.toFixed(3)} ${mark}`.trimEnd(),
      );
    }
    console.log(`${gate.pass ? "✓" : "✗"} ${gate.verdict}`);
  }
  // A hard gate: a FAIL exits non-zero so the render prompt's gate list blocks the ship.
  process.exit(gate.status === "fail" ? 1 : 0);
}
