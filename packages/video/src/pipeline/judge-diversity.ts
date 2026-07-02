// The diversity metric — the automated counter to the package's founding law
// (divergence) and the DESIGN "Retint Rule": every new finding must look UNLIKE its
// neighbours, above all the one right before it. The failure mode this catches is
// LAUNDERING BY RECOLOR: reusing the previous primitive with a fresh palette. A
// naive colour-only distance is DEFEATED by exactly that (a recolor reads as very
// different colour), so the metric is STRUCTURE-dominant.
//
// Distance per neighbour combines three views, weighted so a recolor can't rescue a
// reused primitive:
//   - edgeOrientation (0.60) : a 9-bin Sobel edge-ORIENTATION histogram — the
//                              primitive's structural fingerprint, invariant under
//                              recolor. THE discriminator (calibration: a
//                              same-primitive recolored pair reads eo≈0.00; a
//                              genuinely distinct pair reads eo≈0.64).
//   - colorHistogram  (0.20) : HSV histogram Bhattacharyya — real palette diversity,
//                              a secondary signal that can't by itself pass a clone.
//   - lumaContrast    (0.20) : |Δmean| + |Δstd| of luminance (tonal/contrast feel).
//
// CALIBRATED ON REAL POSTERS (found.fluncle.com/<logId>/poster.jpg, 160×160, area):
//   027.5.4D vs 025.5.5T (same primitive recolored — must read LOW)  combined = 0.229
//   032.0.4L vs 032.0.6R (genuinely distinct — must read HIGH)       combined = 0.586
// DIVERSITY_MIN = 0.35 sits ~34% above the too-similar pair and ~40% below the
// distinct pair. Below it, the IMMEDIATE neighbour (the hard doctrine constraint) is
// "too similar"; `--strict` exits non-zero. Advisory by default (exit 0 + verdict).
//
// CLI: bun src/pipeline/judge-diversity.ts <posterPathOrLogId> [--neighbours N]
//      [--strict] [--json]

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { decodeImageRgb, type RgbImage } from "./frames";

const DECODE_SIZE = 160;
const DEFAULT_NEIGHBOURS = 4;
export const DIVERSITY_MIN = 0.35;

const HUE_BINS = 12;
const SAT_BINS = 4;
const VAL_BINS = 4;
const ORIENT_BINS = 9;
const EDGE_MAG_FLOOR = 0.05; // ignore near-flat pixels when building the orientation histogram

const W_EDGE = 0.6;
const W_COLOR = 0.2;
const W_LUMA = 0.2;

const FEED_URL = "https://www.fluncle.com/api/tracks";
const posterUrl = (logId: string): string => `https://found.fluncle.com/${logId}/poster.jpg`;

// ---------------------------------------------------------------------------
// Feature extraction (pure over a decoded RgbImage)
// ---------------------------------------------------------------------------

export type DiversityFeature = {
  colorHist: Float32Array;
  edgeOrient: Float32Array;
  lumaMean: number;
  lumaStd: number;
};

function toGray(img: RgbImage): Float32Array {
  const pix = img.width * img.height;
  const g = new Float32Array(pix);
  for (let p = 0; p < pix; p++) {
    g[p] =
      (0.299 * img.data[p * 3] + 0.587 * img.data[p * 3 + 1] + 0.114 * img.data[p * 3 + 2]) / 255;
  }
  return g;
}

