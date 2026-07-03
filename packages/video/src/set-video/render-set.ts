// Unit O · render-set — the orchestrator for the hour-long set video.
//
// The panel-corrected architecture: ONE parent composition (chapters + travel
// transitions + the dreamer's-continuity driver), rendered in frameRange CHUNKS.
// Remotion determinism makes chunk boundaries byte-consistent, so the chunks
// concat with `-c copy` (no re-encode generation — the load-bearing grain never
// suffers) and the mastered set audio is muxed ONCE, at the end (48k AAC).
// Chunked = resumable (re-render only the missing chunks), parallelizable, and
// QA-able per chunk.
//
// Two modes:
//   • full   — build every chapter from the mix-in offsets, render the whole set.
//   • pilot  — `--pilot <logId>`: prep + analyze + render ONE chapter end-to-end
//              (the validate-one rule) with stills, to prove no freeze + the
//              Log-ID moment + landscape, without paying for the hour.
//
// Usage:
//   bun src/set-video/render-set.ts <mixtapeLogId> [--pilot <logId>] [--draft]
//       [--from-fixtures] [--chunk-sec N] [--workers N] [--stills N]
//
// The full hour is the operator's evening GPU job; see docs/set-video.md.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";

import { type NostalgicCosmosProps } from "../remotion/types";
import { analyzeSet } from "../pipeline/analyze-set";
import { parseArgs } from "../pipeline/args";
import { glRenderer } from "../pipeline/gl";
import { buildChapterAudio } from "./chapter-props";
import { prepChapter, type PrepReport } from "./chapter-prep";
import { type SetChapterSpec, type SetCompositionProps } from "./set-composition";

const FFMPEG = process.env.FLUNCLE_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.FLUNCLE_FFPROBE ?? "ffprobe";
const MEDIA_BASE = process.env.FLUNCLE_MEDIA_URL ?? "https://found.fluncle.com";
const FPS = 30;

const SET_OUT_ROOT = path.resolve(import.meta.dirname, "../../set-out");
const FIXTURES = path.resolve(import.meta.dirname, "__fixtures__");
const SET_ENTRY = path.resolve(import.meta.dirname, "set-entry.ts");

// ---------------------------------------------------------------------------
// The chapter plan (pure — tested)
// ---------------------------------------------------------------------------

export type Anchor = { logId: string; bestMs: number };
export type ChapterPlanEntry = { logId: string; startMs: number; endMs: number; mixInMs: number };

/**
 * Turn the fingerprint-derived mix-in offsets into a contiguous chapter plan.
 * Sorts by mix-in, drops degenerate (too-short) chapters, and makes the chapters
 * cover [0, setDurationMs] end-to-end (chapter 0 absorbs the pre-first-track
 * lead-in; the last runs to the set end). The mix-in is preserved separately so
 * the Log-ID moment can land on the true arrival even inside chapter 0.
 */
export function buildChapterPlan(
  anchors: Anchor[],
  setDurationMs: number,
  minChapterMs = 8_000,
): ChapterPlanEntry[] {
  const sorted = [...anchors].filter((a) => a.bestMs >= 0).sort((a, b) => a.bestMs - b.bestMs);
  // Dedupe near-equal mix-ins (fingerprint ties) — keep the first.
  const deduped: Anchor[] = [];
  for (const a of sorted) {
    const last = deduped[deduped.length - 1];
    if (!last || a.bestMs - last.bestMs >= minChapterMs) {
      deduped.push(a);
    }
  }
  const plan: ChapterPlanEntry[] = [];
  for (let i = 0; i < deduped.length; i += 1) {
    const cur = deduped[i];
    if (!cur) {
      continue;
    }
    const startMs = i === 0 ? 0 : cur.bestMs;
    const next = deduped[i + 1];
    const endMs = next ? next.bestMs : setDurationMs;
    if (endMs - startMs < minChapterMs) {
      continue;
    }
    plan.push({ endMs, logId: cur.logId, mixInMs: cur.bestMs, startMs });
  }
  return plan;
}

