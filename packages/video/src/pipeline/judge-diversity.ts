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

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { GLSL } from "../remotion/journey/glsl";

import { decodeImageRgb, type RgbImage } from "./frames";
import {
  classifyCompositionStructure,
  labelWithStructure,
  type StructureFamily,
  STRUCTURE_FAMILIES,
} from "./shader-structure";

const DECODE_SIZE = 160;
const DEFAULT_NEIGHBOURS = 4;
export const DIVERSITY_MIN = 0.35;

// The structural axis: the SAME dominant family within this many shipped findings is a
// hard repeat (FAIL); within the wider window it is a soft rhyme (WARN). Distance-
// weighted exactly like the poster gate — the immediate neighbours are the hard
// constraint, a rhyme further back is tolerated.
const STRUCTURE_FAIL_WINDOW = 4;
const STRUCTURE_WARN_WINDOW = 8;
const DEFAULT_STRUCTURE_NEIGHBOURS = STRUCTURE_WARN_WINDOW;

// The plate-lane subject-kind axis: a plate render records its subject KIND
// (hull / ruin / flora / creature / terrain / threshold …) in render.json as
// `plateSubject`. Structural fingerprints can't see the subject (every plate comp
// classifies by its treatment family's marks), so subject rotation gets its own
// window: the SAME kind within this many shipped findings is a WARN — never a
// fail (the axis is advisory; the poster distance still carries the verdict).
const PLATE_SUBJECT_WARN_WINDOW = 4;

const OUT_DIR = path.resolve(import.meta.dirname, "../../out");
const glslSnippets = GLSL as unknown as Record<string, string>;
const compositionUrl = (logId: string): string =>
  `https://found.fluncle.com/${logId}/composition.tsx`;
const renderJsonUrl = (logId: string): string => `https://found.fluncle.com/${logId}/render.json`;

const HUE_BINS = 12;
const SAT_BINS = 4;
const VAL_BINS = 4;
const ORIENT_BINS = 9;
const EDGE_MAG_FLOOR = 0.05; // ignore near-flat pixels when building the orientation histogram

const W_EDGE = 0.6;
const W_COLOR = 0.2;
const W_LUMA = 0.2;

const FEED_URL = "https://www.fluncle.com/api/v1/findings";
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

