// Package a rendered track video into an uploadable bundle keyed by Log ID:
//
//   out/<log-id>/
//     review.mp4    (with audio — the QA cut + web preview; copied from the render)
//     social.mp4    (audio-less — the TikTok manual sound-attach cut; ffmpeg remux)
//     poster.jpg    (a late/drop frame ~80% in)
//     caption.txt   (the fixed-template caption)
//
// Usage: bun src/pipeline/ship.ts <trackId|log-id>
// Requires the render to exist already (out/<trackId>.mp4) — run social-preview
// first if it doesn't. Upload the bundle with `fluncle admin track video`.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildCaption, type CaptionTrack, fetchReleaseYear } from "./caption";

const OUT_DIR = path.resolve(import.meta.dirname, "../../out");

const input = process.argv[2];
if (!input) {
  console.error("usage: bun src/pipeline/ship.ts <trackId|log-id>");
  process.exit(1);
}

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

const review = path.join(bundle, "review.mp4");
const social = path.join(bundle, "social.mp4");
const poster = path.join(bundle, "poster.jpg");
const captionPath = path.join(bundle, "caption.txt");

log("review.mp4 (with audio)");
copyFileSync(reviewSrc, review);

log("social.mp4 (audio-less, remux)");
const silent = spawnSync("ffmpeg", ["-y", "-i", review, "-c", "copy", "-an", social], {
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
  review,
]);
const duration = Number.parseFloat(durProbe.stdout.toString().trim()) || 20;
spawnSync(
  "ffmpeg",
  ["-y", "-ss", String(duration * 0.8), "-i", review, "-frames:v", "1", "-q:v", "3", poster],
  { stdio: ["ignore", "ignore", "ignore"] },
);

log("caption.txt");
const year = await fetchReleaseYear(track.isrc);
const caption = buildCaption(track, year);
writeFileSync(captionPath, caption);

console.error(`\n[ship] bundle ready → out/${track.logId}/`);
console.error(
  `[ship] upload with: fluncle admin track video ${track.logId} --dir packages/video/out/${track.logId}\n`,
);
console.log(caption);
