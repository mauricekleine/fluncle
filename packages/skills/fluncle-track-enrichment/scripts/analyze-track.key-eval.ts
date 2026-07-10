#!/usr/bin/env bun
// analyze-track.key-eval — DEV / EVAL TOOL, NOT A CI TEST.
//
// Head-to-head accuracy gate for the musical-key estimator against a Rekordbox
// ground-truth set (DJ-beatgridded, confident full-song keys). It hits the NETWORK
// (Deezer/iTunes) and downloads COPYRIGHTED 30s previews, so it must never run in CI —
// it is the ship/no-ship measurement the estimator rebuild is judged by.
//
// It resolves the SAME preview windows the production pipeline analyzes (via the
// exported `resolvePreviews`), decodes them through the same ffmpeg seam, and scores
// TWO estimators per row against the Rekordbox key:
//   - "current": a frozen copy of the pre-rebuild K-S estimator (the baseline to beat);
//   - "new":     the rebuilt whole-track chromagram estimator (analyze-track.ts).
// Downloaded previews are cached under a temp dir so re-runs (config sweeps) are fast.
//
//   bun analyze-track.key-eval.ts \
//     --csv /path/to/rekordbox-ground-truth.csv \
//     [--cache /tmp/key-eval-cache] [--limit 35] [--sweep]
//
// Categories per row: exact / mode-flip (parallel) / relative / other / null.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeToSamples, estimateKey, KEY_PROFILES, resolvePreviews } from "./analyze-track.ts";

const SAMPLE_RATE = 22050;
const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);

  return index >= 0 ? process.argv[index + 1] : undefined;
}

// The ground-truth CSV is an ad-hoc operator artifact (not committed — it holds a
// Rekordbox export), so `--csv <path>` is REQUIRED. Columns: logId,title,artist,rbKey
// (rbKey normalized to "<Note> major|minor").
const csvPath = arg("csv");

if (!csvPath) {
  console.error(
    "usage: bun analyze-track.key-eval.ts --csv <ground-truth.csv> [--cache <dir>] [--limit N] [--sweep]",
  );
  process.exit(1);
}

const cacheDir = arg("cache") ?? join(tmpdir(), "fluncle-key-eval-cache");
const limit = arg("limit") ? Number(arg("limit")) : Infinity;
const sweep = process.argv.includes("--sweep");

mkdirSync(cacheDir, { recursive: true });

// ---------------------------------------------------------------------------
// CSV + key parsing
// ---------------------------------------------------------------------------

type Row = { artist: string; logId: string; rbKey: string; title: string };

function parseCsv(text: string): Row[] {
  const lines = text.trim().split("\n");
  const header = (lines[0] ?? "").split(",");
  const col = (name: string) => header.indexOf(name);
  const iLog = col("logId");
  const iTitle = col("title");
  const iArtist = col("artist");
  const iRbKey = col("rbKey");
  const rows: Row[] = [];

  for (const line of lines.slice(1)) {
    // Minimal CSV: only the artist field is quoted (may contain commas).
    const cells: string[] = [];
    let cur = "";
    let inQuotes = false;

    for (const ch of line) {
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        cells.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }

    cells.push(cur);
    rows.push({
      artist: cells[iArtist] ?? "",
      logId: cells[iLog] ?? "",
      rbKey: cells[iRbKey] ?? "",
      title: cells[iTitle] ?? "",
    });
  }

  return rows;
}

function parseKey(value: string): { mode: "major" | "minor"; root: number } | null {
  const match = /^([A-G]#?)\s+(major|minor)$/.exec(value.trim());

  if (!match) {
    return null;
  }

  const root = NOTES.indexOf(match[1] ?? "");

  return root < 0 ? null : { mode: match[2] as "major" | "minor", root };
}

type Category = "exact" | "mode-flip" | "null" | "other" | "relative";

function categorize(pred: string | null, truth: string): Category {
  if (pred === null) {
    return "null";
  }

  const p = parseKey(pred);
  const t = parseKey(truth);

  if (!p || !t) {
    return "other";
  }

  if (p.root === t.root && p.mode === t.mode) {
    return "exact";
  }

  if (p.root === t.root) {
    return "mode-flip";
  }

  // Relative major/minor: C major ↔ A minor (major root +9 = its relative minor).
  if (p.mode === "major" && t.mode === "minor" && (p.root + 9) % 12 === t.root) {
    return "relative";
  }

  if (p.mode === "minor" && t.mode === "major" && (p.root + 3) % 12 === t.root) {
    return "relative";
  }

  return "other";
}

// ---------------------------------------------------------------------------
// "current" estimator — a FROZEN copy of the pre-rebuild K-S key path
// (main: spectral() 25 s linear-magnitude chroma + Pearson vs Krumhansl). Kept here
// verbatim so the eval is an honest head-to-head against what shipped, independent of
// the rebuilt analyze-track.ts.
// ---------------------------------------------------------------------------

const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function fftLocal(re: Float64Array, im: Float64Array): void {
  const n = re.length;

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;

    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }

    j ^= bit;

    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);

    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;

      for (let k = 0; k < len >> 1; k++) {
        const ar = re[i + k];
        const ai = im[i + k];
        const br = re[i + k + (len >> 1)] * cr - im[i + k + (len >> 1)] * ci;
        const bi = re[i + k + (len >> 1)] * ci + im[i + k + (len >> 1)] * cr;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + (len >> 1)] = ar - br;
        im[i + k + (len >> 1)] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function pearsonLocal(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;

  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }

  return num / (Math.sqrt(da * db) || 1);
}

