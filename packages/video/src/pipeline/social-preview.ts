// Entry point for the local social-preview pipeline.
//
//   bun src/pipeline/social-preview.ts <trackId|logId> [--skip-render] [--composition <Id>] [--composition-source <file>] [--duration-ms <10000-30000>] [--draft] [--no-overlay] [--aspect <portrait|landscape|square>] [--landscape]
//
// The positional id is a Spotify trackId or a Log ID (e.g. 004.6.0K) — the
// latter lets you re-render an older clip that's aged out of the feed window.
//
// fetch track -> resolve preview -> download + normalize -> analyze audio ->
// extract palette -> assemble inputProps -> write out/<trackId>.props.json ->
// (unless --skip-render) bundle + render out/<trackId>.mp4.

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { Vibrant } from "node-vibrant/node";

import { paletteMix } from "../remotion/palette-mix";
import { type CosmosAspect, type NostalgicCosmosProps } from "../remotion/types";
import { analyzeAudio } from "./analyze-audio";
import { readContextNote } from "./context-note";
import { downloadPreview } from "./download-preview";
import { fetchTrack } from "./fetch-track";
import { resolveArchivedPreview } from "./resolve-archived-preview";
import { resolvePreview } from "./resolve-preview";

const OUT_DIR = path.resolve(import.meta.dirname, "../../out");
const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const REMOTION_DIR = path.resolve(import.meta.dirname, "../remotion");

