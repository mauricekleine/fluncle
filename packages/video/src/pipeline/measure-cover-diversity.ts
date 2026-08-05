// The COVER metric — the family the homogenisation ledger had nothing for. A finding's
// `cover.jpg` is a SEPARATELY rendered artifact (render-cover.ts composes the <Cover>
// still over a late footage frame), and both shipped image judges hard-code
// `poster.jpg`, so no gate and no measurement has ever looked at a cover.
//
// This harness is deliberately the OTHER shape from those judges:
//   - WHOLE-CORPUS, not subject-vs-neighbours. Every cover against every other cover,
//     so the question is "does the cover corpus have a mean it drifts toward", not
//     "may this one ship".
//   - GATE-FREE. It exits 0 always, writes nothing, and touches no generation path. A
//     ledger entry wants a number, not a verdict.
//
// It reuses the poster metric's primitives unchanged — `featureOf` + `diversityDistance`
// (edge 0.60 / colour 0.20 / luma 0.20, structure-dominant so a recolor cannot launder a
// reused primitive) and palette-summary's closed hue-bucket vocabulary — so a cover
// number is comparable with a poster number rather than living in its own units.
//
// THE 0.35 REFERENCE LINE: `DIVERSITY_MIN` was calibrated on POSTERS (a same-primitive
// recolored pair vs a genuinely distinct pair, both posters). Covers carry type, a
// different crop, and a frame drawn from the drop window, so that calibration does not
// transfer. Pairs under it are reported as "echoing pairs" — an advisory count against a
// borrowed reference line, never a verdict about a cover.
//
// CLI: bun src/pipeline/measure-cover-diversity.ts [--limit N] [--top K] [--out <path>]

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseArgs } from "./args";
import { decodeImageRgb, type RgbImage } from "./frames";
import {
  type DiversityDistance,
  type DiversityFeature,
  DIVERSITY_MIN,
  diversityDistance,
  featureOf,
  fetchRecentLedger,
} from "./judge-diversity";
import {
  hueBucketOf,
  type PaletteBucket,
  PALETTE_BUCKETS,
  parseHex,
  rgbToHsv,
} from "./palette-summary";

const DECODE_SIZE = 160;
const DEFAULT_LIMIT = 40;
const DEFAULT_TOP = 10;

/** Dominant swatches per cover — three, matching palette-summary's recorded receipt. */
const SWATCHES_PER_COVER = 3;

/** Levels per channel when quantizing a cover into colour bins (8³ = 512 bins). Coarse
 *  on purpose: the question is which palette basin a cover sits in, not its fine hues. */
const SWATCH_LEVELS = 8;

const OUT_DIR = path.resolve(import.meta.dirname, "../../out");
const coverUrl = (logId: string): string => `https://found.fluncle.com/${logId}/cover.jpg`;

// ---------------------------------------------------------------------------
// Palette (pure over a decoded RgbImage)
// ---------------------------------------------------------------------------

export type CoverPalette = {
  /** The dominant hex swatches, most-frequent first. */
  swatches: string[];
  /** The cover's DEFINING bucket: the hue bucket of its most chromatic dominant swatch. */
  bucket: PaletteBucket;
};

const toHex = (v: number): string => Math.round(v).toString(16).padStart(2, "0");

/**
 * The most-frequent colours in an image, quantized onto a coarse `SWATCH_LEVELS³` grid
 * and returned as the MEAN colour of each winning bin. Ties break on bin index so the
 * same image always yields the same swatches in the same order.
 */
