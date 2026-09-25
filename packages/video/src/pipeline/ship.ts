import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type NostalgicCosmosProps } from "../remotion/types";
import {
  buildVariants,
  FOOTAGE_FILENAME,
  FOOTAGE_LANDSCAPE_FILENAME,
  FOOTAGE_LANDSCAPE_SOCIAL_FILENAME,
  FOOTAGE_NOTEXT_FILENAME,
  FOOTAGE_SOCIAL_FILENAME,
} from "../remotion/variants";

import { GLSL } from "../remotion/journey/glsl";

import { parseArgs } from "./args";
import { bundleInputsHash } from "./bundle-hash";
import { buildCaption, type CaptionTrack, fetchReleaseYear, yearFromReleaseDate } from "./caption";
import { deletePreviewAudio } from "./download-preview";
import { fluncleBin, fluncleSpawnEnv } from "./fluncle-bin";
import { generateIntentStub } from "./intent";
import { judgePalette } from "./judge-palette";
import { type PaletteSummary, summarizePalette } from "./palette-summary";
import { renderCover } from "./render-cover";
import { buildScene, locateFragmentLiteral, resolveGlslBody, type ScenePalette } from "./scene";
import { type GateVerdict, metricsGateVerdict, paletteGateVerdict, sha256File } from "./ship-gates";
import {
  classifyShaderStructure,
  labelWithStructure,
  type StructureManifest,
  toStructureManifest,
} from "./shader-structure";

const OUT_DIR = path.resolve(import.meta.dirname, "../../out");
const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

const DEFAULT_VIDEO_MODEL = "anthropic/claude-opus-5";
const DEFAULT_VIDEO_REASONING = "high";

const REGISTERS = ["abstract", "representational", "framed"] as const;
export type ShipRegister = (typeof REGISTERS)[number];

const USAGE =
  "usage: bun src/pipeline/ship.ts <trackId|log-id> [--vehicle <tag>] [--grain <family>] [--model <provider/model>] [--reasoning <level>] [--register <abstract|representational|framed>] [--plate-subject <kind>] [--prune-audio]";

export type ShipFlags = {
  trackInput: string;
  vehicle: string | undefined;
  grain: string | undefined;
  model: string | undefined;
  reasoning: string | undefined;
  register: ShipRegister | undefined;
  plateSubject: string | undefined;

  pruneAudio: boolean;
};

export function parseShipArgs(argv: string[]): ShipFlags {
  let parsed: ReturnType<
    typeof parseArgs<{
      grain: "string";
      model: "string";
      "plate-subject": "string";
      "prune-audio": "boolean";
      reasoning: "string";
      register: "string";
      vehicle: "string";
    }>
  >;
  try {
    parsed = parseArgs(argv, {
      grain: "string",
      model: "string",
      "plate-subject": "string",
      "prune-audio": "boolean",
      reasoning: "string",
      register: "string",
      vehicle: "string",
    });
  } catch (error) {
    throw new Error(`${USAGE}\n${error instanceof Error ? error.message : String(error)}`);
  }

  const trackInput = parsed.positionals[0];
  if (!trackInput) {
    throw new Error(USAGE);
  }

  const registerRaw = parsed.flags.register?.trim();
  if (registerRaw !== undefined && !REGISTERS.includes(registerRaw as ShipRegister)) {
    throw new Error(
      `--register must be one of ${REGISTERS.join(", ")}; got "${registerRaw}"\n${USAGE}`,
    );
  }

  return {
    grain: parsed.flags.grain?.trim() || undefined,
    model: parsed.flags.model?.trim() || undefined,

    plateSubject: parsed.flags["plate-subject"]?.trim().toLowerCase() || undefined,
    pruneAudio: parsed.flags["prune-audio"],
    reasoning: parsed.flags.reasoning?.trim() || undefined,
    register: registerRaw as ShipRegister | undefined,
    trackInput,
    vehicle: parsed.flags.vehicle?.trim() || undefined,
  };
}

