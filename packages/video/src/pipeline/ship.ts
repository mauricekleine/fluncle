// Package a rendered track video into an uploadable bundle keyed by Log ID:
//
//   out/<log-id>/
//     footage.mp4   (with audio — the QA cut + web preview; copied from the render)
//     footage-silent.mp4 (audio-less — the TikTok manual sound-attach cut)
//     poster.jpg    (a late/drop frame ~80% in)
//     note.txt      (the fixed-template caption)
//     composition.tsx — exact temporary Remotion composition source used
//     props.json    — analyzed props: beat grid, energy/bass curves, palette
//     render.json   — composition id + rerender pointers
//
// Usage: bun src/pipeline/ship.ts <trackId|log-id>
// Requires the render to exist already (out/<trackId>.mp4) — run social-preview
// first if it doesn't. Upload the bundle with `fluncle admin track video`.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildCaption, type CaptionTrack, fetchReleaseYear, yearFromReleaseDate } from "./caption";

const OUT_DIR = path.resolve(import.meta.dirname, "../../out");
const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

const input = process.argv[2];
if (!input) {
  console.error("usage: bun src/pipeline/ship.ts <trackId|log-id> [--vehicle <tag>]");
  process.exit(1);
}

// The travelling vehicle tag (e.g. "voronoi cellular"), written into render.json
// so the upload step records it as the diversity ledger entry. Falls back to any
// `vehicle` already in the render manifest.
const vehicleFlagIndex = process.argv.indexOf("--vehicle");
const vehicleArg =
  vehicleFlagIndex >= 0 ? process.argv[vehicleFlagIndex + 1]?.trim() || undefined : undefined;

const log = (message: string) => console.error(`[ship] ${message}`);

// 1. Resolve the track (id or log-id → canonical trackId + metadata).
const get = spawnSync("fluncle", ["track", "get", input, "--json"]);
let track: CaptionTrack & { trackId: string };
try {
  const parsed = JSON.parse(get.stdout.toString()) as { ok: boolean; track?: typeof track };
  if (!parsed.ok || !parsed.track) {
    throw new Error(get.stdout.toString().slice(0, 200));
  }
  track = parsed.track;
} catch (error) {
  console.error(
    `[ship] track get failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

if (!track.logId) {
  console.error(`[ship] ${track.trackId} has no Log ID — every video needs a coordinate. Stop.`);
  process.exit(1);
}

// 2. The render must already exist (renders are slow; keep ship fast + idempotent).
const reviewSrc = path.join(OUT_DIR, `${track.trackId}.mp4`);
if (!existsSync(reviewSrc)) {
  console.error(
    `[ship] no render at ${reviewSrc} — run: bun src/pipeline/social-preview.ts ${track.trackId}`,
  );
  process.exit(1);
}

// 3. Assemble the bundle under out/<log-id>/.
const bundle = path.join(OUT_DIR, track.logId);
mkdirSync(bundle, { recursive: true });

const footage = path.join(bundle, "footage.mp4");
const footageSilent = path.join(bundle, "footage-silent.mp4");
const poster = path.join(bundle, "poster.jpg");
const notePath = path.join(bundle, "note.txt");
const compositionPath = path.join(bundle, "composition.tsx");
const propsOutPath = path.join(bundle, "props.json");
const renderOutPath = path.join(bundle, "render.json");

log("footage.mp4 (with audio)");
copyFileSync(reviewSrc, footage);

log("footage-silent.mp4 (audio-less, remux)");
const silent = spawnSync("ffmpeg", ["-y", "-i", footage, "-c", "copy", "-an", footageSilent], {
  stdio: ["ignore", "ignore", "ignore"],
});
if (silent.status !== 0) {
  console.error("[ship] ffmpeg failed creating the silent cut");
  process.exit(1);
}

log("poster.jpg (~80% in)");
const durProbe = spawnSync("ffprobe", [
  "-v",
  "error",
  "-show_entries",
  "format=duration",
  "-of",
  "csv=p=0",
  footage,
]);
const duration = Number.parseFloat(durProbe.stdout.toString().trim()) || 20;
spawnSync(
  "ffmpeg",
  ["-y", "-ss", String(duration * 0.8), "-i", footage, "-frames:v", "1", "-q:v", "3", poster],
  { stdio: ["ignore", "ignore", "ignore"] },
);

log("note.txt");
// Prefer the stored release_date (from track get); fall back to Deezer for any
// track not yet backfilled.
const year = yearFromReleaseDate(track.releaseDate) ?? (await fetchReleaseYear(track.isrc));
const note = buildCaption(track, year);
writeFileSync(notePath, note);

const propsPath = path.join(OUT_DIR, `${track.trackId}.props.json`);
if (existsSync(propsPath)) {
  log("props.json (analyzed audio + palette)");
  copyFileSync(propsPath, propsOutPath);
}

const renderManifestPath = path.join(OUT_DIR, `${track.trackId}.render.json`);
let renderManifest: {
  compositionId?: string;
  compositionSource?: string;
  props?: string;
  vehicle?: string;
} = {};

if (existsSync(renderManifestPath)) {
  try {
    renderManifest = JSON.parse(readFileSync(renderManifestPath, "utf8")) as typeof renderManifest;
  } catch {
    renderManifest = {};
  }
}

const sourcePath =
  typeof renderManifest.compositionSource === "string"
    ? path.resolve(PACKAGE_ROOT, renderManifest.compositionSource)
    : undefined;

if (sourcePath && existsSync(sourcePath)) {
  if (path.resolve(sourcePath) === path.resolve(compositionPath)) {
    log("composition.tsx already bundled");
  } else {
    log("composition.tsx (render source)");
    copyFileSync(sourcePath, compositionPath);
  }
} else {
  log("composition.tsx skipped (no render manifest/source found)");
}

log("render.json");
writeFileSync(
  renderOutPath,
  JSON.stringify(
    {
      compositionId: renderManifest.compositionId ?? null,
      compositionSource: existsSync(compositionPath) ? "composition.tsx" : null,
      props: existsSync(propsOutPath) ? "props.json" : null,
      trackId: track.trackId,
      // The diversity-ledger entry: the upload endpoint reads this and stores it
      // as the track's video_vehicle (surfaced in /api/tracks for the next agent).
      vehicle: vehicleArg ?? renderManifest.vehicle ?? null,
    },
    null,
    2,
  ),
);

console.error(`\n[ship] bundle ready → out/${track.logId}/`);
console.error(
  `[ship] upload with: fluncle admin track video ${track.logId} --dir packages/video/out/${track.logId}\n`,
);
console.log(note);
