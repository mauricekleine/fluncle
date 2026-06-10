// Entry point for the local social-preview pipeline.
//
//   bun src/pipeline/social-preview.ts <trackId> [--skip-render] [--composition <Id>] [--composition-source <file>] [--duration-ms <10000-30000>]
//
// fetch track -> resolve preview -> download + normalize -> analyze audio ->
// extract palette -> assemble inputProps -> write out/<trackId>.props.json ->
// (unless --skip-render) bundle + render out/<trackId>.mp4.

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { colors } from "@fluncle/tokens";
import { Vibrant } from "node-vibrant/node";

import { type CosmosPalette, type NostalgicCosmosProps } from "../remotion/types";
import { analyzeAudio } from "./analyze-audio";
import { downloadPreview } from "./download-preview";
import { fetchTrack } from "./fetch-track";
import { resolvePreview } from "./resolve-preview";

const OUT_DIR = path.resolve(import.meta.dirname, "../../out");
const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const REMOTION_DIR = path.resolve(import.meta.dirname, "../remotion");

// TODO: swap for `import { paletteMix } from "../remotion/primitives"` once that
// primitive exists. The fallback below keeps the same intent and signature.
type PaletteMixInput = {
  swatches: string[];
};

/** Relative luminance (0..1) of a #rrggbb hex, for swatch mud/blowout filtering. */
function hexLuma(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// The Nostalgic Cosmos canon trio — the warm, sunlit lead of every swatch set.
// Kept first so any downstream consumer that re-derives roles from `swatches`
// (warmth/chroma heuristics) still finds the sun, not the artwork's coldest hue.
const CANON_SWATCHES = [colors.eclipseGold, colors.eclipseGlow, colors.reentryRed] as const;

/**
 * The Retint Rule applied to palettes: steal the technique, recolor to canon.
 * Artwork flavors the scene; canon owns the roles. The four lit roles are law and
 * always come straight from @fluncle/tokens (the Nostalgic Cosmos canon) — never
 * from artwork — so the One Sun Rule and Warm Dark Rule hold no matter how cold a
 * cover is: `background` is always Deep Field, `accent` always Eclipse Gold,
 * `glow` always Eclipse Glow, `ink` always Starlight Cream. Artwork hues are
 * confined to `swatches`, and there only as *secondary* tints: the warm canon
 * trio leads the list, then valid artwork swatches follow (near-black/near-white
 * ones, which would read as mud or blowout against the field, are dropped). With
 * artwork missing or too thin, the canon trio stands alone.
 */
function paletteMix({ swatches }: PaletteMixInput): CosmosPalette {
  const valid = swatches.filter(
    (s) => /^#[0-9a-fA-F]{6}$/.test(s) && hexLuma(s) > 0.05 && hexLuma(s) < 0.95,
  );
  return {
    accent: colors.eclipseGold,
    background: colors.deepField,
    glow: colors.eclipseGlow,
    ink: colors.starlightCream,
    swatches: [...CANON_SWATCHES, ...valid],
  };
}

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

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(full)));
      continue;
    }

    if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }

  return files;
}

async function findCompositionSource(compositionId: string): Promise<string | undefined> {
  // New model: the composition id IS its workbench filename (root.tsx
  // auto-registers `workbench/<id>.tsx`). That deterministic path is the source.
  const workbenchPath = path.join(REMOTION_DIR, "workbench", `${compositionId}.tsx`);
  if (existsSync(workbenchPath)) {
    return workbenchPath;
  }

  // Fallback (legacy / hand-registered): scan for a file exporting the id.
  const files = await listSourceFiles(REMOTION_DIR);
  const matches: string[] = [];
  const exportConst = new RegExp(`export\\s+const\\s+${compositionId}\\b`);
  const exportFunction = new RegExp(`export\\s+function\\s+${compositionId}\\b`);

  for (const file of files) {
    const source = await readFile(file, "utf8");

    if (exportConst.test(source) || exportFunction.test(source)) {
      matches.push(file);
    }
  }

  return matches.length === 1 ? matches[0] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const skipRender = args.includes("--skip-render");
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
  const valueIndexes = new Set(
    [compositionFlagIndex + 1, compositionSourceFlagIndex + 1, durationFlagIndex + 1].filter(
      (i) => i > 0,
    ),
  );
  const trackId = args.find((a, index) => !a.startsWith("--") && !valueIndexes.has(index));
  if (
    !trackId ||
    (compositionFlagIndex >= 0 && !compositionId) ||
    (compositionSourceFlagIndex >= 0 && !compositionSource) ||
    (durationFlagIndex >= 0 &&
      (!Number.isFinite(durationMs) || durationMs! < 10_000 || durationMs! > 30_000))
  ) {
    throw new Error(
      "usage: bun src/pipeline/social-preview.ts <trackId> [--skip-render] [--composition <Id>] [--composition-source <file>] [--duration-ms <10000-30000>]",
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

  console.log(`[social-preview] resolving preview`);
  const preview = await resolvePreview({ artists: track.artists, title: track.title });
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
  const palette = paletteMix({ swatches });

  const inputProps: NostalgicCosmosProps = {
    audio,
    palette,
    seed: stableSeed(trackId),
    track,
  };

  const propsPath = path.join(OUT_DIR, `${trackId}.props.json`);
  await writeFile(propsPath, JSON.stringify(inputProps, null, 2));
  console.log(`[social-preview] props -> ${propsPath}`);

  // Summary + assertions.
  const summary = {
    accent: palette.accent,
    artists: track.artists,
    bassSamples: audio.bassCurve.length,
    beatCount: audio.beatGrid.length,
    bpm: audio.bpm,
    confidence: preview.confidence,
    durationMs: audio.durationMs,
    energySamples: audio.energyCurve.length,
    glow: palette.glow,
    onsetCount: audio.onsets.length,
    previewSource: preview.source,
    startMs: audio.startMs,
    swatchCount: palette.swatches.length,
    title: track.title,
    trackId,
  };
  console.log(`[social-preview] summary:\n${JSON.stringify(summary, null, 2)}`);

  if (audio.bpm < 160 || audio.bpm > 185) {
    throw new Error(`[social-preview] assertion failed: bpm ${audio.bpm} not in [160,185]`);
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
  const outputPath = path.join(OUT_DIR, `${trackId}.mp4`);
  console.log(`[social-preview] rendering -> ${outputPath}`);
  const result = await render(inputProps, outputPath, compositionId);

  // --composition-source is forgiving about cwd: a path given as cwd-relative,
  // package-relative, or repo-root-relative all resolve (the doubling bug was a
  // package-relative path resolved against a packages/video cwd). Falls back to
  // auto-discovery so a wrong path never silently drops composition.tsx.
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
    ? (resolveGivenSource(compositionSource) ?? (await findCompositionSource(result.compositionId)))
    : await findCompositionSource(result.compositionId);
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