export function dominantSwatches(img: RgbImage, count: number = SWATCHES_PER_COVER): string[] {
  const bins = SWATCH_LEVELS ** 3;
  const tally = new Float64Array(bins);
  const sumR = new Float64Array(bins);
  const sumG = new Float64Array(bins);
  const sumB = new Float64Array(bins);
  const pixels = img.width * img.height;
  const step = 256 / SWATCH_LEVELS;

  for (let p = 0; p < pixels; p++) {
    const r = img.data[p * 3];
    const g = img.data[p * 3 + 1];
    const b = img.data[p * 3 + 2];
    const ri = Math.min(SWATCH_LEVELS - 1, Math.floor(r / step));
    const gi = Math.min(SWATCH_LEVELS - 1, Math.floor(g / step));
    const bi = Math.min(SWATCH_LEVELS - 1, Math.floor(b / step));
    const bin = (ri * SWATCH_LEVELS + gi) * SWATCH_LEVELS + bi;
    tally[bin] += 1;
    sumR[bin] += r;
    sumG[bin] += g;
    sumB[bin] += b;
  }

  const order: number[] = [];
  for (let bin = 0; bin < bins; bin++) {
    if (tally[bin] > 0) {
      order.push(bin);
    }
  }
  order.sort((a, b) => tally[b] - tally[a] || a - b);

  return order.slice(0, Math.max(0, count)).map((bin) => {
    const n = tally[bin];
    return `#${toHex(sumR[bin] / n)}${toHex(sumG[bin] / n)}${toHex(sumB[bin] / n)}`;
  });
}

/** Saturation×value of a hex swatch — its perceptual chroma; 0 when unparseable. */
function chromaOf(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) {
    return 0;
  }
  const { s, v } = rgbToHsv(rgb[0], rgb[1], rgb[2]);
  return s * v;
}

/**
 * A cover's palette record. The DEFINING bucket is the hue bucket of the most chromatic
 * dominant swatch, mirroring `summarizePalette`'s "defining heat stop" rule: the
 * near-black cosmos field a cover is mostly made of is the most FREQUENT colour but says
 * nothing about which basin the cover sits in. An all-neutral cover buckets neutral-mono.
 * Ties keep the earlier (more frequent) swatch, so the choice never wobbles.
 */
export function coverPaletteOf(img: RgbImage): CoverPalette {
  const swatches = dominantSwatches(img);
  let defining: string | null = null;
  let best = -1;
  for (const hex of swatches) {
    const chroma = chromaOf(hex);
    if (chroma > best) {
      best = chroma;
      defining = hex;
    }
  }
  return { bucket: defining ? hueBucketOf(defining) : "neutral-mono", swatches };
}

/** Count buckets across the corpus, in the closed vocabulary's own order (zeros kept —
 *  an empty bucket is the shape of the spread, not missing data). */
export function bucketHistogram(buckets: PaletteBucket[]): { bucket: PaletteBucket; n: number }[] {
  const counts = new Map<PaletteBucket, number>();
  for (const bucket of buckets) {
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return PALETTE_BUCKETS.map((bucket) => ({ bucket, n: counts.get(bucket) ?? 0 }));
}

// ---------------------------------------------------------------------------
// Pair enumeration + corpus summary (pure)
// ---------------------------------------------------------------------------

export type CoverSample = {
  logId: string;
  feature: DiversityFeature;
  palette: CoverPalette;
};

export type CoverPair = {
  a: string;
  b: string;
  distance: DiversityDistance;
};

/** Every unordered pair (i < j), in stable corpus order. n samples → n(n−1)/2 pairs. */
export function coverPairs(samples: CoverSample[]): CoverPair[] {
  const pairs: CoverPair[] = [];
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      pairs.push({
        a: samples[i].logId,
        b: samples[j].logId,
        distance: diversityDistance(samples[i].feature, samples[j].feature),
      });
    }
  }
  return pairs;
}

/** How many pairs sit under the reference line — the advisory "echoing pairs" count. */
export function countEchoingPairs(pairs: CoverPair[], threshold: number = DIVERSITY_MIN): number {
  return pairs.filter((p) => p.distance.combined < threshold).length;
}

export type CoverCorpusReport = {
  /** Covers that decoded — the corpus the numbers describe. */
  measured: number;
  /** Findings the feed offered before resolution. */
  offered: number;
  /** Coordinates whose cover could not be resolved locally or over the network. */
  unreachable: string[];
  pairs: number;
  meanDistance: number | null;
  minDistance: number | null;
  maxDistance: number | null;
  /** Mean of each weighted component across all pairs — which view the corpus varies on. */
  meanEdge: number | null;
  meanColor: number | null;
  meanLuma: number | null;
  /** The most-similar pairs, closest first. */
  worst: CoverPair[];
  echoThreshold: number;
  echoingPairs: number;
  /** The defining-bucket spread: one bucket per cover. */
  buckets: { bucket: PaletteBucket; n: number }[];
  /** The raw spread over every dominant swatch of every cover. */
  swatchBuckets: { bucket: PaletteBucket; n: number }[];
};

