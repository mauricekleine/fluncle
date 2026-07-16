// Render ONE "Fluncle's Frontier" playlist cover (E2, the public recommendation
// machine) to a 640×640 JPEG. Remotion needs a real headless Chromium and does NOT run
// in a Cloudflare Worker, so the cover is a NODE-SIDE leg: this script renders the JPEG,
// and the driver (apps/web/scripts/render-frontier-covers.ts) reads it and uploads it to
// Spotify via the Worker's grant.
//
//   bun run render:frontier-cover -- --crew 42 --out /tmp/frontier-42.jpg
//   → writes a 640×640 JPEG (the FrontierCover composition stamped with crew № 42)
//
// The upload target (Spotify's playlist-image endpoint) accepts a base64 JPEG ≤256KB,
// so the JPEG bytes must stay ≤~192KB. The cover is a dark, low-detail starfield, so a
// quality-80 640² JPEG lands far under that; the size is asserted after the render so a
// future design change that blows the ceiling fails loudly rather than at upload time.

import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

const ENTRY_POINT = path.resolve(import.meta.dirname, "../remotion/index.ts");

/** Spotify's playlist-cover upload accepts a base64 JPEG ≤256KB → ~192KB of JPEG bytes. */
const MAX_JPEG_BYTES = 192 * 1024;

/** Parse `--crew <n>` / `--out <path>` from argv. */
function parseArgs(argv: string[]): { crewNumber: null | number; out: string } {
  let crewNumber: null | number = null;
  let out = "";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--crew") {
      const value = Number.parseInt(argv[index + 1] ?? "", 10);
      crewNumber = Number.isFinite(value) ? value : null;
      index += 1;
    } else if (arg === "--out") {
      out = argv[index + 1] ?? "";
      index += 1;
    }
  }

  return { crewNumber, out };
}

/** Render the FrontierCover still for one crew № to `out` (a 640×640 JPEG). */
export async function renderFrontierCoverToFile(options: {
  crewNumber: null | number;
  out: string;
}): Promise<void> {
  await mkdir(path.dirname(options.out), { recursive: true });

  const serveUrl = await bundle({
    entryPoint: ENTRY_POINT,
    webpackOverride: (config) => config,
  });
  const inputProps = { crewNumber: options.crewNumber };

  const composition = await selectComposition({
    chromiumOptions: { gl: "angle" },
    id: "FrontierCover",
    inputProps,
    serveUrl,
  });

  await renderStill({
    chromiumOptions: { gl: "angle" },
    composition,
    frame: 0,
    imageFormat: "jpeg",
    inputProps,
    jpegQuality: 80,
    output: options.out,
    serveUrl,
  });

  const { size } = await stat(options.out);

  if (size > MAX_JPEG_BYTES) {
    throw new Error(
      `frontier cover ${options.out} is ${size} bytes, over the ${MAX_JPEG_BYTES}-byte ceiling (Spotify's base64 ≤256KB cap) — lower jpegQuality or the composition detail`,
    );
  }

  console.error(`[frontier-cover] crew ${options.crewNumber ?? "-"} -> ${options.out} (${size}B)`);
}

if (import.meta.main) {
  const { crewNumber, out } = parseArgs(process.argv.slice(2));

  if (!out) {
    console.error("usage: render:frontier-cover -- --crew <n> --out <path.jpg>");
    process.exit(1);
  }

  renderFrontierCoverToFile({ crewNumber, out }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
