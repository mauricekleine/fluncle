// Bundle + render a registered composition to an mp4 via Remotion SSR.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";

import { type NostalgicCosmosProps } from "../remotion/types";
import { glRenderer } from "./gl";

const ENTRY_POINT = path.resolve(import.meta.dirname, "../remotion/index.ts");
// Everything a bundle can depend on lives under src/ (pipeline + remotion,
// including the gitignored workbench/ compositions root.tsx auto-registers).
const SRC_DIR = path.resolve(import.meta.dirname, "..");
// A stable on-disk location (gitignored) bundle() writes each distinct source
// tree's output to, keyed by content hash — see resolveBundle() below.
const BUNDLE_CACHE_ROOT = path.resolve(import.meta.dirname, "../../.cache/remotion-bundle");
// The webpack output always includes this; its presence is the on-disk
// cache-hit marker (a directory that exists but never finished bundling —
// e.g. a killed process — will not have it, so the next call re-bundles).
const BUNDLE_MARKER_FILE = "index.html";

export type RenderResult = {
  outputPath: string;
  compositionId: string;
};

/**
 * A stable hash of every file under src/ (relative path + mtime + size) —
 * the input Remotion's webpack bundle is a pure function of. Any source edit
 * (including a workbench/ composition drop-in) changes the hash, so a stale
 * bundle is never reused; correctness comes first, caching is opportunistic.
 */
function hashSourceTree(dir: string): string {
  const hash = createHash("sha256");
  const files: string[] = [];

  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  };
  walk(dir);
  files.sort();

  for (const file of files) {
    const stat = statSync(file);
    hash.update(path.relative(dir, file));
    hash.update(String(stat.mtimeMs));
    hash.update(String(stat.size));
  }

  return hash.digest("hex").slice(0, 16);
}

/**
 * Bundle once per DISTINCT source tree, reused across process invocations via
 * an on-disk cache keyed on hashSourceTree(), and once per PROCESS via this
 * in-memory promise — the stills -> draft -> full render ladder within one
 * `ship`/`social-preview` run pays the bundle cost at most once either way.
 *
 * bundle()'s own webpack cache (`enableCaching`, on by default) speeds up a
 * changed-source rebuild; this hash gate is the correctness backstop that
 * skips calling bundle() entirely on an unchanged source tree, which the
 * webpack cache alone does not guarantee to make free (it still re-emits to a
 * fresh temp dir unless outDir is stable — hence outDir: cacheDir below).
 */
let bundlePromise: Promise<string> | undefined;

async function resolveBundle(): Promise<string> {
  const hash = hashSourceTree(SRC_DIR);
  const cacheDir = path.join(BUNDLE_CACHE_ROOT, hash);
  const marker = path.join(cacheDir, BUNDLE_MARKER_FILE);

  if (existsSync(marker)) {
    console.error(`[render] bundle cache hit (${hash})`);
    return cacheDir;
  }

  console.error(`[render] bundle cache miss (${hash}) — bundling`);
  const serveUrl = await bundle({
    entryPoint: ENTRY_POINT,
    outDir: cacheDir,
    webpackOverride: (config) => config,
  });

  // Prune stale hash dirs (best-effort) so an active edit loop doesn't grow
  // the cache unboundedly — only the current hash's bundle is worth keeping.
  try {
    for (const name of readdirSync(BUNDLE_CACHE_ROOT)) {
      if (name !== hash) {
        rmSync(path.join(BUNDLE_CACHE_ROOT, name), { force: true, recursive: true });
      }
    }
  } catch {
    // BUNDLE_CACHE_ROOT not created yet, or a race with another process —
    // pruning is opportunistic, never load-bearing.
  }

  return serveUrl;
}

function getBundle(): Promise<string> {
  bundlePromise ??= resolveBundle();
  return bundlePromise;
}

/**
 * Render the composition with the given inputProps to `outputPath` (h264 mp4).
 * Audio is carried by the composition via props.audio.file + staticFile().
 */
