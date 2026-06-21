// Package a rendered track video into an uploadable two-master bundle keyed by
// Log ID (see docs/video-variants.md):
//
//   out/<log-id>/
//     footage.mp4        (square 1920×1920, audio, CLEAN — the crop source master;
//                         MT crops it to portrait/landscape + strips audio on demand)
//     footage.social.mp4 (portrait 1080×1920, audio, BAKED TEXT — the playable
//                         social cut: Stories, YouTube as-is, TikTok via audio=false MT)
//     poster.jpg         (a late/drop frame ~80% in)
//     cover.jpg          (the profile-grid cover: loud centered identity over art)
//     note.txt           (the fixed-template caption)
//     composition.tsx — exact temporary Remotion composition source used
//     props.json    — analyzed props: beat grid, energy/bass curves, palette
//     render.json   — composition id + rerender pointers
//
// Usage: bun src/pipeline/ship.ts <trackId|log-id>
// Requires the PORTRAIT render to exist already (out/<trackId>.mp4) — run
// social-preview first if it doesn't. The SQUARE crop source (out/<trackId>.square.mp4)
// is rendered here in-process from the same composition + props if it's missing
// (one composition, two renders). Upload the bundle with `fluncle admin track video`.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type NostalgicCosmosProps } from "../remotion/types";

import { buildCaption, type CaptionTrack, fetchReleaseYear, yearFromReleaseDate } from "./caption";
import { renderCover } from "./render-cover";

const OUT_DIR = path.resolve(import.meta.dirname, "../../out");
const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

const input = process.argv[2];
if (!input) {
  console.error(
    "usage: bun src/pipeline/ship.ts <trackId|log-id> [--vehicle <tag>] [--model <provider/model>] [--reasoning <level>]",
  );
  process.exit(1);
}

// The travelling vehicle tag (e.g. "voronoi cellular"), written into render.json
// so the upload step records it as the diversity ledger entry. Falls back to any
// `vehicle` already in the render manifest.
const vehicleFlagIndex = process.argv.indexOf("--vehicle");
const vehicleArg =
  vehicleFlagIndex >= 0 ? process.argv[vehicleFlagIndex + 1]?.trim() || undefined : undefined;

// The authoring AI model (<provider>/<model>), written into render.json so the
// upload step records it alongside the vehicle. Falls back to any `model` already
// in the render manifest, then to the default.
const DEFAULT_VIDEO_MODEL = "anthropic/claude-opus-4-8";
const modelFlagIndex = process.argv.indexOf("--model");
const modelArg =
  modelFlagIndex >= 0 ? process.argv[modelFlagIndex + 1]?.trim() || undefined : undefined;

// The reasoning/thinking effort the authoring model ran at (e.g. "high"), written
// into render.json so the upload step records it alongside the model. Falls back
// to any `reasoning` already in the render manifest, then to the default.
const DEFAULT_VIDEO_REASONING = "high";
const reasoningFlagIndex = process.argv.indexOf("--reasoning");
const reasoningArg =
  reasoningFlagIndex >= 0 ? process.argv[reasoningFlagIndex + 1]?.trim() || undefined : undefined;

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
  // A draft is a half-res/jpeg proof with the load-bearing grain hidden — it must
  // never reach R2. If only a draft exists, say so explicitly.
  if (existsSync(path.join(OUT_DIR, `${track.trackId}.draft.mp4`))) {
    console.error(
      `[ship] only a DRAFT render exists (${track.trackId}.draft.mp4). Drafts are half-res/jpeg proofs and are NOT shippable — run a full render first: bun src/pipeline/social-preview.ts ${track.trackId} --composition <Id>`,
    );
  } else {
    console.error(
      `[ship] no render at ${reviewSrc} — run: bun src/pipeline/social-preview.ts ${track.trackId}`,
    );
  }
  process.exit(1);
}

// 3. Assemble the bundle under out/<log-id>/.
const bundle = path.join(OUT_DIR, track.logId);
mkdirSync(bundle, { recursive: true });

