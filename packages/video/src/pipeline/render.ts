import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";

import { type NostalgicCosmosProps } from "../remotion/types";

import { bundleInputsHash } from "./bundle-hash";
import { glRenderer } from "./gl";

export { hashBundleInputs } from "./bundle-hash";

const ENTRY_POINT = path.resolve(import.meta.dirname, "../remotion/index.ts");

const BUNDLE_CACHE_ROOT = path.resolve(import.meta.dirname, "../../.cache/remotion-bundle");

const BUNDLE_MARKER_FILE = "index.html";

const PRUNE_STALE_MS = 6 * 60 * 60 * 1000;

export type RenderResult = {
  outputPath: string;
  compositionId: string;
};

let bundlePromise: Promise<string> | undefined;

async function resolveBundle(): Promise<string> {
  const hash = bundleInputsHash();
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

  try {
    const now = Date.now();
    for (const name of readdirSync(BUNDLE_CACHE_ROOT)) {
      if (name === hash) {
        continue;
      }
      const dir = path.join(BUNDLE_CACHE_ROOT, name);
      try {
        if (now - statSync(dir).mtimeMs < PRUNE_STALE_MS) {
          continue;
        }
      } catch {
        continue;
      }
      rmSync(dir, { force: true, recursive: true });
    }
  } catch {}

  return serveUrl;
}

function getBundle(): Promise<string> {
  bundlePromise ??= resolveBundle();
  return bundlePromise;
}

export async function render(
  inputProps: NostalgicCosmosProps,
  outputPath: string,
  compositionId: string,
  options: { draft?: boolean } = {},
): Promise<RenderResult> {
  const draft = options.draft ?? false;

  const serveUrl = await getBundle();

  const composition = await selectComposition({
    chromiumOptions: { gl: glRenderer() },
    id: compositionId,
    inputProps,
    serveUrl,

    timeoutInMilliseconds: 300_000,
  });

  await renderMedia({
    chromiumOptions: { gl: glRenderer() },
    codec: "h264",
    composition,

    crf: draft ? 28 : 23,
    imageFormat: draft ? "jpeg" : "png",
    inputProps,
    outputLocation: outputPath,
    serveUrl,

    timeoutInMilliseconds: 300_000,
    x264Preset: draft ? "veryfast" : "slow",

    ...(draft
      ? { scale: 0.5 }
      : { colorSpace: "bt709" as const, encodingBufferSize: "64M", encodingMaxRate: "32M" }),
  });

  return { compositionId: composition.id, outputPath };
}
