// resquare-from-props.ts — deterministic, dimensions-ONLY square re-render.
//
//   bun scripts/resquare-from-props.ts <logId> [--keep]
//
// ────────────────────────────────────────────────────────────────────────────
//  WHY THIS EXISTS
//  The original square backfill rendered squares via `social:preview`, which
//  RE-EXTRACTS the palette from the artwork (Vibrant.from(track.artworkUrl) +
//  paletteMix). That re-extraction is non-deterministic vs the original render
//  and drifted the colour (gold → crimson). The fix: never re-analyse, never
//  re-extract. Re-render straight from the finding's STORED props.json — which
//  already holds the correct original palette, audio curves, and seed — changing
//  ONLY the two pixel-level variant flags a square needs:
//     { aspect: "square", hideOverlay: true }
//  Everything else (palette, audio, seed, track) is carried through untouched,
//  so the square comes out 1920×1920 with the EXACT original colour.
// ────────────────────────────────────────────────────────────────────────────
//
// Per finding it:
//   1. Fetches found.fluncle.com/<logId>/{composition.tsx,props.json,render.json,
//      footage.social.mp4}.
//   2. Copies composition.tsx → src/remotion/workbench/<compId>.tsx so root.tsx
//      auto-registers it (compId comes from render.json).
//   3. Restores the analysed audio into public/<props.audio.file> by extracting
//      it from footage.social.mp4, so the composition's <TrackAudio>/staticFile
//      resolves and the render doesn't fail. (The final audio is muxed in step 5
//      regardless, so the render's audio handling is not load-bearing.)
//   4. Renders the registered composition with the merged props via the shared
//      ship-quality render() (same crf / VBV cap / bt709 as every other master).
//   5. Muxes the EXACT original audio from footage.social.mp4 onto the fresh
//      square video (-map 0:v -map 1:a -c:v copy -shortest) → out/<logId>/footage.mp4
//      so the square's audio is byte-for-byte the original's.
//   6. Writes out/<logId>/footage.social.mp4 (the original, untouched) and
//      out/<logId>/render.json so the bundle is ready for:
//        fluncle admin track video <logId> --footage <abs footage.mp4> \
//          --footage-social <abs footage.social.mp4> --render <abs render.json>
//
// It does NOT upload. The upload is the operator's explicit, per-track step.

import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { render } from "../src/pipeline/render";
import { type NostalgicCosmosProps } from "../src/remotion/types";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(PACKAGE_ROOT, "out");
const PUBLIC_DIR = path.join(PACKAGE_ROOT, "public");
const WORKBENCH_DIR = path.join(PACKAGE_ROOT, "src", "remotion", "workbench");
const BASE_URL = "https://found.fluncle.com";

const log = (message: string) => console.error(`[resquare] ${message}`);

async function fetchTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetch failed ${res.status} ${res.statusText}: ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
}