const footage = path.join(bundle, "footage.mp4");
const footageSocial = path.join(bundle, "footage.social.mp4");
const poster = path.join(bundle, "poster.jpg");
const notePath = path.join(bundle, "note.txt");
const compositionPath = path.join(bundle, "composition.tsx");
const propsOutPath = path.join(bundle, "props.json");
const renderOutPath = path.join(bundle, "render.json");

// The render manifest (composition id + the props the portrait master rendered
// from) is read up front: the square crop source re-renders that same
// composition + props with aspect=square, hideOverlay=true.
const renderManifestPath = path.join(OUT_DIR, `${track.trackId}.render.json`);
let renderManifest: {
  compositionId?: string;
  compositionSource?: string;
  model?: string;
  props?: string;
  reasoning?: string;
  vehicle?: string;
} = {};

if (existsSync(renderManifestPath)) {
  try {
    renderManifest = JSON.parse(readFileSync(renderManifestPath, "utf8")) as typeof renderManifest;
  } catch (error) {
    log(`render.json ignored: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// footage.social.mp4 — the portrait, text, audio social cut: exactly today's
// review render (out/<trackId>.mp4). It is the playable cut for Stories, YouTube,
// and (audio-stripped via MT) TikTok.
log("footage.social.mp4 (portrait, text, audio — the social cut)");
copyFileSync(reviewSrc, footageSocial);

// footage.mp4 — the SQUARE crop source: 1920×1920, audio, CLEAN (no overlay). MT
// centre-crops it to portrait/landscape on the fly, so this is the one stored
// orientation master. Re-render it from the same composition + props with
// aspect=square + hideOverlay; cache it at out/<trackId>.square.mp4 so a re-ship
// is fast and idempotent.
const squareSrc = path.join(OUT_DIR, `${track.trackId}.square.mp4`);
if (existsSync(squareSrc)) {
  log("footage.mp4 (square crop source — cached render)");
} else {
  const propsInPath = path.join(OUT_DIR, `${track.trackId}.props.json`);
  if (!renderManifest.compositionId || !existsSync(propsInPath)) {
    console.error(
      `[ship] cannot render the square crop source: missing ${!renderManifest.compositionId ? "composition id (out/<trackId>.render.json)" : "props (out/<trackId>.props.json)"}. Render the portrait master with social-preview first, or render the square directly:\n  bun src/pipeline/social-preview.ts ${track.trackId} --composition <Id> --aspect square --no-overlay`,
    );
    process.exit(1);
  }

  log("footage.mp4 (square crop source — rendering 1920×1920, clean)");
  const portraitProps = JSON.parse(readFileSync(propsInPath, "utf8")) as NostalgicCosmosProps;
  const squareProps: NostalgicCosmosProps = {
    ...portraitProps,
    aspect: "square",
    hideOverlay: true,
  };
  const { render } = await import("./render");
  await render(squareProps, squareSrc, renderManifest.compositionId);
}
copyFileSync(squareSrc, footage);

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

// cover.jpg — the profile-grid cover (loud, centered identity over a clean late
// frame). Needs props.json in the bundle; the operator AirDrops it to Photos and
// sets it as the post's cover. Render failure is non-fatal — the rest of the
// bundle still ships.
if (existsSync(propsOutPath)) {
  log("cover.jpg (profile-grid cover)");
  try {
    await renderCover([bundle]);
  } catch (error) {
    log(`cover.jpg skipped: ${error instanceof Error ? error.message : String(error)}`);
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
      // The authoring AI model: the upload endpoint reads this and stores it as
      // the track's video_model (surfaced in /api/tracks alongside the vehicle).
      model: modelArg ?? renderManifest.model ?? DEFAULT_VIDEO_MODEL,
      props: existsSync(propsOutPath) ? "props.json" : null,
      // The authoring model's reasoning effort: the upload endpoint reads this and
      // stores it as the track's video_model_reasoning (surfaced in /api/tracks).
      reasoning: reasoningArg ?? renderManifest.reasoning ?? DEFAULT_VIDEO_REASONING,
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