function hsvHistogram(img: RgbImage): Float32Array {
  const pix = img.width * img.height;
  const hist = new Float32Array(HUE_BINS * SAT_BINS * VAL_BINS);
  for (let p = 0; p < pix; p++) {
    const r = img.data[p * 3] / 255;
    const g = img.data[p * 3 + 1] / 255;
    const b = img.data[p * 3 + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const c = max - min;
    let hue = 0;
    if (c > 1e-6) {
      if (max === r) {
        hue = ((g - b) / c) % 6;
      } else if (max === g) {
        hue = (b - r) / c + 2;
      } else {
        hue = (r - g) / c + 4;
      }
      hue /= 6;
      if (hue < 0) {
        hue += 1;
      }
    }
    const sat = max > 1e-6 ? c / max : 0;
    const hi = Math.min(HUE_BINS - 1, Math.floor(hue * HUE_BINS));
    const si = Math.min(SAT_BINS - 1, Math.floor(sat * SAT_BINS));
    const vi = Math.min(VAL_BINS - 1, Math.floor(max * VAL_BINS));
    hist[(hi * SAT_BINS + si) * VAL_BINS + vi] += 1;
  }
  for (let i = 0; i < hist.length; i++) {
    hist[i] /= pix;
  }
  return hist;
}

/** Magnitude-weighted Sobel edge-ORIENTATION histogram (0..π folded, ORIENT_BINS bins). */
function edgeOrientation(gray: Float32Array, width: number, height: number): Float32Array {
  const hist = new Float32Array(ORIENT_BINS);
  let total = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx =
        -gray[i - width - 1] -
        2 * gray[i - 1] -
        gray[i + width - 1] +
        gray[i - width + 1] +
        2 * gray[i + 1] +
        gray[i + width + 1];
      const gy =
        -gray[i - width - 1] -
        2 * gray[i - width] -
        gray[i - width + 1] +
        gray[i + width - 1] +
        2 * gray[i + width] +
        gray[i + width + 1];
      const mag = Math.hypot(gx, gy);
      if (mag < EDGE_MAG_FLOOR) {
        continue;
      }
      let a = Math.atan2(gy, gx);
      if (a < 0) {
        a += Math.PI; // fold to [0,π): orientation, not direction
      }
      const bin = Math.min(ORIENT_BINS - 1, Math.floor((a / Math.PI) * ORIENT_BINS));
      hist[bin] += mag;
      total += mag;
    }
  }
  if (total > 0) {
    for (let i = 0; i < ORIENT_BINS; i++) {
      hist[i] /= total;
    }
  }
  return hist;
}

export function featureOf(img: RgbImage): DiversityFeature {
  const gray = toGray(img);
  let mean = 0;
  for (let p = 0; p < gray.length; p++) {
    mean += gray[p];
  }
  mean /= gray.length;
  let variance = 0;
  for (let p = 0; p < gray.length; p++) {
    variance += (gray[p] - mean) ** 2;
  }
  variance /= gray.length;
  return {
    colorHist: hsvHistogram(img),
    edgeOrient: edgeOrientation(gray, img.width, img.height),
    lumaMean: mean,
    lumaStd: Math.sqrt(variance),
  };
}

function bhattacharyya(a: Float32Array, b: Float32Array): number {
  let bc = 0;
  for (let i = 0; i < a.length; i++) {
    bc += Math.sqrt(a[i] * b[i]);
  }
  return 1 - Math.min(1, bc);
}

export type DiversityDistance = {
  combined: number;
  edgeOrient: number;
  colorHist: number;
  lumaContrast: number;
};

/** Structure-dominant distance between two poster features (0 identical → ~1 distinct). */
export function diversityDistance(a: DiversityFeature, b: DiversityFeature): DiversityDistance {
  const edge = bhattacharyya(a.edgeOrient, b.edgeOrient);
  const color = bhattacharyya(a.colorHist, b.colorHist);
  const luma = Math.min(
    1,
    (Math.abs(a.lumaMean - b.lumaMean) + Math.abs(a.lumaStd - b.lumaStd)) * 2,
  );
  return {
    colorHist: color,
    combined: W_EDGE * edge + W_COLOR * color + W_LUMA * luma,
    edgeOrient: edge,
    lumaContrast: luma,
  };
}

// ---------------------------------------------------------------------------
// Fetching (public surfaces only)
// ---------------------------------------------------------------------------

type FeedTrack = { logId?: string | null; videoVehicle?: string | null };