/** Stable, deterministic 32-bit hash of a string -> non-negative integer seed. */
function stableSeed(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

async function extractSwatches(artworkUrl: string | undefined): Promise<string[]> {
  if (!artworkUrl) {
    return [];
  }
  try {
    const palette = await Vibrant.from(artworkUrl).getPalette();
    return Object.values(palette)
      .filter((sw): sw is NonNullable<typeof sw> => sw != null)
      .sort((a, b) => b.population - a.population)
      .map((sw) => sw.hex);
  } catch {
    return [];
  }
}

function findCompositionSource(compositionId: string): string | undefined {
  // The composition id IS its workbench filename (root.tsx auto-registers
  // `workbench/<id>.tsx`). That deterministic path is the source.
  const workbenchPath = path.join(REMOTION_DIR, "workbench", `${compositionId}.tsx`);
  if (existsSync(workbenchPath)) {
    return workbenchPath;
  }
  return undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const skipRender = args.includes("--skip-render");
  // --draft renders a fast, half-res, NON-SHIPPABLE proof (out/<trackId>.draft.mp4)
  // for checking direction + motion + reactivity (and running the beat-pull gate)
  // before the slow ship render. See render.ts.
  const draft = args.includes("--draft");
  // --composition <Id> selects a registered composition. The video agent authors
  // a temporary per-track composition and renders it through this flag.
  const compositionFlagIndex = args.indexOf("--composition");
  const compositionId = compositionFlagIndex >= 0 ? args[compositionFlagIndex + 1] : undefined;
  // --composition-source <file> records the exact source used for the render so
  // ship can package it as out/<log-id>/composition.tsx and upload it to R2.
  const compositionSourceFlagIndex = args.indexOf("--composition-source");
  const compositionSource =
    compositionSourceFlagIndex >= 0 ? args[compositionSourceFlagIndex + 1] : undefined;
  // --duration-ms lets the agent pick the clip length from the waveform (end on
  // a drop or just before a transition); 20s default, clamped to the contract.
  const durationFlagIndex = args.indexOf("--duration-ms");
  const durationMs = durationFlagIndex >= 0 ? Number(args[durationFlagIndex + 1]) : undefined;
  // --no-overlay renders the text-free cut (radio.fluncle.com): the scene shader
  // with NO baked-in TypePlate/CloseCard, so a host UI can draw its own metadata
  // over clean footage. Threaded as props.hideOverlay (gated inside the
  // primitives via getInputProps, so no composition edit is needed).
  const hideOverlay = args.includes("--no-overlay");
  // --aspect <portrait|landscape|square> (or the --landscape shorthand) selects
  // the output dimensions. Portrait (1080×1920) stays the default; landscape
  // (1920×1080) is the radio full-screen cut; square (1920×1920) is the clean
  // source master MT crops to either orientation on the fly — the 9:16 shaders
  // reflow under landscape/square.
  const aspectFlagIndex = args.indexOf("--aspect");
  const aspectArg = aspectFlagIndex >= 0 ? args[aspectFlagIndex + 1] : undefined;
  const aspect: CosmosAspect =
    args.includes("--landscape") || aspectArg === "landscape"
      ? "landscape"
      : aspectArg === "square"
        ? "square"
        : "portrait";
  const valueIndexes = new Set(
    [
      compositionFlagIndex + 1,
      compositionSourceFlagIndex + 1,
      durationFlagIndex + 1,
      aspectFlagIndex + 1,
    ].filter((i) => i > 0),
  );
  const trackId = args.find((a, index) => !a.startsWith("--") && !valueIndexes.has(index));
  if (
    !trackId ||
    (compositionFlagIndex >= 0 && !compositionId) ||
    (compositionSourceFlagIndex >= 0 && !compositionSource) ||
    (aspectFlagIndex >= 0 &&
      aspectArg !== "portrait" &&
      aspectArg !== "landscape" &&
      aspectArg !== "square") ||
    (durationFlagIndex >= 0 &&
      (!Number.isFinite(durationMs) || (durationMs ?? 0) < 10_000 || (durationMs ?? 0) > 30_000))
  ) {
    throw new Error(
      "usage: bun src/pipeline/social-preview.ts <trackId|logId> [--skip-render] [--composition <Id>] [--composition-source <file>] [--duration-ms <10000-30000>] [--draft] [--no-overlay] [--aspect <portrait|landscape|square>] [--landscape]",
    );
  }

  if (!skipRender && !compositionId) {
    throw new Error(
      "[social-preview] rendering now requires --composition <Id>; generated compositions are shipped as output artifacts, not kept in the codebase",
    );
  }

  await mkdir(OUT_DIR, { recursive: true });

  console.log(`[social-preview] fetching track ${trackId}`);
  const track = await fetchTrack(trackId);
  console.log(`[social-preview] track: "${track.title}" by ${track.artists.join(", ")}`);

  // Surface the finding's distilled context_note as CREATIVE FUEL (direction only,
  // NEVER on-screen text — on-screen facts stay Spotify-sourced). The note is
  // internal (admin-gated), so we read it via the CLI exactly as the observe sweep
  // does (`fluncle admin tracks context <id> --json`, no re-fetch). Best-effort:
  // a missing CLI or an un-context'd finding degrades to no fuel, like `features`.
  const context = readContextNote(track.logId ?? trackId);
  if (context) {
    track.contextNote = context.contextNote;
    track.texture = context.texture;
    console.log(
      `[social-preview] context note: ${context.contextNote.length} chars` +
        (context.texture.length > 0 ? `, texture: ${context.texture.join(", ")}` : ""),
    );
  } else {
    console.log(`[social-preview] no context note on file (creative fuel: features only)`);
  }

  console.log(`[social-preview] resolving preview`);
  // Prefer the R2 analysis archive (region-independent — the render-host path); fall
  // back to the live search (region-gated) when there is no archive or no admin
  // token in env (local dev). The live search is ISRC-FIRST: the finding's ISRC
  // names the EXACT recording, so we pass it through and resolve Deezer by ISRC
  // before any fuzzy artist+title search (which can pick the wrong recording — the
  // original for a remix). See resolve-archived-preview.ts + resolve-preview.ts.
  const preview =
    (await resolveArchivedPreview(track.logId ?? trackId)) ??
    (await resolvePreview({ artists: track.artists, isrc: track.isrc, title: track.title }));
  if (!preview) {
    throw new Error(
      `[social-preview] no confident preview found for "${track.title}" by ${track.artists.join(", ")}`,
    );
  }
  console.log(`[social-preview] preview: ${preview.source} (confidence ${preview.confidence})`);

  console.log(`[social-preview] downloading + normalizing`);
  const downloaded = await downloadPreview(preview.url, trackId);
  console.log(`[social-preview] m4a -> ${downloaded.m4aPath}`);

  let audio;
  try {
    console.log(`[social-preview] analyzing audio`);
    audio = await analyzeAudio(downloaded.wavPath, downloaded.file, durationMs ?? undefined);
  } finally {
    await rm(downloaded.tmpDir, { force: true, recursive: true });
  }

  console.log(`[social-preview] extracting palette`);
  const swatches = await extractSwatches(track.artworkUrl);
  const palette = paletteMix(swatches);

  const inputProps: NostalgicCosmosProps = {
    audio,
    palette,
    seed: stableSeed(trackId),
    track,
    // Variant flags are written only when non-default so a normal portrait/overlay
    // render produces the same props.json it always has.
    ...(hideOverlay ? { hideOverlay: true } : {}),
    ...(aspect !== "portrait" ? { aspect } : {}),
  };

  // Variant renders write to suffixed files so they never clobber the canonical
  // `<trackId>.{props.json,mp4}` portrait+overlay master that ship reads. `.notext`
  // for the text-free cut, `.landscape` for the 16:9 cut, `.square` for the
  // 1:1 crop source (combinable). An empty suffix is the unchanged default path.
  const aspectSuffix = aspect === "landscape" ? ".landscape" : aspect === "square" ? ".square" : "";
  const variantSuffix = `${hideOverlay ? ".notext" : ""}${aspectSuffix}`;
  const isVariant = variantSuffix.length > 0;

  const propsPath = path.join(OUT_DIR, `${trackId}${variantSuffix}.props.json`);
  await writeFile(propsPath, JSON.stringify(inputProps, null, 2));
  console.log(`[social-preview] props -> ${propsPath}`);

  // Summary + assertions.
  const summary = {
    accent: palette.accent,
    artists: track.artists,
    bassSamples: audio.bassCurve.length,
    beatCount: audio.beatGrid.length,
    bpm: audio.bpm,
    bpmConfidence: audio.bpmConfidence,
    confidence: preview.confidence,
    downbeatCount: audio.downbeats?.length ?? 0,
    dropMs: audio.dropMs,
    durationMs: audio.durationMs,
    energySamples: audio.energyCurve.length,
    glow: palette.glow,
    midSamples: audio.midCurve.length,
    onsetCount: audio.onsets.length,
    previewSource: preview.source,
    startMs: audio.startMs,
    swatchCount: palette.swatches.length,
    title: track.title,
    trackId,
    trebleSamples: audio.trebleCurve.length,
  };
  console.log(`[social-preview] summary:\n${JSON.stringify(summary, null, 2)}`);

  // The BPM is HONEST now (never clamped into [160,185] — the old hard fold
  // fabricated grids), so an out-of-family tempo or a weak estimate is a loud
  // WARNING to verify by ear, never a failure.
  const bpmConfidence = audio.bpmConfidence ?? 0;
  if (audio.bpm < 150 || audio.bpm > 190) {
    console.warn(
      `[social-preview] WARN: bpm ${audio.bpm} sits outside the D&B family [150,190] — the tempo is unclamped and honest, so trust the grid, but sanity-check the cut by ear before shipping.`,
    );
  }
  if (bpmConfidence < 0.3) {
    console.warn(
      `[social-preview] WARN: bpm confidence ${bpmConfidence.toFixed(3)} is low — the beat grid may be off; verify the beat lock by ear before shipping.`,
    );
  }
  if (audio.beatGrid.length <= 20) {
    throw new Error(
      `[social-preview] assertion failed: beatGrid length ${audio.beatGrid.length} <= 20`,
    );
  }
  if (audio.energyCurve.length === 0) {
    throw new Error(`[social-preview] assertion failed: energyCurve is empty`);
  }

  if (skipRender) {
    console.log(`[social-preview] --skip-render set; stopping after props json`);
    return;
  }

  if (!compositionId) {
    throw new Error("[social-preview] internal error: missing composition id for render");
  }

  const { render } = await import("./render");
  const outputPath = path.join(
    OUT_DIR,
    draft ? `${trackId}.draft.mp4` : `${trackId}${variantSuffix}.mp4`,
  );
  if (draft) {
    console.log(
      `[social-preview] DRAFT render: half-res, fast, NO VBV cap — a NON-SHIPPABLE proof for direction + motion only (run without --draft for the ship-quality master)`,
    );
  }
  console.log(`[social-preview] rendering -> ${outputPath}`);
  const result = await render(inputProps, outputPath, compositionId, { draft });

  // Silence guard: the audio HOOKS only drive visuals — the composition must
  // include <TrackAudio audio={audio} /> for the render to carry sound. Remotion
  // always muxes an aac track, so silence is invisible to a stream check; measure
  // the actual level and fail loudly if the clip is effectively silent.
  const { spawnSync } = await import("node:child_process");
  const probe = spawnSync("ffmpeg", ["-i", outputPath, "-af", "volumedetect", "-f", "null", "-"], {
    encoding: "utf8",
  });
  const meanMatch = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(probe.stderr ?? "");
  const meanVolume = meanMatch ? Number.parseFloat(meanMatch[1] ?? "") : Number.NaN;
  if (Number.isFinite(meanVolume) && meanVolume < -70) {
    throw new Error(
      `[social-preview] rendered MP4 is SILENT (mean_volume ${meanVolume} dB). The audio hooks drive visuals only — add <TrackAudio audio={audio} /> to the composition so the cut carries sound.`,
    );
  }
  console.log(`[social-preview] audio level ok (mean_volume ${meanVolume} dB)`);

  if (draft) {
    // Verify-only: no render.json manifest (that's the ship pointer). Gate the
    // draft directly — the beat-pull gate runs on any clip, half-res included.
    console.log(
      `[social-preview] DRAFT done -> ${outputPath} (NON-SHIPPABLE). Eyeball direction + motion, and gate it:\n  bun run --cwd packages/video detect-beat-pull ${path.relative(PACKAGE_ROOT, outputPath)}\nRun without --draft for the ship-quality master.`,
    );
    return;
  }

  if (isVariant) {
    // The text-free / landscape cuts are staging-only radio.fluncle.com variants:
    // no render.json (that's the ship pointer for the canonical portrait master,
    // and ship has no R2 key scheme for variants yet). Eyeball the suffixed file.
    console.log(
      `[social-preview] VARIANT done -> ${outputPath} (staging only; no ship pointer written).`,
    );
    return;
  }

  // --composition-source is forgiving about cwd: a path given as cwd-relative,
  // package-relative, or repo-root-relative all resolve. If omitted or wrong,
  // the workbench filename is the source of record.
  const resolveGivenSource = (given: string): string | undefined => {
    for (const candidate of [
      path.resolve(given),
      path.resolve(PACKAGE_ROOT, given),
      path.resolve(PACKAGE_ROOT, "..", "..", given),
    ]) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    return undefined;
  };
  const sourcePath = compositionSource
    ? (resolveGivenSource(compositionSource) ?? findCompositionSource(result.compositionId))
    : findCompositionSource(result.compositionId);
  const manifest = {
    compositionId: result.compositionId,
    compositionSource: sourcePath ? path.relative(PACKAGE_ROOT, sourcePath) : undefined,
    props: path.relative(PACKAGE_ROOT, propsPath),
    trackId,
  };
  await writeFile(path.join(OUT_DIR, `${trackId}.render.json`), JSON.stringify(manifest, null, 2));

  if (!manifest.compositionSource) {
    console.warn(
      `[social-preview] warning: could not identify source for composition ${result.compositionId}; ship will omit composition.tsx unless a render manifest is added`,
    );
  }

  console.log(`[social-preview] rendered ${result.compositionId} -> ${result.outputPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