/** Inclusive frameRange chunks over [0, totalFrames). */
export function chunkRanges(totalFrames: number, chunkFrames: number): [number, number][] {
  const ranges: [number, number][] = [];
  for (let start = 0; start < totalFrames; start += chunkFrames) {
    ranges.push([start, Math.min(totalFrames, start + chunkFrames) - 1]);
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// Small shell helpers
// ---------------------------------------------------------------------------

function probeDurationMs(input: string): number {
  const res = spawnSync(FFPROBE, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=nokey=1:noprint_wrappers=1",
    input,
  ]);
  const n = Number.parseFloat((res.stdout?.toString() ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0;
}

async function run(cmd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}\n${stderr.slice(-2000)}`)),
    );
  });
}

// ---------------------------------------------------------------------------
// Assemble one chapter (prep the comp + analyze the audio slice)
// ---------------------------------------------------------------------------

type AssembledChapter = { spec: SetChapterSpec; report: PrepReport };

async function assembleChapter(
  entry: ChapterPlanEntry,
  setAudioPath: string,
  isFinal: boolean,
): Promise<AssembledChapter> {
  const durationMs = entry.endMs - entry.startMs;
  const [{ archived, report }, audio] = await Promise.all([
    prepChapter({ chapterDurationMs: durationMs, isFinalChapter: isFinal, logId: entry.logId }),
    buildChapterAudio(setAudioPath, entry.startMs, entry.endMs),
  ]);
  // Chapter props: the finding's OWN identity (track/palette/seed) + the freshly
  // analyzed slice of the actual set audio.
  const props: NostalgicCosmosProps = {
    aspect: "landscape",
    audio,
    hideOverlay: true,
    palette: archived.props.palette,
    seed: archived.props.seed,
    track: archived.props.track,
  };
  return { report, spec: { durationMs, logId: entry.logId, props, startMs: entry.startMs } };
}

// ---------------------------------------------------------------------------
// Render (chunked) + concat + mux
// ---------------------------------------------------------------------------

async function renderSet(opts: {
  props: SetCompositionProps;
  outDir: string;
  setAudioPath: string;
  coveredStartMs: number;
  coveredEndMs: number;
  draft: boolean;
  chunkSec: number;
}): Promise<string> {
  const { props, outDir, setAudioPath, coveredStartMs, coveredEndMs, draft, chunkSec } = opts;
  const chunkDir = path.join(outDir, "chunks");
  mkdirSync(chunkDir, { recursive: true });

  console.error("[render-set] bundling set-entry.ts …");
  const serveUrl = await bundle({ entryPoint: SET_ENTRY, webpackOverride: (c) => c });

  const composition = await selectComposition({
    chromiumOptions: { gl: glRenderer() },
    id: "FluncleSet",
    inputProps: props,
    serveUrl,
    timeoutInMilliseconds: 300_000,
  });

  const totalFrames = composition.durationInFrames;
  const ranges = chunkRanges(totalFrames, Math.max(1, Math.round(chunkSec * FPS)));
  console.error(
    `[render-set] ${totalFrames} frames → ${ranges.length} chunk(s) of ~${chunkSec}s (${draft ? "DRAFT" : "full"})`,
  );

  const chunkPaths: string[] = [];
  for (let k = 0; k < ranges.length; k += 1) {
    const range = ranges[k];
    if (!range) {
      continue;
    }
    const chunkPath = path.join(chunkDir, `chunk-${String(k).padStart(4, "0")}.mp4`);
    chunkPaths.push(chunkPath);
    // Resume: skip a chunk that already rendered (non-empty).
    if (existsSync(chunkPath) && statSync(chunkPath).size > 1024) {
      console.error(`[render-set] chunk ${k} cached — skipping`);
      continue;
    }
    console.error(`[render-set] chunk ${k} frames ${range[0]}..${range[1]} …`);
    await renderMedia({
      chromiumOptions: { gl: glRenderer() },
      codec: "h264",
      composition,
      crf: draft ? 28 : 20,
      frameRange: range,
      imageFormat: draft ? "jpeg" : "png",
      inputProps: props,
      outputLocation: chunkPath,
      serveUrl,
      timeoutInMilliseconds: 600_000,
      x264Preset: draft ? "veryfast" : "slow",
      // Full: landscape 1080p, VBV cap ~22M + bt709 (RFC §6 encode). Draft: half-res.
      ...(draft
        ? { scale: 0.5 }
        : {
            colorSpace: "bt709" as const,
            encodingBufferSize: "44M",
            encodingMaxRate: "22M",
          }),
    });
  }

  // Concat the chunks (stream copy — no re-encode, grain intact).
  const listPath = path.join(outDir, "concat.txt");
  writeFileSync(listPath, chunkPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
  const silentPath = path.join(outDir, "set.silent.mp4");
  console.error("[render-set] concat -c copy …");
  await run(FFMPEG, [
    "-v",
    "error",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c",
    "copy",
    silentPath,
  ]);

  // Mux the mastered set audio for the covered range (48k AAC), once.
  const finalPath = path.join(outDir, "set.mp4");
  const audioStartSec = coveredStartMs / 1000;
  const durSec = (coveredEndMs - coveredStartMs) / 1000;
  console.error("[render-set] final mux (48k AAC) …");
  await run(FFMPEG, [
    "-v",
    "error",
    "-y",
    "-i",
    silentPath,
    "-ss",
    String(audioStartSec),
    "-t",
    String(durSec),
    "-i",
    setAudioPath,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-b:a",
    "256k",
    "-shortest",
    finalPath,
  ]);
  return finalPath;
}

// ---------------------------------------------------------------------------
// QA hooks
// ---------------------------------------------------------------------------

type SetQa = {
  /** The strobe gate — a HARD gate at any length (a real strobe is unsafe regardless). */
  flashPass: boolean;
  /** The structural-arc change (0..1) and the 20 s-tuned floor. */
  arcChange: number | null;
  arcFloor: number | null;
  /**
   * The arc gate is ADVISORY at chapter length, not a blocker: it is calibrated for
   * a 20 s per-track journey (depart→arrive), so a minutes-long STEADY-STATE chapter
   * of one vehicle can read below the structural floor while being visibly alive (it
   * floods/churns — brightness + density — without structurally reorganizing). Judge
   * the piece off the StudioEnvelope + a visual review; see calibration/verdicts.json.
   */
  arcBelowFloor: boolean;
  raw: string;
};

/**
 * Run the arc/flash gate (analyze-motion) on the piece and classify it for the SET
 * context: flash HARD, arc ADVISORY. `--allow-flash` is never passed (the strobe
 * gate stays live) — but a below-floor arc does not fail the render.
 */
function judgeMetrics(video: string): SetQa {
  const script = path.resolve(import.meta.dirname, "../pipeline/analyze-motion.ts");
  const res = spawnSync("bun", [script, video, "--json"], { encoding: "utf8" });
  const raw = (res.stdout ?? "") + (res.stderr ?? "");
  let flashPass = res.status === 0;
  let arcChange: number | null = null;
  let arcFloor: number | null = null;
  try {
    const start = raw.indexOf("{");
    const parsed = JSON.parse(raw.slice(start)) as {
      arc?: { wholeClipChange?: number; floor?: number };
      flashSafety?: { unsafe?: boolean; verdict?: string };
    };
    arcChange = parsed.arc?.wholeClipChange ?? null;
    arcFloor = parsed.arc?.floor ?? null;
    if (parsed.flashSafety?.unsafe !== undefined) {
      flashPass = !parsed.flashSafety.unsafe;
    }
  } catch {
    // Fall back to the exit-code read above (which also trips on the advisory arc).
  }
  return {
    arcBelowFloor: arcChange !== null && arcFloor !== null && arcChange < arcFloor,
    arcChange,
    arcFloor,
    flashPass,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Fixtures + set audio
// ---------------------------------------------------------------------------

function loadAnchors(mixtapeLogId: string): Anchor[] {
  const file = path.join(FIXTURES, `${mixtapeLogId}.anchors.json`);
  const raw = JSON.parse(readFileSync(file, "utf8")) as { logId: string; bestMs: number }[];
  return raw.map((r) => ({ bestMs: r.bestMs, logId: r.logId }));
}

/** The mastered set audio URL — sliced on the fly by ffmpeg (R2 supports range seek). */
function setAudioSource(mixtapeLogId: string): string {
  return `${MEDIA_BASE}/${encodeURIComponent(mixtapeLogId)}/mixtape.m4a`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, {
    "chunk-sec": "number",
    draft: "boolean",
    "from-fixtures": "boolean",
    pilot: "string",
    stills: "number",
    workers: "number",
  });
  const mixtapeLogId = parsed.positionals[0];
  if (!mixtapeLogId) {
    console.error(
      "usage: render-set <mixtapeLogId> [--pilot <logId>] [--draft] [--from-fixtures] [--chunk-sec N] [--stills N]",
    );
    process.exit(1);
  }
  const draft = parsed.flags.draft;
  const pilotLogId = parsed.flags.pilot?.trim();
  const chunkSec = parsed.flags["chunk-sec"] ?? (draft ? 45 : 40);
  const stills = parsed.flags.stills ?? 6;

  const outDir = path.join(SET_OUT_ROOT, mixtapeLogId + (pilotLogId ? `.pilot-${pilotLogId}` : ""));
  mkdirSync(outDir, { recursive: true });
  const setAudio = setAudioSource(mixtapeLogId);
  const anchors = loadAnchors(mixtapeLogId);

  // Build the chapter plan. Pilot mode narrows to a single chapter (with the true
  // neighbouring mix-ins so the chapter length is real).
  const setDurationMs = probeDurationMs(setAudio) || anchors[anchors.length - 1]?.bestMs || 0;
  let plan = buildChapterPlan(anchors, setDurationMs);
  if (pilotLogId) {
    const idx = plan.findIndex((c) => c.logId === pilotLogId);
    if (idx < 0) {
      throw new Error(`--pilot ${pilotLogId} not in the plan for ${mixtapeLogId}`);
    }
    const only = plan[idx];
    if (only) {
      plan = [only];
    }
  }
  console.error(
    `[render-set] plan: ${plan.length} chapter(s) — ${plan.map((c) => `${c.logId}[${Math.round(c.startMs / 1000)}-${Math.round(c.endMs / 1000)}s]`).join(", ")}`,
  );

  // Assemble every chapter (prep + slice-analyze).
  const assembled: AssembledChapter[] = [];
  for (let i = 0; i < plan.length; i += 1) {
    const entry = plan[i];
    if (!entry) {
      continue;
    }
    console.error(`[render-set] assembling ${entry.logId} …`);
    assembled.push(await assembleChapter(entry, setAudio, i === plan.length - 1 && !pilotLogId));
  }

  // The dreamer's-continuity trajectory: the whole-set energy envelope for full
  // renders; for a pilot chapter, derive it from the chapter's own energy so the
  // vignette still breathes (no need to decode the whole 87MB master).
  let continuity: SetCompositionProps["continuity"];
  if (pilotLogId) {
    const ch = assembled[0];
    const energy = (ch?.spec.props.audio.energyCurve ?? []).map((s) => s.energy);
    continuity = { energy, hopMs: 20 };
  } else {
    console.error("[render-set] analyzing the set envelope (dreamer's continuity) …");
    const env = await analyzeSet(setAudio);
    continuity = { energy: env.energy, hopMs: env.hopMs };
  }

  const chapters = assembled.map((a) => a.spec);
  const props: SetCompositionProps = {
    chapters,
    continuity,
    fps: FPS,
    hideOverlay: true,
    mixtape: { logId: mixtapeLogId, title: `Fluncle Mixtape ${mixtapeLogId}` },
  };

  // Persist the prep reports + the set manifest (the audit trail).
  writeFileSync(
    path.join(outDir, "prep-report.json"),
    JSON.stringify({ chapters: assembled.map((a) => a.report), mixtapeLogId }, null, 2),
  );

  const coveredStartMs = chapters[0]?.startMs ?? 0;
  const coveredEndMs =
    (chapters[chapters.length - 1]?.startMs ?? 0) +
    (chapters[chapters.length - 1]?.durationMs ?? 0);

  const finalPath = await renderSet({
    chunkSec,
    coveredEndMs,
    coveredStartMs,
    draft,
    outDir,
    props,
    setAudioPath: setAudio,
  });

  // Stills across the piece (visual proof: alive, no freeze, Log-ID moment, landscape).
  const stillsDir = path.join(outDir, "stills");
  mkdirSync(stillsDir, { recursive: true });
  const durMs = coveredEndMs - coveredStartMs;
  for (let s = 0; s < stills; s += 1) {
    const at = (durMs / 1000) * ((s + 0.5) / stills);
    await run(FFMPEG, [
      "-v",
      "error",
      "-y",
      "-ss",
      String(at),
      "-i",
      finalPath,
      "-frames:v",
      "1",
      "-q:v",
      "3",
      path.join(stillsDir, `still-${String(s).padStart(2, "0")}-${Math.round(at)}s.jpg`),
    ]);
  }

  // QA: the strobe gate is HARD (a real strobe is unsafe at any length); the
  // structural-arc gate is ADVISORY at chapter length (calibrated for a 20 s
  // journey — a steady-state chapter can read below the floor while visibly alive).
  const qa = judgeMetrics(finalPath);
  writeFileSync(path.join(outDir, "qa.json"), qa.raw);
  const arcLine =
    qa.arcChange === null
      ? "arc: unavailable"
      : `arc (advisory): change ${qa.arcChange.toFixed(3)} vs 20s floor ${qa.arcFloor ?? "?"}${
          qa.arcBelowFloor
            ? " — below the 20s floor; expected for a steady-state chapter, judge the piece off the StudioEnvelope + a visual review"
            : ""
        }`;
  console.error(
    `\n[render-set] done → ${finalPath}\n[render-set] stills → ${stillsDir}\n[render-set] flash gate (HARD): ${qa.flashPass ? "PASS" : "FAIL — see qa.json"}\n[render-set] ${arcLine}`,
  );
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[render-set] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