export async function render(
  inputProps: NostalgicCosmosProps,
  outputPath: string,
  compositionId: string,
  options: { draft?: boolean } = {},
): Promise<RenderResult> {
  // Draft mode: a fast, NON-SHIPPABLE proof for checking direction + motion +
  // reactivity before the slow ship render. It changes only levers that DON'T
  // affect timing/reactivity — half resolution (the GLSL shader + bloom are
  // per-pixel, so ~4× fewer pixels is the big win), a fast x264 preset, jpeg
  // intermediates, a looser crf, and no VBV cap (size is irrelevant for a
  // throwaway). fps is NOT touched — it's exactly what a motion check needs, and
  // the beat-pull gate runs fine on a draft. The draft cannot show whether the
  // load-bearing grain reads or blocks (half-res + jpeg hide it), so the ship
  // path below keeps its tuned settings untouched.
  const draft = options.draft ?? false;

  const serveUrl = await getBundle();

  const composition = await selectComposition({
    // GPU shaders need a real GL context: ANGLE (Metal) locally, swangle (software)
    // on a GPU-less host — driven by FLUNCLE_GL, matching remotion.config.ts.
    chromiumOptions: { gl: glRenderer() },
    id: compositionId,
    inputProps,
    serveUrl,
    // The eager Oxanium load is a delayRender; under several concurrent renders
    // (a batch of agents) the machine oversubscribes and the default ~28s window
    // trips. Give font load room — it's I/O wait, not compute. Swangle (GPU-less
    // software GL) runs slower than a real GPU; 300s covers the worst case.
    timeoutInMilliseconds: 300_000,
  });

  await renderMedia({
    chromiumOptions: { gl: glRenderer() },
    codec: "h264",
    composition,
    // These scenes are GLSL shaders over film grain — high entropy h264 can't
    // dedupe, so grain saturates whatever bitrate it's given. crf 31 was blocky
    // (mushy grain, banding in the gradients); uncapped crf 20 fixed the look but
    // ballooned a 20s clip to ~200MB. The size lever for this content isn't crf,
    // it's a VBV CAP: encodingMaxRate bounds the peak the grain can spend, so the
    // file size is predictable regardless of how busy the frame is.
    //
    // 32 Mbit/s × 20s ≈ 80MB — comfortably under the 100MB ceiling that unlocks
    // Cloudflare Media Transformations (the on-the-fly web rendition off the R2
    // master). lossless PNG intermediates stay (JPEG baked banding in BEFORE the
    // h264 pass). crf is the quality target under the cap; both crf and the cap
    // are first-pass values to A/B-verify by eye on the next render batch (grain
    // is load-bearing — the Light-Years Rule — so the cap can't go so low it
    // re-introduces blocking). DRAFT loosens crf and drops the cap (size is
    // irrelevant for a throwaway).
    crf: draft ? 28 : 23,
    imageFormat: draft ? "jpeg" : "png",
    inputProps,
    outputLocation: outputPath,
    serveUrl,
    // Same delayRender headroom as selectComposition (see above) — concurrent
    // batch renders oversubscribe and the default font-load window trips.
    // 300s covers the swangle (software GL) worst case.
    timeoutInMilliseconds: 300_000,
    x264Preset: draft ? "veryfast" : "slow",
    // Ship adds two things draft skips (draft is a throwaway proof): the VBV cap
    // that keeps the master under 100MB, and explicit bt709 colour. bt709 is
    // verified-applied (output is yuv420p limited-range, not the old full-range
    // yuvj420p default of 4.0.x) and removes a silent brightness/colour drift vs
    // what TikTok/YouTube assume on re-encode — which also shifts how the grain
    // reads. NOTE on grain: Remotion exposes only crf + x264Preset (no x264
    // `tune`/custom params — `overrideFfmpegCommand` is discouraged AND doesn't
    // reach the per-chunk video encode; verified: spliced params don't take), so
    // grain preservation here is bounded by crf + this cap. The grain SMEAR seen
    // on the phase-1 clips came from a lossy-on-lossy TRANSCODE under-bitting the
    // grain, NOT from this render path — restore it by RE-RENDERING from source
    // (clean PNG → x264), never by re-transcoding.
    ...(draft
      ? { scale: 0.5 }
      : { colorSpace: "bt709" as const, encodingBufferSize: "64M", encodingMaxRate: "32M" }),
  });

  return { compositionId: composition.id, outputPath };
}