/**
 * The whole-corpus summary: all-pairs distance, its mean/min/max, the K most-similar
 * pairs, the advisory echoing count, and the palette spread. Pure — no fs, no network,
 * no threshold that decides anything.
 */
export function summarizeCoverCorpus(
  samples: CoverSample[],
  opts: {
    offered?: number;
    unreachable?: string[];
    top?: number;
    threshold?: number;
  } = {},
): CoverCorpusReport {
  const threshold = opts.threshold ?? DIVERSITY_MIN;
  const top = opts.top ?? DEFAULT_TOP;
  const pairs = coverPairs(samples);
  const sorted = [...pairs].sort(
    (x, y) => x.distance.combined - y.distance.combined || x.a.localeCompare(y.a),
  );

  let sum = 0;
  let sumEdge = 0;
  let sumColor = 0;
  let sumLuma = 0;
  for (const pair of pairs) {
    sum += pair.distance.combined;
    sumEdge += pair.distance.edgeOrient;
    sumColor += pair.distance.colorHist;
    sumLuma += pair.distance.lumaContrast;
  }
  const mean = (total: number): number | null => (pairs.length > 0 ? total / pairs.length : null);

  return {
    buckets: bucketHistogram(samples.map((s) => s.palette.bucket)),
    echoThreshold: threshold,
    echoingPairs: countEchoingPairs(pairs, threshold),
    maxDistance: sorted.length > 0 ? sorted[sorted.length - 1].distance.combined : null,
    meanColor: mean(sumColor),
    meanDistance: mean(sum),
    meanEdge: mean(sumEdge),
    meanLuma: mean(sumLuma),
    measured: samples.length,
    minDistance: sorted.length > 0 ? sorted[0].distance.combined : null,
    offered: opts.offered ?? samples.length,
    pairs: pairs.length,
    swatchBuckets: bucketHistogram(
      samples.flatMap((s) => s.palette.swatches.map((hex) => hueBucketOf(hex))),
    ),
    unreachable: opts.unreachable ?? [],
    worst: sorted.slice(0, Math.max(0, top)),
  };
}

// ---------------------------------------------------------------------------
// Report formatting (pure)
// ---------------------------------------------------------------------------

const num = (value: number | null, digits = 3): string =>
  value === null ? "n/a" : value.toFixed(digits);