/** The most-recent published findings that HAVE a video (videoVehicle set), newest first. */
export async function fetchRecentVideoLogIds(limit: number): Promise<string[]> {
  const res = await fetch(`${FEED_URL}?limit=${Math.max(limit * 3, 12)}`);
  if (!res.ok) {
    throw new Error(`feed fetch failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { tracks?: FeedTrack[] };
  const ids: string[] = [];
  for (const t of body.tracks ?? []) {
    if (t.videoVehicle && t.logId) {
      ids.push(t.logId);
    }
  }
  return ids.slice(0, limit);
}

/** Decode a poster given a local path or a logId (fetched from the public host). */
async function decodePoster(pathOrLogId: string, scratchDir: string): Promise<RgbImage> {
  const isLocal =
    pathOrLogId.endsWith(".jpg") || pathOrLogId.endsWith(".png") || existsSync(pathOrLogId);
  if (isLocal) {
    return decodeImageRgb(pathOrLogId, { height: DECODE_SIZE, width: DECODE_SIZE });
  }
  const url = posterUrl(pathOrLogId);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`poster fetch failed for ${pathOrLogId}: ${res.status} ${res.statusText}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const tmp = path.join(scratchDir, `${pathOrLogId.replace(/[^\w.-]/g, "_")}.jpg`);
  writeFileSync(tmp, bytes);
  return decodeImageRgb(tmp, { height: DECODE_SIZE, width: DECODE_SIZE });
}

export type DiversityReport = {
  subject: string;
  neighbours: { logId: string; immediate: boolean; distance: DiversityDistance }[];
  immediateDistance: number | null;
  threshold: number;
  pass: boolean;
  verdict: string;
};

/** Judge the subject poster against the recent published neighbours. */
export async function judgeDiversity(
  subject: string,
  opts: { neighbours?: number } = {},
): Promise<DiversityReport> {
  const wanted = opts.neighbours ?? DEFAULT_NEIGHBOURS;
  const scratchDir = mkdtempSync(path.join(tmpdir(), "fluncle-diversity-"));
  try {
    const subjectImg = await decodePoster(subject, scratchDir);
    const subjectFeat = featureOf(subjectImg);

    // Recent neighbours, excluding the subject itself if it is one of them.
    const subjectLogId = subject.endsWith(".jpg") || subject.endsWith(".png") ? null : subject;
    const recent = (await fetchRecentVideoLogIds(wanted + 1)).filter((id) => id !== subjectLogId);
    const neighbourIds = recent.slice(0, wanted);

    const neighbours: DiversityReport["neighbours"] = [];
    for (let i = 0; i < neighbourIds.length; i++) {
      const logId = neighbourIds[i];
      const feat = featureOf(await decodePoster(logId, scratchDir));
      neighbours.push({
        distance: diversityDistance(subjectFeat, feat),
        immediate: i === 0,
        logId,
      });
    }

    const immediateDistance = neighbours.length > 0 ? neighbours[0].distance.combined : null;
    const pass = immediateDistance === null || immediateDistance >= DIVERSITY_MIN;
    const verdict =
      immediateDistance === null
        ? "no published neighbour to compare against (pass)"
        : pass
          ? `distinct from the immediate neighbour (${immediateDistance.toFixed(3)} >= ${DIVERSITY_MIN})`
          : `TOO SIMILAR to the immediate neighbour ${neighbours[0].logId} (${immediateDistance.toFixed(3)} < ${DIVERSITY_MIN}) — likely the same primitive recolored`;

    return { immediateDistance, neighbours, pass, subject, threshold: DIVERSITY_MIN, verdict };
  } finally {
    rmSync(scratchDir, { force: true, recursive: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const strict = args.includes("--strict");
  const nFlag = args.indexOf("--neighbours");
  const neighbours = nFlag >= 0 ? Number(args[nFlag + 1]) : undefined;
  const subject = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--neighbours");

  if (!subject) {
    console.error(
      "usage: judge-diversity <posterPathOrLogId> [--neighbours N] [--strict] [--json]",
    );
    process.exit(2);
  }

  const report = await judgeDiversity(subject, { neighbours });
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `diversity of ${report.subject} vs the last ${report.neighbours.length} published:`,
    );
    for (const n of report.neighbours) {
      const d = n.distance;
      console.log(
        `  ${n.immediate ? "→" : " "} ${n.logId}: ${d.combined.toFixed(3)} (edge ${d.edgeOrient.toFixed(2)}, color ${d.colorHist.toFixed(2)}, luma ${d.lumaContrast.toFixed(2)})${n.immediate ? "  [immediate neighbour — hard constraint]" : ""}`,
      );
    }
    console.log(`${report.pass ? "✓" : "✗"} ${report.verdict}`);
  }
  // Advisory by default; --strict makes an immediate-neighbour clone a hard failure.
  process.exit(strict && !report.pass ? 1 : 0);
}