export function bhattacharyya(a: Float32Array, b: Float32Array): number {
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

type FeedTrack = {
  logId?: string | null;
  videoVehicle?: string | null;
  videoStructure?: string | null;
};

/** A recent published finding that has a video: its coordinate + poetic vehicle name +
 *  the structural family recorded in the feed (when the feed already carries it). */
export type LedgerEntry = {
  logId: string;
  vehicle: string | null;
  /** The structure family from the feed, if it exposes one yet; else null (classify on the fly). */
  feedStructure: StructureFamily | null;
};

function asFamily(value: unknown): StructureFamily | null {
  return typeof value === "string" && (STRUCTURE_FAMILIES as readonly string[]).includes(value)
    ? (value as StructureFamily)
    : null;
}

/** The most-recent published findings that HAVE a video (videoVehicle set), newest first. */
export async function fetchRecentLedger(limit: number): Promise<LedgerEntry[]> {
  const res = await fetch(`${FEED_URL}?limit=${Math.max(limit * 3, 12)}`);
  if (!res.ok) {
    throw new Error(`feed fetch failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { tracks?: FeedTrack[] };
  const entries: LedgerEntry[] = [];
  for (const t of body.tracks ?? []) {
    if (t.videoVehicle && t.logId) {
      entries.push({
        feedStructure: asFamily(t.videoStructure),
        logId: t.logId,
        vehicle: t.videoVehicle,
      });
    }
  }
  return entries.slice(0, limit);
}

/** Back-compat: just the logIds (the poster gate only needs coordinates). */
export async function fetchRecentVideoLogIds(limit: number): Promise<string[]> {
  return (await fetchRecentLedger(limit)).map((e) => e.logId);
}

// ---------------------------------------------------------------------------
// The structural axis — classify the shader body, not the vehicle NAME
// ---------------------------------------------------------------------------

/** Read a composition source for a logId: the local bundle first, then the public host.
 *  Returns null (never throws) when neither is reachable. */
async function loadCompositionSource(logId: string): Promise<string | null> {
  const local = path.join(OUT_DIR, logId, "composition.tsx");
  if (existsSync(local)) {
    try {
      return readFileSync(local, "utf8");
    } catch {
      // fall through to the network copy
    }
  }
  try {
    const res = await fetch(compositionUrl(logId));
    if (!res.ok) {
      return null;
    }
    return await res.text();
  } catch {
    return null;
  }
}

/** The structural family for a logId, resolved best-effort: the local render.json's
 *  recorded structure first (no re-classify), then a fresh classification of the
 *  composition source (local or fetched). Null when nothing is reachable. */
export async function structureOfLogId(logId: string): Promise<StructureFamily | null> {
  const manifest = path.join(OUT_DIR, logId, "render.json");
  if (existsSync(manifest)) {
    try {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
        structure?: { dominant?: string } | null;
      };
      const recorded = asFamily(parsed.structure?.dominant);
      if (recorded) {
        return recorded;
      }
    } catch {
      // fall through to classify
    }
  }
  const source = await loadCompositionSource(logId);
  if (!source) {
    return null;
  }
  return classifyCompositionStructure(source, glslSnippets)?.dominant ?? null;
}

function asPlateSubject(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

/** The plate-lane subject KIND recorded for a logId's render — the local bundle's
 *  render.json first, then the public copy (render.json ships in every bundle, so
 *  neighbours resolve over the network the way compositions do). Null when the
 *  render was plate-less or nothing is reachable. */
export async function plateSubjectOfLogId(logId: string): Promise<string | null> {
  const manifest = path.join(OUT_DIR, logId, "render.json");
  if (existsSync(manifest)) {
    try {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { plateSubject?: unknown };
      return asPlateSubject(parsed.plateSubject);
    } catch {
      // fall through to the network copy
    }
  }
  try {
    const res = await fetch(renderJsonUrl(logId));
    if (!res.ok) {
      return null;
    }
    const parsed = (await res.json()) as { plateSubject?: unknown };
    return asPlateSubject(parsed.plateSubject);
  } catch {
    return null;
  }
}

/** A recent neighbour with its resolved structural family (null when unresolved). */
export type StructureNeighbour = {
  logId: string;
  vehicle: string | null;
  family: StructureFamily | null;
};

export type StructureGateStatus = "pass" | "warn" | "fail" | "skipped";

export type StructureGate = {
  /** The subject's dominant structural family, or null when it couldn't be resolved. */
  subject: StructureFamily | null;
  neighbours: StructureNeighbour[];
  /** Index (0 = immediate) of the nearest neighbour sharing the subject's family, or null. */
  repeatAt: number | null;
  status: StructureGateStatus;
  verdict: string;
};

/** Ordinal helper: 1 → "1 finding ago", n → "n findings ago". */
function findingsAgo(index: number): string {
  const n = index + 1;
  return `${n} finding${n === 1 ? "" : "s"} ago`;
}

/**
 * The PURE structural-gate decision: given the subject's family and the ordered
 * (newest-first) neighbour families, decide pass / warn / fail. A repeat inside the
 * FAIL window (the immediate neighbours) is a hard fail; inside the wider WARN window
 * a soft rhyme; beyond it, clear. A null subject family skips the gate (never fails a
 * ship because a body couldn't be classified). No fs, no network — heavily tested.
 *
 * The feed is now ALL-REPRESENTATIONAL (operator ruling 2026-07-20; see
 * docs/agents/hermes/scripts/assign-video-axes.ts): representational is a PREREQUISITE,
 * not one register among several. So the gate polices structural-family sameness WITHIN
 * representational — a same-family repeat inside the FAIL window is a hard FAIL regardless
 * of register. The earlier representational→WARN demotion existed only because
 * representational was rare (so presence pairs wouldn't be punished); under the
 * all-representational feed EVERY consecutive pair would qualify, defanging the gate
 * entirely, so it is gone. The SUBJECT-kind axis the structural fingerprint can't see
 * (a ship vs a ruin vs a creature all classify the same `metaball`/`other`) is policed by
 * evaluatePlateSubjectGate, which stays WARN-only as the softer second layer.
 */
export function evaluateStructureGate(
  subject: StructureFamily | null,
  neighbours: StructureNeighbour[],
): StructureGate {
  if (!subject) {
    return {
      neighbours,
      repeatAt: null,
      status: "skipped",
      subject,
      verdict: "structure unresolved — structural axis skipped (pass)",
    };
  }
  const repeatAt = neighbours.findIndex((n) => n.family === subject);
  if (repeatAt < 0) {
    return {
      neighbours,
      repeatAt: null,
      status: "pass",
      subject,
      verdict: `${subject} is absent from the last ${neighbours.length} findings — a fresh structural family`,
    };
  }
  const neighbour = neighbours[repeatAt];
  const label = labelWithStructure(neighbour.vehicle, neighbour.family);
  if (repeatAt < STRUCTURE_FAIL_WINDOW) {
    return {
      neighbours,
      repeatAt,
      status: "fail",
      subject,
      verdict: `${subject} shipped ${findingsAgo(repeatAt)} as ${label} — pick a different structural family (the recent window is saturated)`,
    };
  }
  if (repeatAt < STRUCTURE_WARN_WINDOW) {
    return {
      neighbours,
      repeatAt,
      status: "warn",
      subject,
      verdict: `${subject} last shipped ${findingsAgo(repeatAt)} as ${label} — a rhyme, but outside the hard window; a distinct family is safer`,
    };
  }
  return {
    neighbours,
    repeatAt,
    status: "pass",
    subject,
    verdict: `${subject} last shipped ${findingsAgo(repeatAt)} — clear of the recent window`,
  };
}

/** A recent neighbour with its recorded plate subject (null = plate-less/unresolved). */
export type PlateSubjectNeighbour = {
  logId: string;
  plateSubject: string | null;
};

export type PlateSubjectGateStatus = "pass" | "warn" | "skipped";

export type PlateSubjectGate = {
  /** The subject render's plate subject kind, or null (plate-less → skipped). */
  subject: string | null;
  neighbours: PlateSubjectNeighbour[];
  /** Index (0 = immediate) of the nearest neighbour sharing the kind, or null. */
  repeatAt: number | null;
  status: PlateSubjectGateStatus;
  verdict: string;
};

/**
 * The PURE plate-subject decision: WARN when the same subject KIND shipped inside
 * the recent window, else pass; a plate-less render (null subject) skips. Advisory
 * by design — never a fail: the structural gate already demotes representational
 * repeats to WARN because the fingerprint can't see the subject, and this axis is
 * exactly the subject-kind rotation that demotion defers to. No fs, no network.
 */
export function evaluatePlateSubjectGate(
  subject: string | null,
  neighbours: PlateSubjectNeighbour[],
): PlateSubjectGate {
  if (!subject) {
    return {
      neighbours,
      repeatAt: null,
      status: "skipped",
      subject,
      verdict: "no plate subject declared — plate-subject axis skipped (pass)",
    };
  }
  const window = neighbours.slice(0, PLATE_SUBJECT_WARN_WINDOW);
  const repeatAt = window.findIndex((n) => n.plateSubject === subject);
  if (repeatAt < 0) {
    return {
      neighbours,
      repeatAt: null,
      status: "pass",
      subject,
      verdict: `plate subject "${subject}" is absent from the last ${window.length} findings — a fresh kind`,
    };
  }
  return {
    neighbours,
    repeatAt,
    status: "warn",
    subject,
    verdict: `plate subject "${subject}" already shipped ${findingsAgo(repeatAt)} (${window[repeatAt].logId}) — rotate the subject kind (hull / ruin / flora / creature / terrain / threshold)`,
  };
}

/** Resolve the recorded plate subject of each recent ledger entry (best-effort,
 *  local bundle then the public render.json). */
export async function plateSubjectLedger(entries: LedgerEntry[]): Promise<PlateSubjectNeighbour[]> {
  const out: PlateSubjectNeighbour[] = [];
  for (const entry of entries) {
    out.push({ logId: entry.logId, plateSubject: await plateSubjectOfLogId(entry.logId) });
  }
  return out;
}

/** Fetch + classify the structural family of each recent ledger entry (best-effort).
 *  Feed values win; the local render.json fills gaps. */
export async function classifyLedger(entries: LedgerEntry[]): Promise<StructureNeighbour[]> {
  const out: StructureNeighbour[] = [];
  for (const entry of entries) {
    const family = entry.feedStructure ?? (await structureOfLogId(entry.logId));
    out.push({ family, logId: entry.logId, vehicle: entry.vehicle });
  }
  return out;
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
  /** The structural-family axis (the checked claim beside the vehicle NAME). */
  structure: StructureGate;
  /** The plate-lane subject-kind axis (advisory: warn on a repeat inside 4). */
  plateSubject: PlateSubjectGate;
  /** Poster gate: distinct from the immediate neighbour's picture. */
  posterPass: boolean;
  /** Overall: the poster gate AND the structural gate did not FAIL. */
  pass: boolean;
  verdict: string;
};

/**
 * Judge the subject against the recent published neighbours on BOTH axes: the poster
 * picture-distance (structure-of-the-image) and the shader STRUCTURAL family (the
 * checked claim the vehicle name can't carry). `structureNeighbours` sets the
 * structural window (default 8; the last 4 are the hard FAIL window). `assumeStructure`
 * overrides the subject's classified family — for what-if / dry runs of the gate.
 */
export async function judgeDiversity(
  subject: string,
  opts: {
    neighbours?: number;
    structureNeighbours?: number;
    assumeStructure?: StructureFamily;
    assumePlateSubject?: string;
  } = {},
): Promise<DiversityReport> {
  const wanted = opts.neighbours ?? DEFAULT_NEIGHBOURS;
  const structureWanted = opts.structureNeighbours ?? DEFAULT_STRUCTURE_NEIGHBOURS;
  const scratchDir = mkdtempSync(path.join(tmpdir(), "fluncle-diversity-"));
  try {
    const subjectImg = await decodePoster(subject, scratchDir);
    const subjectFeat = featureOf(subjectImg);

    // Recent neighbours, excluding the subject itself if it is one of them. Fetch enough
    // for the WIDER of the two windows, then slice each axis from the same ledger.
    const subjectLogId = subject.endsWith(".jpg") || subject.endsWith(".png") ? null : subject;
    const ledger = (await fetchRecentLedger(Math.max(wanted, structureWanted) + 1)).filter(
      (e) => e.logId !== subjectLogId,
    );
    const neighbourIds = ledger.slice(0, wanted).map((e) => e.logId);

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
    const posterPass = immediateDistance === null || immediateDistance >= DIVERSITY_MIN;
    const posterVerdict =
      immediateDistance === null
        ? "no published neighbour to compare against (pass)"
        : posterPass
          ? `distinct from the immediate neighbour (${immediateDistance.toFixed(3)} >= ${DIVERSITY_MIN})`
          : `TOO SIMILAR to the immediate neighbour ${neighbours[0].logId} (${immediateDistance.toFixed(3)} < ${DIVERSITY_MIN}) — likely the same primitive recolored`;

    // The structural axis: classify the subject + the recent ledger, then the pure gate.
    const subjectFamily =
      opts.assumeStructure ?? (subjectLogId ? await structureOfLogId(subjectLogId) : null);
    const structureEntries = await classifyLedger(ledger.slice(0, structureWanted));
    const structure = evaluateStructureGate(subjectFamily, structureEntries);

    // The plate-subject axis (advisory). Resolve the subject's kind first and only
    // read the neighbours' render.jsons when there is a kind to compare — the
    // common (plate-less) path stays network-free.
    const subjectPlateSubject =
      asPlateSubject(opts.assumePlateSubject) ??
      (subjectLogId ? await plateSubjectOfLogId(subjectLogId) : null);
    const plateNeighbours = subjectPlateSubject
      ? await plateSubjectLedger(ledger.slice(0, PLATE_SUBJECT_WARN_WINDOW))
      : [];
    const plateSubject = evaluatePlateSubjectGate(subjectPlateSubject, plateNeighbours);

    const pass = posterPass && structure.status !== "fail";
    const verdict = `poster: ${posterVerdict} | structure: ${structure.verdict}${plateSubject.status === "skipped" ? "" : ` | plate subject: ${plateSubject.verdict}`}`;

    return {
      immediateDistance,
      neighbours,
      pass,
      plateSubject,
      posterPass,
      structure,
      subject,
      threshold: DIVERSITY_MIN,
      verdict,
    };
  } finally {
    rmSync(scratchDir, { force: true, recursive: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const strict = args.includes("--strict");
  const flagValue = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const neighboursRaw = flagValue("--neighbours");
  const neighbours = neighboursRaw !== undefined ? Number(neighboursRaw) : undefined;
  const structureNeighboursRaw = flagValue("--structure-neighbours");
  const structureNeighbours =
    structureNeighboursRaw !== undefined ? Number(structureNeighboursRaw) : undefined;
  const assumeRaw = flagValue("--assume-structure");
  const assumeStructure = assumeRaw ? (asFamily(assumeRaw) ?? undefined) : undefined;
  if (assumeRaw && !assumeStructure) {
    console.error(
      `--assume-structure must be one of ${STRUCTURE_FAMILIES.join(", ")}; got "${assumeRaw}"`,
    );
    process.exit(2);
  }
  const assumePlateSubject = flagValue("--assume-plate-subject");
  const valueFlags = new Set([
    "--neighbours",
    "--structure-neighbours",
    "--assume-structure",
    "--assume-plate-subject",
  ]);
  const subject = args.find((a, i) => !a.startsWith("--") && !valueFlags.has(args[i - 1] ?? ""));

  if (!subject) {
    console.error(
      "usage: judge-diversity <posterPathOrLogId> [--neighbours N] [--structure-neighbours N] [--assume-structure <family>] [--assume-plate-subject <kind>] [--strict] [--json]",
    );
    process.exit(2);
  }

  const report = await judgeDiversity(subject, {
    assumePlateSubject,
    assumeStructure,
    neighbours,
    structureNeighbours,
  });
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `diversity of ${report.subject} vs the last ${report.neighbours.length} published:`,
    );
    console.log("  poster (picture distance):");
    for (const n of report.neighbours) {
      const d = n.distance;
      console.log(
        `    ${n.immediate ? "→" : " "} ${n.logId}: ${d.combined.toFixed(3)} (edge ${d.edgeOrient.toFixed(2)}, color ${d.colorHist.toFixed(2)}, luma ${d.lumaContrast.toFixed(2)})${n.immediate ? "  [immediate neighbour — hard constraint]" : ""}`,
      );
    }
    const posterVerdict = report.verdict.split(" | ")[0]?.replace("poster: ", "") ?? "";
    console.log(`  ${report.posterPass ? "✓" : "✗"} poster: ${posterVerdict}`);
    const s = report.structure;
    console.log(`  structure (family — the checked claim): subject = ${s.subject ?? "unresolved"}`);
    for (let i = 0; i < s.neighbours.length; i++) {
      const n = s.neighbours[i];
      const hit = s.repeatAt === i ? "  ← repeat" : "";
      console.log(
        `    ${i === 0 ? "→" : " "} ${n.logId}: ${labelWithStructure(n.vehicle, n.family)}${hit}`,
      );
    }
    const mark = s.status === "fail" ? "✗" : s.status === "warn" ? "⚠" : "✓";
    console.log(`  ${mark} structure: ${s.verdict}`);
    const ps = report.plateSubject;
    if (ps.status !== "skipped") {
      for (let i = 0; i < ps.neighbours.length; i++) {
        const n = ps.neighbours[i];
        const hit = ps.repeatAt === i ? "  ← repeat" : "";
        console.log(
          `    ${i === 0 ? "→" : " "} ${n.logId}: ${n.plateSubject ?? "(no plate)"}${hit}`,
        );
      }
      console.log(`  ${ps.status === "warn" ? "⚠" : "✓"} plate subject: ${ps.verdict}`);
    }
    console.log(`${report.pass ? "✓" : "✗"} ${report.pass ? "diverse on both axes" : "FAIL"}`);
  }
  // Advisory by default; --strict makes an immediate-neighbour clone OR a structural
  // repeat inside the hard window a non-zero exit.
  process.exit(strict && !report.pass ? 1 : 0);
}