/** The Markdown report. Pure over a summary, so the wording is pinned by tests. */
export function formatCoverReport(report: CoverCorpusReport): string {
  const lines: string[] = [];
  lines.push("# Cover diversity — whole-corpus measurement");
  lines.push("");
  lines.push(
    "Measurement, not a gate: this harness never fails a ship, writes nothing, and touches no generation path. Distances are `diversityDistance` (edge 0.60 / colour 0.20 / luma 0.20) over every cover decoded at 160², the same primitive the poster judge uses.",
  );
  lines.push("");
  lines.push("## Corpus");
  lines.push("");
  lines.push(`- covers measured: **${report.measured}** of ${report.offered} findings offered`);
  lines.push(`- pairs compared: **${report.pairs}**`);
  lines.push(
    `- unresolved covers: ${report.unreachable.length === 0 ? "none" : `${report.unreachable.length} (${report.unreachable.join(", ")})`}`,
  );
  lines.push("");
  lines.push("## Pairwise distance");
  lines.push("");
  lines.push(`- mean: **${num(report.meanDistance)}**`);
  lines.push(`- min: **${num(report.minDistance)}**`);
  lines.push(`- max: **${num(report.maxDistance)}**`);
  lines.push("");
  lines.push(
    `Per view, unweighted: edge ${num(report.meanEdge)} · colour ${num(report.meanColor)} · luma ${num(report.meanLuma)}. The edge figure is the one to read first — it is the structural fingerprint that carries 0.60 of the combined distance, and a cover's structure is largely the fixed \`<Cover>\` layout rather than the art underneath it.`,
  );
  lines.push("");
  lines.push(`## The ${report.worst.length} most-similar pairs`);
  lines.push("");
  lines.push("| pair | combined | edge | colour | luma |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const pair of report.worst) {
    const d = pair.distance;
    lines.push(
      `| ${pair.a} ↔ ${pair.b} | ${num(d.combined)} | ${num(d.edgeOrient, 2)} | ${num(d.colorHist, 2)} | ${num(d.lumaContrast, 2)} |`,
    );
  }
  lines.push("");
  lines.push("## Echoing pairs");
  lines.push("");
  lines.push(
    `**${report.echoingPairs}** of ${report.pairs} pairs sit under ${report.echoThreshold}.`,
  );
  lines.push("");
  lines.push(
    `The ${report.echoThreshold} line is \`DIVERSITY_MIN\`, calibrated on POSTERS — a same-primitive recolored poster pair against a genuinely distinct one. Covers carry type, a different crop, and a frame pulled from the drop window, so that calibration does not transfer: read the count as a reference line for comparing cover runs against each other, never as a verdict on any cover.`,
  );
  lines.push("");
  lines.push("## Palette spread");
  lines.push("");
  lines.push(
    "The closed hue-bucket vocabulary from `palette-summary.ts`. The DEFINING bucket is the most chromatic of a cover's three dominant swatches — the cosmos field is the most frequent colour on every cover and says nothing about its basin.",
  );
  lines.push("");
  lines.push("| bucket | covers (defining) | swatches (all) |");
  lines.push("| --- | --- | --- |");
  for (let i = 0; i < report.buckets.length; i++) {
    lines.push(
      `| ${report.buckets[i].bucket} | ${report.buckets[i].n} | ${report.swatchBuckets[i]?.n ?? 0} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Resolution + the run (impure)
// ---------------------------------------------------------------------------

/** Decode a cover LOCAL-FIRST (a shipped bundle under out/) then from the public host.
 *  Returns null (never throws) when neither is reachable — one missing cover must not
 *  cost the corpus its numbers. */
export async function resolveCover(logId: string, scratchDir: string): Promise<RgbImage | null> {
  const local = path.join(OUT_DIR, logId, "cover.jpg");
  if (existsSync(local)) {
    try {
      return decodeImageRgb(local, { height: DECODE_SIZE, width: DECODE_SIZE });
    } catch {
      // fall through to the network copy
    }
  }
  try {
    const res = await fetch(coverUrl(logId));
    if (!res.ok) {
      return null;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const tmp = path.join(scratchDir, `${logId.replace(/[^\w.-]/g, "_")}.jpg`);
    writeFileSync(tmp, bytes);
    return decodeImageRgb(tmp, { height: DECODE_SIZE, width: DECODE_SIZE });
  } catch {
    return null;
  }
}

/** Measure the cover corpus: resolve up to `limit` published findings' covers, then
 *  summarize. Read-only against the public host. */
export async function measureCoverDiversity(
  opts: { limit?: number; top?: number } = {},
): Promise<CoverCorpusReport> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const scratchDir = mkdtempSync(path.join(tmpdir(), "fluncle-covers-"));
  try {
    const ledger = await fetchRecentLedger(limit);
    const samples: CoverSample[] = [];
    const unreachable: string[] = [];
    for (const entry of ledger) {
      const img = await resolveCover(entry.logId, scratchDir);
      if (!img) {
        unreachable.push(entry.logId);
        continue;
      }
      samples.push({
        feature: featureOf(img),
        logId: entry.logId,
        palette: coverPaletteOf(img),
      });
    }
    return summarizeCoverCorpus(samples, {
      offered: ledger.length,
      top: opts.top,
      unreachable,
    });
  } finally {
    rmSync(scratchDir, { force: true, recursive: true });
  }
}

if (import.meta.main) {
  const { flags } = parseArgs(process.argv.slice(2), {
    limit: "number",
    out: "string",
    top: "number",
  });

  const report = await measureCoverDiversity({ limit: flags.limit, top: flags.top });
  const markdown = formatCoverReport(report);
  console.log(markdown);
  if (flags.out) {
    writeFileSync(flags.out, markdown);
    console.error(`[covers] wrote ${flags.out}`);
  }
  // Measurement, never a ship gate.
  process.exit(0);
}