export function resolveTrack(input: string): CaptionTrack & { trackId: string } {
  const result = spawnSync(fluncleBin(), ["tracks", "get", input, "--json"], {
    encoding: "utf8",
    env: fluncleSpawnEnv(),
  });

  if (result.error) {
    throw new Error(`fluncle tracks get failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    throw new Error(
      `fluncle tracks get exited with ${result.status ?? "unknown"}${stderr ? `\n${stderr.slice(-2000)}` : ""}`,
    );
  }

  let parsed: { ok: boolean; track?: CaptionTrack & { trackId: string } };
  try {
    parsed = JSON.parse(result.stdout) as typeof parsed;
  } catch (error) {
    throw new Error(
      `fluncle tracks get returned invalid JSON: ${error instanceof Error ? error.message : String(error)}\n${result.stdout.slice(0, 200)}`,
    );
  }
  if (!parsed.ok || !parsed.track) {
    throw new Error(`fluncle tracks get failed: ${result.stdout.slice(0, 200)}`);
  }
  return parsed.track;
}

export type BundlePaths = {
  bundle: string;
  compositionPath: string;
  footage: string;
  footageLandscape: string;
  footageLandscapeSocial: string;
  footageNotext: string;
  footageSocial: string;
  intentOutPath: string;
  metricsOutPath: string;
  notePath: string;
  poster: string;
  propsOutPath: string;
  renderOutPath: string;
  sceneOutPath: string;
};

export function resolveBundlePaths(outDir: string, logId: string): BundlePaths {
  const bundle = path.join(outDir, logId);
  return {
    bundle,
    compositionPath: path.join(bundle, "composition.tsx"),
    footage: path.join(bundle, FOOTAGE_FILENAME),
    footageLandscape: path.join(bundle, FOOTAGE_LANDSCAPE_FILENAME),
    footageLandscapeSocial: path.join(bundle, FOOTAGE_LANDSCAPE_SOCIAL_FILENAME),
    footageNotext: path.join(bundle, FOOTAGE_NOTEXT_FILENAME),
    footageSocial: path.join(bundle, FOOTAGE_SOCIAL_FILENAME),
    intentOutPath: path.join(bundle, "intent.json"),
    metricsOutPath: path.join(bundle, "metrics.json"),
    notePath: path.join(bundle, "note.txt"),
    poster: path.join(bundle, "poster.jpg"),
    propsOutPath: path.join(bundle, "props.json"),
    renderOutPath: path.join(bundle, "render.json"),
    sceneOutPath: path.join(bundle, "scene.json"),
  };
}

export const RERENDER_CONTRACT_KEYS: ReadonlyArray<keyof BundlePaths> = [
  "compositionPath",
  "propsOutPath",
  "renderOutPath",
];

export function missingContractFiles(paths: BundlePaths, exists: (p: string) => boolean): string[] {
  return RERENDER_CONTRACT_KEYS.filter((key) => !exists(paths[key])).map((key) =>
    path.basename(paths[key]),
  );
}

type ExtraVariantMasterFlag = "footageLandscape" | "footageLandscapeSocial" | "footageNotext";

export type ExtraVariantSource = {
  suffix: string;

  masterFlag: ExtraVariantMasterFlag;

  pathKey: ExtraVariantMasterFlag;
};

export const EXTRA_VARIANT_SOURCES: ExtraVariantSource[] = [
  { masterFlag: "footageNotext", pathKey: "footageNotext", suffix: ".notext" },
  {
    masterFlag: "footageLandscapeSocial",
    pathKey: "footageLandscapeSocial",
    suffix: ".landscape",
  },
  { masterFlag: "footageLandscape", pathKey: "footageLandscape", suffix: ".notext.landscape" },
];

export type RenderManifestInput = {
  compositionId: string | null;
  grain: string | null;
  hasCompositionFile: boolean;
  hasIntentFile: boolean;
  hasPropsFile: boolean;
  model: string;

  palette: string | null;

  paletteSwatches: string[];

  plateSubject: string | null;
  reasoning: string;
  register: string | null;

  structure: StructureManifest | null;
  trackId: string;
  variants: ReturnType<typeof buildVariants>;
  vehicle: string | null;
};

export function buildRenderJson(input: RenderManifestInput): Record<string, unknown> {
  return {
    compositionId: input.compositionId,
    compositionSource: input.hasCompositionFile ? "composition.tsx" : null,

    grain: input.grain,

    intent: input.hasIntentFile ? "intent.json" : null,

    model: input.model,

    palette: input.palette,

    paletteSwatches: input.paletteSwatches,

    plateSubject: input.plateSubject,
    props: input.hasPropsFile ? "props.json" : null,

    reasoning: input.reasoning,

    register: input.register,

    structure: input.structure,
    trackId: input.trackId,

    variants: input.variants,

    vehicle: input.vehicle,
  };
}

export function readPropsPalette(
  propsPath: string,
  log: (message: string) => void,
): PaletteSummary | null {
  if (!existsSync(propsPath)) {
    return null;
  }
  try {
    const props = JSON.parse(readFileSync(propsPath, "utf8")) as NostalgicCosmosProps;
    const p = props.palette;
    if (!p) {
      return null;
    }
    return summarizePalette({
      accent: p.accent,
      background: p.background,
      glow: p.glow,
      ink: p.ink,
      swatches: p.swatches,
    });
  } catch (error) {
    log(`palette unresolved: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function buildNoteText(track: CaptionTrack, year: number | null): string {
  return buildCaption(track, year);
}

export function squareInputsHash(input: {
  bundleHash: string;
  compositionId: string;
  propsSource: string;
}): string {
  return createHash("sha256")
    .update(input.bundleHash)
    .update("\0")
    .update(input.compositionId)
    .update("\0")
    .update(input.propsSource)
    .digest("hex")
    .slice(0, 16);
}

export function shouldReuseSquare(currentHash: string, cachedHash: string | null): boolean {
  return cachedHash === null || cachedHash === currentHash;
}

type ShipRenderManifest = {
  compositionId?: string;
  compositionSource?: string;
  grain?: string;
  model?: string;
  plateSubject?: string;
  props?: string;
  reasoning?: string;
  register?: string;
  vehicle?: string;
};

function readShipRenderManifest(
  trackId: string,
  log: (message: string) => void,
): ShipRenderManifest {
  const manifestPath = path.join(OUT_DIR, `${trackId}.render.json`);
  if (!existsSync(manifestPath)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as ShipRenderManifest;
  } catch (error) {
    log(`render.json ignored: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

function renderPoster(footagePath: string, posterPath: string): string | null {
  const durProbe = spawnSync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    footagePath,
  ]);
  const duration = Number.parseFloat(durProbe.stdout.toString().trim()) || 20;
  const posterResult = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-ss",
      String(duration * 0.8),
      "-i",
      footagePath,
      "-frames:v",
      "1",
      "-q:v",
      "3",
      posterPath,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  if (posterResult.status === 0 && existsSync(posterPath)) {
    return null;
  }
  const stderr = posterResult.stderr?.toString().trim();
  return posterResult.error
    ? posterResult.error.message
    : `ffmpeg exited ${posterResult.status ?? "unknown"}${stderr ? `\n${stderr.slice(-1000)}` : ""}`;
}

function enforceMetricsGate(
  trackId: string,
  renderPath: string,
  log: (message: string) => void,
): unknown {
  const metricsPath = path.join(OUT_DIR, `${trackId}.metrics.json`);
  let record: unknown = null;
  if (existsSync(metricsPath)) {
    try {
      record = JSON.parse(readFileSync(metricsPath, "utf8")) as unknown;
    } catch {
      record = null;
    }
  }
  enforceGate(metricsGateVerdict({ record, renderSha256: sha256File(renderPath), trackId }), log);
  log("judge:metrics record: this render, hard gates passed");
  return record;
}

async function cutPosterAndEnforcePalette(
  squarePath: string,
  posterPath: string,
  logId: string,
  log: (message: string) => void,
): Promise<void> {
  const posterError = renderPoster(squarePath, posterPath);
  if (posterError !== null) {
    throw new Error(
      `REFUSED: poster.jpg could not be cut, so the palette gate cannot run. ${posterError}`,
    );
  }
  let gate: Awaited<ReturnType<typeof judgePalette>>;
  try {
    gate = await judgePalette(posterPath, { excludeLogId: logId });
  } catch (error) {
    throw new Error(
      `REFUSED: the palette gate could not run (${error instanceof Error ? error.message : String(error)}). Re-run ship once the published feed and posters are reachable.`,
    );
  }
  enforceGate(paletteGateVerdict(gate), log);
}

function enforceGate(verdict: GateVerdict, log: (message: string) => void): void {
  if (!verdict.ok) {
    throw new Error(`REFUSED: ${verdict.reason}`);
  }
  for (const note of verdict.notes) {
    log(note);
  }
}

async function packageOptionalAssets(
  track: ReturnType<typeof resolveTrack>,
  logId: string,
  paths: ReturnType<typeof resolveBundlePaths>,
  renderManifest: ReturnType<typeof readShipRenderManifest>,
  log: (message: string) => void,
): Promise<Partial<Record<ExtraVariantMasterFlag, boolean>>> {
  const propsPath = path.join(OUT_DIR, `${track.trackId}.props.json`);
  if (existsSync(propsPath)) {
    log("props.json (analyzed audio + palette)");
    copyFileSync(propsPath, paths.propsOutPath);
  }

  const intentPath = path.join(OUT_DIR, `${track.trackId}.intent.json`);
  if (existsSync(intentPath)) {
    log("intent.json (render-intent spine)");
    copyFileSync(intentPath, paths.intentOutPath);
  } else {
    log("intent.json MISSING — shipping a generated stub (the author declared no intent)");
    writeFileSync(
      paths.intentOutPath,
      JSON.stringify(generateIntentStub(track.trackId, logId), null, 2),
    );
  }

  if (existsSync(paths.propsOutPath)) {
    log("cover.jpg (profile-grid cover)");
    try {
      await renderCover([paths.bundle]);
    } catch (error) {
      log(`cover.jpg skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const sourcePath =
    typeof renderManifest.compositionSource === "string"
      ? path.resolve(PACKAGE_ROOT, renderManifest.compositionSource)
      : undefined;
  if (sourcePath && existsSync(sourcePath)) {
    if (path.resolve(sourcePath) === path.resolve(paths.compositionPath)) {
      log("composition.tsx already bundled");
    } else {
      log("composition.tsx (render source)");
      copyFileSync(sourcePath, paths.compositionPath);
    }
  } else {
    log("composition.tsx skipped (no render manifest/source found)");
  }

  const extraMasters: Partial<Record<ExtraVariantMasterFlag, boolean>> = {};
  for (const source of EXTRA_VARIANT_SOURCES) {
    const src = path.join(OUT_DIR, `${track.trackId}${source.suffix}.mp4`);
    if (existsSync(src)) {
      const dest = paths[source.pathKey];
      log(`${path.basename(dest)} (extra variant — packaging ${path.basename(src)})`);
      copyFileSync(src, dest);
      extraMasters[source.masterFlag] = true;
    }
  }
  return extraMasters;
}

async function main(argv: string[]): Promise<void> {
  const flags = parseShipArgs(argv);
  const log = (message: string) => console.error(`[ship] ${message}`);

  const track = resolveTrack(flags.trackInput);

  if (!track.logId) {
    throw new Error(`${track.trackId} has no Log ID — every video needs a coordinate. Stop.`);
  }
  const logId = track.logId;

  const reviewSrc = path.join(OUT_DIR, `${track.trackId}.mp4`);
  if (!existsSync(reviewSrc)) {
    if (existsSync(path.join(OUT_DIR, `${track.trackId}.draft.mp4`))) {
      throw new Error(
        `only a DRAFT render exists (${track.trackId}.draft.mp4). Drafts are half-res/jpeg proofs and are NOT shippable — run a full render first: bun src/pipeline/social-preview.ts ${track.trackId} --composition <Id>`,
      );
    }
    throw new Error(
      `no render at ${reviewSrc} — run: bun src/pipeline/social-preview.ts ${track.trackId}`,
    );
  }

  const metricsRecord = enforceMetricsGate(track.trackId, reviewSrc, log);

  const paths = resolveBundlePaths(OUT_DIR, track.logId);

  const renderManifest = readShipRenderManifest(track.trackId, log);

  const prepareSquareMaster = async (): Promise<string> => {
    const squareSrc = path.join(OUT_DIR, `${track.trackId}.square.mp4`);
    const squareHashPath = `${squareSrc}.hash`;
    const propsInPath = path.join(OUT_DIR, `${track.trackId}.props.json`);
    const propsSource = existsSync(propsInPath) ? readFileSync(propsInPath, "utf8") : null;

    const squareFingerprint =
      renderManifest.compositionId && propsSource !== null
        ? squareInputsHash({
            bundleHash: bundleInputsHash(),
            compositionId: renderManifest.compositionId,
            propsSource,
          })
        : null;
    const cachedSquareHash = existsSync(squareHashPath)
      ? readFileSync(squareHashPath, "utf8").trim()
      : null;

    const squareExists = existsSync(squareSrc);

    const reuseSquare =
      squareExists &&
      (squareFingerprint === null || shouldReuseSquare(squareFingerprint, cachedSquareHash));

    if (reuseSquare) {
      log(
        squareFingerprint === null
          ? "footage.mp4 (square crop source — cached render, inputs unverifiable)"
          : cachedSquareHash === null
            ? "footage.mp4 (square crop source — cached render, unfingerprinted — trusting it)"
            : "footage.mp4 (square crop source — cached render, inputs unchanged)",
      );
    } else {
      if (squareExists) {
        log(
          "footage.mp4 (square crop source — inputs changed since the cached render → re-rendering)",
        );
      }
      if (!renderManifest.compositionId || propsSource === null) {
        throw new Error(
          `cannot render the square crop source: missing ${!renderManifest.compositionId ? "composition id (out/<trackId>.render.json)" : "props (out/<trackId>.props.json)"}. Render the portrait master with social-preview first, or render the square directly:\n  bun src/pipeline/social-preview.ts ${track.trackId} --composition <Id> --aspect square --no-overlay`,
        );
      }

      log("footage.mp4 (square crop source — rendering 1920×1920, clean)");
      const portraitProps = JSON.parse(propsSource) as NostalgicCosmosProps;
      const squareProps: NostalgicCosmosProps = {
        ...portraitProps,
        aspect: "square",
        hideOverlay: true,
      };
      const { render } = await import("./render");
      await render(squareProps, squareSrc, renderManifest.compositionId);

      writeFileSync(
        squareHashPath,
        squareInputsHash({
          bundleHash: bundleInputsHash(),
          compositionId: renderManifest.compositionId,
          propsSource,
        }),
      );
    }
    return squareSrc;
  };

  const squareSrc = await prepareSquareMaster();

  log("poster.jpg (~80% in)");
  const stagedPoster = path.join(OUT_DIR, `${track.trackId}.poster.jpg`);
  await cutPosterAndEnforcePalette(squareSrc, stagedPoster, logId, log);

  mkdirSync(paths.bundle, { recursive: true });

  log("footage.social.mp4 (portrait, text, audio — the social cut)");
  copyFileSync(reviewSrc, paths.footageSocial);
  copyFileSync(squareSrc, paths.footage);
  copyFileSync(stagedPoster, paths.poster);

  log("metrics.json (the judge:metrics record that cleared this render)");
  writeFileSync(paths.metricsOutPath, JSON.stringify(metricsRecord, null, 2));

  log("note.txt");

  const year = yearFromReleaseDate(track.releaseDate) ?? (await fetchReleaseYear(track.isrc));
  const note = buildNoteText(track, year);
  writeFileSync(paths.notePath, note);

  const extraMasters = await packageOptionalAssets(track, logId, paths, renderManifest, log);

  const register = flags.register ?? (renderManifest.register as ShipRegister | undefined) ?? null;
  if (!register) {
    log(
      "WARNING: no --register set (flag or render manifest) — the diversity ledger's third axis is unset for this ship. Pass --register <abstract|representational|framed>.",
    );
  }

  const vehicle = flags.vehicle ?? renderManifest.vehicle ?? null;
  let structure: StructureManifest | null = null;
  const classifyStructure = (): void => {
    try {
      if (existsSync(paths.compositionPath)) {
        const source = readFileSync(paths.compositionPath, "utf8");
        const located = locateFragmentLiteral(source);
        if (!located.ok) {
          log(`structure unclassified: ${located.error}`);
        } else {
          const resolved = resolveGlslBody(located.raw, GLSL as unknown as Record<string, string>);
          if (!resolved.ok) {
            log(`structure unclassified: ${resolved.error}`);
          } else {
            const classification = classifyShaderStructure(resolved.body);
            structure = toStructureManifest(classification);
            const secondary = classification.secondary ? ` +${classification.secondary}` : "";
            log(
              `structure: ${labelWithStructure(vehicle, structure.dominant)}${secondary} (confidence ${structure.confidence})`,
            );
          }
        }
      } else {
        log("structure unclassified (no composition source in the bundle)");
      }
    } catch (error) {
      log(`structure unclassified: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  classifyStructure();

  const paletteSummary = readPropsPalette(paths.propsOutPath, log);
  if (paletteSummary) {
    log(`palette: ${paletteSummary.bucket} (${paletteSummary.swatches.join(" ")})`);
  } else {
    log("palette unresolved (no props palette in the bundle)");
  }

  log("render.json");
  writeFileSync(
    paths.renderOutPath,
    JSON.stringify(
      buildRenderJson({
        compositionId: renderManifest.compositionId ?? null,
        grain: flags.grain ?? renderManifest.grain ?? null,
        hasCompositionFile: existsSync(paths.compositionPath),
        hasIntentFile: existsSync(paths.intentOutPath),
        hasPropsFile: existsSync(paths.propsOutPath),
        model: flags.model ?? renderManifest.model ?? DEFAULT_VIDEO_MODEL,
        palette: paletteSummary?.bucket ?? null,
        paletteSwatches: paletteSummary?.swatches ?? [],
        plateSubject: flags.plateSubject ?? renderManifest.plateSubject ?? null,
        reasoning: flags.reasoning ?? renderManifest.reasoning ?? DEFAULT_VIDEO_REASONING,
        register,
        structure,
        trackId: track.trackId,
        variants: buildVariants({ footage: true, footageSocial: true, ...extraMasters }),
        vehicle,
      }),
      null,
      2,
    ),
  );

  const emitScene = (): void => {
    try {
      if (existsSync(paths.compositionPath)) {
        const source = readFileSync(paths.compositionPath, "utf8");

        let palette: ScenePalette = ["#0b0a10", "#171611", "#8e8378", "#f4ead7"];
        if (existsSync(paths.propsOutPath)) {
          try {
            const props = JSON.parse(
              readFileSync(paths.propsOutPath, "utf8"),
            ) as NostalgicCosmosProps;
            const p = props.palette;
            if (p) {
              palette = [p.background, p.accent, p.glow, p.ink];
            }
          } catch (error) {
            log(
              `scene palette fell back: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        const { scene, warnings } = buildScene({
          at: new Date().toISOString(),
          glsl: GLSL as unknown as Record<string, string>,
          grainFamily: flags.grain ?? renderManifest.grain ?? null,
          id: logId,
          kind: "finding",
          metricsReport: metricsRecord,
          palette,
          source,
        });
        for (const warning of warnings) {
          log(`scene: ${warning}`);
        }
        if (scene) {
          log(
            `scene.json (${scene.liveReady ? "live-ready" : "replay-only"}${scene.liveReady ? "" : `: ${scene.liveReadyReasons.join("; ")}`})`,
          );
          writeFileSync(paths.sceneOutPath, JSON.stringify(scene, null, 2));
        } else {
          log("scene.json skipped (see warnings above) — bundle ships without it");
        }
      } else {
        log("scene.json skipped (no composition source in the bundle)");
      }
    } catch (error) {
      log(
        `scene.json skipped (emission error): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  emitScene();

  const missingContract = missingContractFiles(paths, existsSync);
  if (missingContract.length > 0) {
    throw new Error(
      `bundle INCOMPLETE — the re-render contract is missing ${missingContract.join(", ")} in out/${track.logId}/. ` +
        `props.json needs out/${track.trackId}.props.json (run social-preview first) and composition.tsx needs a resolvable compositionSource in out/${track.trackId}.render.json. ` +
        `Refusing to leave a partial bundle a later \`track video\` would upload footage-only.`,
    );
  }

  if (flags.pruneAudio) {
    const removedPreviewAudio = await deletePreviewAudio(track.trackId);
    if (removedPreviewAudio) {
      log(`public/${track.trackId}.m4a removed (--prune-audio)`);
    }
  }

  console.error(`\n[ship] bundle ready → out/${track.logId}/`);
  console.error(
    `[ship] upload with: fluncle admin track video ${track.logId} --dir packages/video/out/${track.logId}\n`,
  );
  console.log(note);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[ship] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