function run(cmd: string, args: string[]): void {
  const result = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "inherit", "pipe"] });
  if (result.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed (status ${result.status}):\n${result.stderr ?? ""}`,
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const logId = args.find((a) => !a.startsWith("--"));
  const keepWorkbench = args.includes("--keep");
  if (!logId) {
    throw new Error("usage: bun scripts/resquare-from-props.ts <logId> [--keep]");
  }

  const bundleDir = path.join(OUT_DIR, logId);
  await mkdir(bundleDir, { recursive: true });
  await mkdir(WORKBENCH_DIR, { recursive: true });
  await mkdir(PUBLIC_DIR, { recursive: true });

  const base = `${BASE_URL}/${logId}`;
  const propsRaw = path.join(bundleDir, "props.json");
  const renderRaw = path.join(bundleDir, "render.json");
  const compRaw = path.join(bundleDir, "composition.tsx");
  const socialPath = path.join(bundleDir, "footage.social.mp4");

  log(`fetching artifacts for ${logId}`);
  await Promise.all([
    fetchTo(`${base}/props.json`, propsRaw),
    fetchTo(`${base}/render.json`, renderRaw),
    fetchTo(`${base}/composition.tsx`, compRaw),
    fetchTo(`${base}/footage.social.mp4`, socialPath),
  ]);

  const renderManifest = JSON.parse(await readFile(renderRaw, "utf8")) as {
    compositionId: string;
    trackId?: string;
    vehicle?: string | null;
  };
  const compId = renderManifest.compositionId;
  if (!compId) {
    throw new Error(`render.json for ${logId} has no compositionId`);
  }

  // root.tsx auto-registers workbench/<compId>.tsx by filename.
  const workbenchFile = path.join(WORKBENCH_DIR, `${compId}.tsx`);
  await copyFile(compRaw, workbenchFile);
  log(`registered composition "${compId}" → ${path.relative(PACKAGE_ROOT, workbenchFile)}`);

  // Merge ONLY the square variant flags. Palette / audio / seed / track untouched.
  const storedProps = JSON.parse(await readFile(propsRaw, "utf8")) as NostalgicCosmosProps;
  // Schema-compat shim: older props.json files predate midCurve/trebleCurve and
  // omit those keys. The current audio-reactivity hooks read `audio.midCurve`/
  // `audio.trebleCurve` and crash on `undefined.length` (an empty array is fine —
  // the original render used empty/absent mids+trebles too). Default ONLY the
  // missing curve keys to []; this changes no colour, audio content, or motion.
  const audio = {
    ...storedProps.audio,
    midCurve: storedProps.audio.midCurve ?? [],
    trebleCurve: storedProps.audio.trebleCurve ?? [],
  };
  const squareProps: NostalgicCosmosProps = {
    ...storedProps,
    aspect: "square",
    audio,
    hideOverlay: true,
  };
  log(`palette.accent (carried through, NOT re-extracted): ${squareProps.palette.accent}`);

  // Restore the analysed audio into public/ so <TrackAudio>'s staticFile resolves
  // and the render doesn't fail. The final audio is muxed from footage.social.mp4
  // below, so this only needs to be present, not exact.
  const audioFile = squareProps.audio.file;
  const publicAudio = path.join(PUBLIC_DIR, audioFile);
  run("ffmpeg", ["-y", "-loglevel", "error", "-i", socialPath, "-vn", "-c:a", "copy", publicAudio]);
  log(`restored audio → public/${audioFile}`);

  // Render the square video (no audio muxed yet) via the shared ship render path.
  const videoOnly = path.join(bundleDir, "footage.square.video.mp4");
  log(`rendering square ${compId} → ${path.relative(PACKAGE_ROOT, videoOnly)} (this is slow)`);
  const result = await render(squareProps, videoOnly, compId);

  // Mux the EXACT original audio from footage.social.mp4 onto the square video.
  const footage = path.join(bundleDir, "footage.mp4");
  run("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-i",
    videoOnly,
    "-i",
    socialPath,
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "copy",
    // Carry the original's encoded AAC stream verbatim — the square's audio is
    // the exact original audio, not a re-encode.
    "-c:a",
    "copy",
    "-shortest",
    footage,
  ]);
  await rm(videoOnly, { force: true });
  log(`muxed original audio → ${path.relative(PACKAGE_ROOT, footage)}`);

  // Write the bundle's render.json (carry vehicle/trackId through unchanged).
  await writeFile(
    path.join(bundleDir, "render.json"),
    JSON.stringify(
      {
        compositionId: result.compositionId,
        compositionSource: "composition.tsx",
        props: "props.json",
        trackId: renderManifest.trackId,
        ...(renderManifest.vehicle != null ? { vehicle: renderManifest.vehicle } : {}),
      },
      null,
      2,
    ),
  );

  // Verify dimensions.
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0:s=x",
      footage,
    ],
    { encoding: "utf8" },
  );
  const dims = (probe.stdout ?? "").trim();
  if (dims !== "1920x1920") {
    throw new Error(`square render is ${dims}, expected 1920x1920`);
  }
  log(`square OK (${dims}).`);

  if (!keepWorkbench) {
    await rm(workbenchFile, { force: true });
    await rm(publicAudio, { force: true });
  }

  log("");
  log(`DONE ${logId}. Bundle ready:`);
  log(`  footage:        ${footage}`);
  log(`  footage-social: ${socialPath}`);
  log(`  render:         ${path.join(bundleDir, "render.json")}`);
  log("");
  log("Upload with ABSOLUTE paths:");
  log(`  export FLUNCLE_API_TOKEN=$(op read "op://Fluncle/FLUNCLE_API_TOKEN/credential")`);
  log(
    `  bun run --cwd apps/cli fluncle admin track video ${logId} --footage ${footage} --footage-social ${socialPath} --render ${path.join(bundleDir, "render.json")}`,
  );
}

main().catch((error) => {
  console.error(`[resquare] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