function legacyChroma(samples: Float32Array): number[] {
  const N = 4096;
  const hop = 2048;
  const hann = new Float64Array(N);

  for (let i = 0; i < N; i++) {
    hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  }

  const chroma = Array.from({ length: 12 }, () => 0);
  const upper = Math.min(samples.length - N, SAMPLE_RATE * 25);

  for (let start = 0; start < upper; start += hop) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);

    for (let i = 0; i < N; i++) {
      re[i] = (samples[start + i] ?? 0) * hann[i];
    }

    fftLocal(re, im);

    for (let b = 1; b < N / 2; b++) {
      const mag = Math.hypot(re[b], im[b]);
      const freq = (b * SAMPLE_RATE) / N;

      if (freq >= 55 && freq <= 5000) {
        const pc = ((Math.round(69 + 12 * Math.log2(freq / 440)) % 12) + 12) % 12;
        chroma[pc] += mag;
      }
    }
  }

  return chroma;
}

function currentEstimateKey(samples: Float32Array): { confidence: number; key: string } {
  const chroma = legacyChroma(samples);
  let best = { confidence: -2, key: "unknown" };

  for (let r = 0; r < 12; r++) {
    const maj = KS_MAJOR.map((_, i) => KS_MAJOR[(i - r + 12) % 12] ?? 0);
    const min = KS_MINOR.map((_, i) => KS_MINOR[(i - r + 12) % 12] ?? 0);
    const cMaj = pearsonLocal(chroma, maj);
    const cMin = pearsonLocal(chroma, min);

    if (cMaj > best.confidence) {
      best = { confidence: cMaj, key: `${NOTES[r]} major` };
    }

    if (cMin > best.confidence) {
      best = { confidence: cMin, key: `${NOTES[r]} minor` };
    }
  }

  return { confidence: Number(best.confidence.toFixed(2)), key: best.key };
}

// ---------------------------------------------------------------------------
// Preview download + decode with an on-disk cache
// ---------------------------------------------------------------------------

async function samplesForRow(row: Row): Promise<Array<{ samples: Float32Array; source: string }>> {
  const previews = await resolvePreviews({ artist: row.artist, title: row.title });
  const out: Array<{ samples: Float32Array; source: string }> = [];

  for (const [index, preview] of previews.entries()) {
    const cacheFile = join(cacheDir, `${row.logId}.${index}.${preview.source.replace(/:/g, "_")}`);

    try {
      if (!existsSync(cacheFile)) {
        const response = await fetch(preview.url);
        writeFileSync(cacheFile, Buffer.from(await response.arrayBuffer()));
      }

      out.push({ samples: decodeToSamples(cacheFile), source: preview.source });
    } catch {
      // skip a preview that won't download/decode
    }
  }

  return out;
}

// Mirror the CLI's per-field choice: key = the most-confident read across the previews.
function bestKey(
  reads: Array<{ samples: Float32Array; source: string }>,
  estimate: (s: Float32Array) => { confidence: number; key: string },
): { confidence: number; key: string } | null {
  let best: { confidence: number; key: string } | null = null;

  for (const read of reads) {
    const k = estimate(read.samples);

    if (best === null || k.confidence > best.confidence) {
      best = k;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

type Tally = Record<Category, number>;

function emptyTally(): Tally {
  return { exact: 0, "mode-flip": 0, null: 0, other: 0, relative: 0 };
}

function report(name: string, tally: Tally, total: number): void {
  const nonNull = total - tally.null;
  const exactPct = nonNull > 0 ? ((tally.exact / nonNull) * 100).toFixed(1) : "n/a";
  console.log(
    `${name.padEnd(22)} exact=${tally.exact} mode-flip=${tally["mode-flip"]} relative=${tally.relative} other=${tally.other} null=${tally.null}  | exact/non-null=${exactPct}% (${tally.exact}/${nonNull})`,
  );
}

async function main(): Promise<void> {
  if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0) {
    console.error("ffmpeg is required (skill prereq).");
    process.exit(1);
  }

  const rows = parseCsv(readFileSync(csvPath, "utf8")).slice(0, limit);
  console.error(`[eval] ${rows.length} rows; cache ${cacheDir}`);

  // Config sweep for the "new" estimator. The first is the shipped default.
  const configs: Array<{ name: string; opts?: Parameters<typeof estimateKey>[1] }> = sweep
    ? [
        { name: "new:default" },
        { name: "new:default-bias0", opts: { majorBias: 0 } },
        { name: "new:default-bias.05", opts: { majorBias: 0.05 } },
        { name: "new:default-bias.08", opts: { majorBias: 0.08 } },
        { name: "new:default-bias.12", opts: { majorBias: 0.12 } },
        { name: "new:default-bias.15", opts: { majorBias: 0.15 } },
        { name: "new:edma-bias.2", opts: { majorBias: 0.2 } },
        { name: "new:edma-bias.25", opts: { majorBias: 0.25 } },
        { name: "new:edmm", opts: { majorBias: 0, profiles: KEY_PROFILES.edmm } },
        {
          name: "new:hybrid.1",
          opts: {
            majorBias: 0.1,
            profiles: { major: KEY_PROFILES.edma.major, minor: KEY_PROFILES.edmm.minor },
          },
        },
        {
          name: "new:hybrid.15",
          opts: {
            majorBias: 0.15,
            profiles: { major: KEY_PROFILES.edma.major, minor: KEY_PROFILES.edmm.minor },
          },
        },
        {
          name: "new:hybrid.2",
          opts: {
            majorBias: 0.2,
            profiles: { major: KEY_PROFILES.edma.major, minor: KEY_PROFILES.edmm.minor },
          },
        },
        {
          name: "new:hybrid.25",
          opts: {
            majorBias: 0.25,
            profiles: { major: KEY_PROFILES.edma.major, minor: KEY_PROFILES.edmm.minor },
          },
        },
        { name: "new:krumhansl", opts: { profiles: KEY_PROFILES.krumhansl } },
        { name: "new:temperley", opts: { profiles: KEY_PROFILES.temperley } },
        { name: "new:no-harmonics", opts: { harmonicDecay: 0, harmonics: 1 } },
        { name: "new:tuning-on", opts: { tuning: true } },
        { name: "new:log", opts: { compression: "log" } },
        { name: "new:none-compress", opts: { compression: "none" } },
        { name: "new:h6", opts: { harmonics: 6 } },
        { name: "new:seg8", opts: { segmentS: 8 } },
        { name: "new:seg16", opts: { segmentS: 16 } },
      ]
    : [{ name: "new:default" }];

  const currentTally = emptyTally();
  const newTallies = new Map(configs.map((c) => [c.name, emptyTally()]));
  // Floor-tuning: keep (confidence, category) for the shipped default.
  const newConfSamples: Array<{ category: Category; confidence: number }> = [];

  let evaluated = 0;

  for (const row of rows) {
    const truth = row.rbKey;
    const reads = await samplesForRow(row);

    if (reads.length === 0) {
      console.error(`[eval] ${row.logId} ${row.artist} — ${row.title}: no preview`);
      continue;
    }

    evaluated++;

    const cur = bestKey(reads, currentEstimateKey);
    const curCat = categorize(cur?.key ?? null, truth);
    currentTally[curCat]++;

    for (const config of configs) {
      const est = (s: Float32Array) => estimateKey(s, config.opts);
      const k = bestKey(reads, est);
      const cat = categorize(k?.key ?? null, truth);
      const tally = newTallies.get(config.name);

      if (tally) {
        tally[cat]++;
      }

      if (config.name === "new:default" && k) {
        newConfSamples.push({ category: cat, confidence: k.confidence });
      }
    }

    const def = configs[0];
    const defK = def ? bestKey(reads, (s) => estimateKey(s, def.opts)) : null;
    console.error(
      `[eval] ${row.logId} ${row.title} | truth=${truth} cur=${cur?.key}(${categorize(cur?.key ?? null, truth)}) new=${defK?.key}(${categorize(defK?.key ?? null, truth)}) conf=${defK?.confidence}`,
    );
  }

  console.log(`\n=== KEY EVAL (${evaluated} rows with a preview, of ${rows.length}) ===`);
  report("current (K-S 25s)", currentTally, evaluated);

  for (const config of configs) {
    const tally = newTallies.get(config.name);

    if (tally) {
      report(config.name, tally, evaluated);
    }
  }

  // Floor tuning for the shipped default: precision (exact / non-null) and recall as
  // the confidence floor rises. A row is "kept" when confidence >= floor.
  console.log(`\n=== FLOOR TUNING (new:default) ===`);

  for (const floor of [0, 0.25, 0.34, 0.4, 0.5, 0.6, 0.67, 0.75]) {
    const kept = newConfSamples.filter((s) => s.confidence >= floor);
    const exact = kept.filter((s) => s.category === "exact").length;
    const bad = kept.filter((s) => s.category === "mode-flip" || s.category === "relative").length;
    const precision = kept.length > 0 ? ((exact / kept.length) * 100).toFixed(1) : "n/a";
    console.log(
      `floor=${floor.toFixed(2)}  kept=${kept.length}/${newConfSamples.length}  exact=${exact}  mode-flip+relative=${bad}  precision(exact/kept)=${precision}%`,
    );
  }
}

await main();
