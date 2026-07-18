// Package a rendered track video into an uploadable two-master bundle keyed by
// Log ID:
//
//   out/<log-id>/
//     footage.mp4        (square 1920×1920, audio, CLEAN — the crop source master;
//                         MT crops it to portrait/landscape + strips audio on demand)
//     footage.social.mp4 (portrait 1080×1920, audio, BAKED TEXT — the playable
//                         social cut: Stories, YouTube as-is, TikTok via audio=false MT)
//     footage.landscape.mp4        (optional — the clean landscape escape hatch,
//                                   packaged only if out/<trackId>.notext.landscape.mp4 exists)
//     footage.landscape.social.mp4 (optional — a baked-text landscape cut, if rendered)
//     footage.notext.mp4           (optional — a clean portrait cut, if rendered)
//     poster.jpg          (a late/drop frame ~80% in)
//     cover.jpg           (the profile-grid cover: loud centered identity over art)
//     note.txt            (the fixed-template caption)
//     composition.tsx — exact temporary Remotion composition source used
//     props.json    — analyzed props: beat grid, energy/bass curves, palette
//     render.json   — composition id + rerender pointers + the diversity-ledger
//                     entries (vehicle/grain/model/reasoning/register)
//
// Usage: bun src/pipeline/ship.ts <trackId|log-id> [--vehicle <tag>] [--grain <family>] [--model <provider/model>] [--reasoning <level>] [--register <abstract|representational|framed>]
// Requires the PORTRAIT render to exist already (out/<trackId>.mp4) — run
// social-preview first if it doesn't. The SQUARE crop source (out/<trackId>.square.mp4)
// is rendered here in-process from the same composition + props if it's missing
// (one composition, two renders). Any extra variant renders present at
// out/<trackId>{.notext,.landscape,.notext.landscape}.mp4 (see EXTRA_VARIANT_SOURCES)
// are packaged too. Upload the bundle with `fluncle admin track video`.
//
// Side effects run only when this file is the process entrypoint (import.meta.main) —
// importing ship.ts (e.g. from a test) is side-effect-free. The pure bundle-
// assembly logic (resolveBundlePaths, buildRenderJson, buildNoteText,
// EXTRA_VARIANT_SOURCES) is exported and covered by ship.test.ts.

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
import { type PaletteSummary, summarizePalette } from "./palette-summary";
import { renderCover } from "./render-cover";
import { buildScene, locateFragmentLiteral, resolveGlslBody, type ScenePalette } from "./scene";
import {
  classifyShaderStructure,
  labelWithStructure,
  type StructureManifest,
  toStructureManifest,
} from "./shader-structure";

const OUT_DIR = path.resolve(import.meta.dirname, "../../out");
const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

// The authoring AI model (<provider>/<model>) and reasoning effort, written into
// render.json alongside the vehicle so the upload step records the full
// diversity-ledger entry. Fall back to any value already in the render manifest.
const DEFAULT_VIDEO_MODEL = "anthropic/claude-opus-4-8";
const DEFAULT_VIDEO_REASONING = "high";

// The register — the third diversity-ledger axis (composition style), written
// into render.json beside vehicle/grain. A missing register WARNS loudly but
// never fails the ship (a parallel apps/web PR consumes it from render.json).
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
  /**
   * Delete the shipped track's cached preview audio (public/<trackId>.m4a) after
   * packaging. OFF by default — ship KEEPS the audio so a re-render (which re-bundles
   * on any src/ edit) still finds it and never 404s (the bounded cache is already
   * capped by sweepPreviewAudioCache in social-preview). Opt in for a clean public/.
   */
  pruneAudio: boolean;
};

/** Parse + validate ship's CLI flags. Throws (with the usage string) on a bad invocation. */
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
    // The plate-lane subject KIND (hull / ruin / flora / creature / terrain /
    // threshold …) — recorded in render.json when a plate render ships, so
    // judge:diversity can rotate the subject kind the way it rotates everything
    // else. Free text by design (the kinds are a vocabulary, not an enum).
    plateSubject: parsed.flags["plate-subject"]?.trim().toLowerCase() || undefined,
    pruneAudio: parsed.flags["prune-audio"],
    reasoning: parsed.flags.reasoning?.trim() || undefined,
    register: registerRaw as ShipRegister | undefined,
    trackInput,
    vehicle: parsed.flags.vehicle?.trim() || undefined,
  };
}

/**
 * Resolve the track (id or log-id → canonical trackId + metadata) via the
 * `fluncle` CLI. Throws with the spawn error, exit status, and stderr — never
 * silently swallows a broken/missing binary.
 */
export function resolveTrack(input: string): CaptionTrack & { trackId: string } {
  const result = spawnSync(fluncleBin(), ["tracks", "get", input, "--json"], {
    encoding: "utf8",
    env: fluncleSpawnEnv(),
  });

  if (result.error) {
    throw new Error(`fluncle track get failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    throw new Error(
      `fluncle track get exited with ${result.status ?? "unknown"}${stderr ? `\n${stderr.slice(-2000)}` : ""}`,
    );
  }

  let parsed: { ok: boolean; track?: CaptionTrack & { trackId: string } };
  try {
    parsed = JSON.parse(result.stdout) as typeof parsed;
  } catch (error) {
    throw new Error(
      `fluncle track get returned invalid JSON: ${error instanceof Error ? error.message : String(error)}\n${result.stdout.slice(0, 200)}`,
    );
  }
  if (!parsed.ok || !parsed.track) {
    throw new Error(`fluncle track get failed: ${result.stdout.slice(0, 200)}`);
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
  notePath: string;
  poster: string;
  propsOutPath: string;
  renderOutPath: string;
  sceneOutPath: string;
};

/** The file list: every path inside a bundle, joined once so writers can't drift. */
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
    notePath: path.join(bundle, "note.txt"),
    poster: path.join(bundle, "poster.jpg"),
    propsOutPath: path.join(bundle, "props.json"),
    renderOutPath: path.join(bundle, "render.json"),
    sceneOutPath: path.join(bundle, "scene.json"),
  };
}

// The re-renderable-source contract: the bundle files that MUST exist after a ship
// or the bundle is a PARTIAL (footage with no re-renderable source), the exact shape
// the CLI upload guard also enforces. ship copies props.json only when the analyzed
// props exist and composition.tsx only when the render manifest resolves a source, so
// a missing input would otherwise ship a silently-incomplete bundle — this asserts
// against that. Keyed by BundlePaths so writers and the check can't drift.
export const RERENDER_CONTRACT_KEYS: ReadonlyArray<keyof BundlePaths> = [
  "compositionPath",
  "propsOutPath",
  "renderOutPath",
];

/** The contract files missing from an assembled bundle (basenames). Pure over an
 *  existence predicate so ship.test.ts can exercise it without touching the fs. */
export function missingContractFiles(paths: BundlePaths, exists: (p: string) => boolean): string[] {
  return RERENDER_CONTRACT_KEYS.filter((key) => !exists(paths[key])).map((key) =>
    path.basename(paths[key]),
  );
}

type ExtraVariantMasterFlag = "footageLandscape" | "footageLandscapeSocial" | "footageNotext";

export type ExtraVariantSource = {
  /** The suffix social-preview.ts writes: out/<trackId><suffix>.mp4. */
  suffix: string;
  /** The buildVariants() master flag this maps to. */
  masterFlag: ExtraVariantMasterFlag;
  /** The resolveBundlePaths() key holding this variant's bundle destination. */
  pathKey: ExtraVariantMasterFlag;
};

/**
 * The extra (non-default) variant renders ship packages when present — closing
 * the "no ship pointer / no R2 key scheme yet" thread social-preview.ts used to
 * leave open. Each entry's `suffix` is exactly the variantSuffix social-preview
 * computes from `--no-overlay`/`--aspect landscape`; `.notext.landscape` is the
 * documented clean-landscape escape hatch (docs/video-variants.md "The
 * square-crop quality dial") — footage.mp4 (square, clean) already covers the
 * plain `.notext`/`.square` cases via MT crop once a finding is squared, so
 * only these three combinations are worth a stored file.
 */
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
  /** The coarse palette HUE-BUCKET tag (palette-summary.ts) — the recorded palette
   *  provenance the finalize path stores as video_palette and the axis assigner reads to
   *  steer the next render off the worn hue. Null when no palette could be derived. */
  palette: string | null;
  /** Up to three dominant hex swatches — the bundle's human-readable palette receipt. */
  paletteSwatches: string[];
  /** The plate-lane subject KIND when a plate render ships (hull / ruin / flora /
   *  creature / terrain / threshold …); null on abstract/procedural renders. */
  plateSubject: string | null;
  reasoning: string;
  register: string | null;
  /** The structural family the resolved shader body classifies to (the CHECKED
   *  diversity axis, beside the free-text vehicle NAME). Null when the body could
   *  not be resolved/classified — a warn, never a ship blocker. */
  structure: StructureManifest | null;
  trackId: string;
  variants: ReturnType<typeof buildVariants>;
  vehicle: string | null;
};

/** The bundle render.json build: pure, so a change to its shape is testable without fs. */
export function buildRenderJson(input: RenderManifestInput): Record<string, unknown> {
  return {
    compositionId: input.compositionId,
    compositionSource: input.hasCompositionFile ? "composition.tsx" : null,
    // The grain-ledger entry: the upload endpoint reads this and stores it as the
    // track's video_grain (surfaced in /api/tracks beside the vehicle).
    grain: input.grain,
    // The render-intent spine: shipped beside props (the author's file or a stub).
    intent: input.hasIntentFile ? "intent.json" : null,
    // The authoring AI model: the upload endpoint reads this and stores it as
    // the track's video_model (surfaced in /api/tracks alongside the vehicle).
    model: input.model,
    // The PALETTE-ledger entry (docs/planning/homogenisation-evidence.md — the axis that
    // was invisible when four consecutive renders shared one amber palette): the coarse
    // hue-bucket tag the finalize path stores as video_palette, so the axis assigner can
    // steer the next render off the worn hue. Null when no palette was derivable.
    palette: input.palette,
    // The dominant hex swatches behind the bucket — the human-readable receipt in the
    // bundle (never stored on the row; the bucket tag is what the ledger carries).
    paletteSwatches: input.paletteSwatches,
    // The plate-lane subject-kind ledger entry: judge:diversity reads it (from the
    // local bundle or the public render.json) and WARNs on a same-kind repeat
    // inside the recent window, so plate subjects rotate like every other axis.
    // Null on plate-less renders.
    plateSubject: input.plateSubject,
    props: input.hasPropsFile ? "props.json" : null,
    // The authoring model's reasoning effort: the upload endpoint reads this and
    // stores it as the track's video_model_reasoning (surfaced in /api/tracks).
    reasoning: input.reasoning,
    // The third diversity-ledger axis (composition style): abstract /
    // representational / framed. Null when unset — a warn, not a ship blocker.
    register: input.register,
    // The STRUCTURAL diversity axis: the family the resolved shader body classifies
    // to (cellular / flow / caustic / filament / lattice / radial / metaball / other).
    // The vehicle NAME is free poetic identity; this is the checked claim the gate
    // reads so creatively-named repeats (three voronoi worlds under three names) can't
    // slip through. Null when the body couldn't be resolved — a warn, not a blocker.
    structure: input.structure,
    trackId: input.trackId,
    // The per-master render-flag provenance: ship produces the two-master
    // bundle plus any extra variants it found on disk, so a future "clean
    // re-render from source" reproduces the right cut per output.
    variants: input.variants,
    // The diversity-ledger entry: the upload endpoint reads this and stores it
    // as the track's video_vehicle (surfaced in /api/tracks for the next agent).
    vehicle: input.vehicle,
  };
}

/** Read the bundle's props.json and summarize its palette into a hue-bucket tag +
 *  swatches, or null when the props file is absent/unparseable or carries no palette.
 *  Best-effort by contract — never throws, so ship never fails on palette provenance. */
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

/** The note.txt build: the fixed-template caption for this track + release year. */
export function buildNoteText(track: CaptionTrack, year: number | null): string {
  return buildCaption(track, year);
}

/**
 * The square crop source's cache key: the fingerprint of everything the square
 * render is a pure function of — the bundle (src/ + public/, the same trees the
 * render bundle cache keys on), the composition id, and the props the portrait
 * rendered from. ship stamps this into a sidecar (`<trackId>.square.mp4.hash`)
 * beside the cached square; a re-ship recomputes it and reuses the cached square
 * ONLY when it still matches. A portrait re-render (a new composition shifts the
 * bundle hash, re-analyzed audio shifts the props) shifts this fingerprint, so the
 * now-stale square is re-rendered rather than silently shipped beside a diverged
 * portrait. The artifact twin of render.ts's bundle-hash correctness gate.
 *
 * NUL separators between the three inputs keep them from bleeding across the
 * boundary (comp "MyComp" + props "X" can't collide with comp "MyCom" + props "pX").
 */
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

/**
 * Whether a cached square can be reused. A MISSING sidecar (cachedHash === null)
 * means the square was produced outside a ship render — a direct
 * `social-preview --aspect square` (the documented escape hatch) or one rendered
 * before this cache existed — so trust it, never force a wasteful re-render that
 * could clobber a deliberate manual square. Only a sidecar that EXISTS and
 * MISMATCHES marks a square stale (the ship → portrait-re-render → re-ship
 * divergence trap), so ship re-renders it.
 */
export function shouldReuseSquare(currentHash: string, cachedHash: string | null): boolean {
  return cachedHash === null || cachedHash === currentHash;
}

async function main(argv: string[]): Promise<void> {
  const flags = parseShipArgs(argv);
  const log = (message: string) => console.error(`[ship] ${message}`);

  // 1. Resolve the track.
  const track = resolveTrack(flags.trackInput);

  if (!track.logId) {
    throw new Error(`${track.trackId} has no Log ID — every video needs a coordinate. Stop.`);
  }

  // 2. The render must already exist (renders are slow; keep ship fast + idempotent).
  const reviewSrc = path.join(OUT_DIR, `${track.trackId}.mp4`);
  if (!existsSync(reviewSrc)) {
    // A draft is a half-res/jpeg proof with the load-bearing grain hidden — it must
    // never reach R2. If only a draft exists, say so explicitly.
    if (existsSync(path.join(OUT_DIR, `${track.trackId}.draft.mp4`))) {
      throw new Error(
        `only a DRAFT render exists (${track.trackId}.draft.mp4). Drafts are half-res/jpeg proofs and are NOT shippable — run a full render first: bun src/pipeline/social-preview.ts ${track.trackId} --composition <Id>`,
      );
    }
    throw new Error(
      `no render at ${reviewSrc} — run: bun src/pipeline/social-preview.ts ${track.trackId}`,
    );
  }

  // 3. Assemble the bundle under out/<log-id>/.
  const paths = resolveBundlePaths(OUT_DIR, track.logId);
  mkdirSync(paths.bundle, { recursive: true });

  // The render manifest (composition id + the props the portrait master rendered
  // from) is read up front: the square crop source re-renders that same
  // composition + props with aspect=square, hideOverlay=true.
  const renderManifestPath = path.join(OUT_DIR, `${track.trackId}.render.json`);
  let renderManifest: {
    compositionId?: string;
    compositionSource?: string;
    grain?: string;
    model?: string;
    plateSubject?: string;
    props?: string;
    reasoning?: string;
    register?: string;
    vehicle?: string;
  } = {};

  if (existsSync(renderManifestPath)) {
    try {
      renderManifest = JSON.parse(
        readFileSync(renderManifestPath, "utf8"),
      ) as typeof renderManifest;
    } catch (error) {
      log(`render.json ignored: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // footage.social.mp4 — the portrait, text, audio social cut: exactly today's
  // review render (out/<trackId>.mp4). It is the playable cut for Stories, YouTube,
  // and (audio-stripped via MT) TikTok.
  log("footage.social.mp4 (portrait, text, audio — the social cut)");
  copyFileSync(reviewSrc, paths.footageSocial);

  // footage.mp4 — the SQUARE crop source: 1920×1920, audio, CLEAN (no overlay). MT
  // centre-crops it to portrait/landscape on the fly, so this is the one stored
  // orientation master. Re-render it from the same composition + props with
  // aspect=square + hideOverlay; cache it at out/<trackId>.square.mp4 so a re-ship
  // is fast and idempotent.
  //
  // The cache is FINGERPRINTED (squareInputsHash → the `.square.mp4.hash` sidecar):
  // a plain "reuse if the file exists" check let a stale square survive a portrait
  // RE-render (a new composition), shipping two DIVERGED masters. ship now stamps
  // the inputs' fingerprint when it renders the square and re-renders whenever the
  // sidecar mismatches — the artifact twin of render.ts's bundle-hash gate (#307).
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
  // Reuse the cached square when it exists AND either we can't fingerprint the
  // inputs (no composition id / no props → can't re-render either; ship what's
  // there and let the re-render-contract check below catch a truly broken bundle)
  // or the sidecar still matches (see shouldReuseSquare for the missing-sidecar
  // escape-hatch rule).
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

    // Stamp the sidecar with the fingerprint of the inputs this square rendered
    // from, so the next ship trusts it — and, on any input change, invalidates it.
    writeFileSync(
      squareHashPath,
      squareInputsHash({
        bundleHash: bundleInputsHash(),
        compositionId: renderManifest.compositionId,
        propsSource,
      }),
    );
  }
  copyFileSync(squareSrc, paths.footage);

  let posterMissing = false;
  log("poster.jpg (~80% in)");
  const durProbe = spawnSync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    paths.footage,
  ]);
  const duration = Number.parseFloat(durProbe.stdout.toString().trim()) || 20;
  // Capture stderr so a failing render is a DIAGNOSIS, not silence. poster.jpg is
  // not in the re-render contract (it's a derived thumbnail the diversity/calibrate
  // gates read from the public host), so — like cover.jpg, intent.json, and scene.json
  // below — a failure WARNS and is surfaced in the ship summary rather than failing
  // the ship. Previously this ran with stdio all-ignored and no status check, so a
  // silent ffmpeg failure shipped a posterless bundle that read as "ready".
  const posterResult = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-ss",
      String(duration * 0.8),
      "-i",
      paths.footage,
      "-frames:v",
      "1",
      "-q:v",
      "3",
      paths.poster,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  if (posterResult.status !== 0 || !existsSync(paths.poster)) {
    const stderr = posterResult.stderr?.toString().trim();
    const reason = posterResult.error
      ? posterResult.error.message
      : `ffmpeg exited ${posterResult.status ?? "unknown"}${stderr ? `\n${stderr.slice(-1000)}` : ""}`;
    log(`WARNING: poster.jpg render FAILED — the bundle ships without a poster. ${reason}`);
    posterMissing = true;
  }

  log("note.txt");
  // Prefer the stored release_date (from track get); fall back to Deezer for any
  // track not yet backfilled.
  const year = yearFromReleaseDate(track.releaseDate) ?? (await fetchReleaseYear(track.isrc));
  const note = buildNoteText(track, year);
  writeFileSync(paths.notePath, note);

  const propsPath = path.join(OUT_DIR, `${track.trackId}.props.json`);
  if (existsSync(propsPath)) {
    log("props.json (analyzed audio + palette)");
    copyFileSync(propsPath, paths.propsOutPath);
  }

  // intent.json — the render-intent spine. The author writes out/<trackId>.intent.json
  // at concept time; copy it into the bundle. v1 warn-and-stub: a missing intent is a
  // WARNING, not a ship blocker — write a generated stub so the bundle always carries
  // one and the metrics/judge never hit a missing-file path.
  const intentPath = path.join(OUT_DIR, `${track.trackId}.intent.json`);
  if (existsSync(intentPath)) {
    log("intent.json (render-intent spine)");
    copyFileSync(intentPath, paths.intentOutPath);
  } else {
    log("intent.json MISSING — shipping a generated stub (the author declared no intent)");
    writeFileSync(
      paths.intentOutPath,
      JSON.stringify(generateIntentStub(track.trackId, track.logId), null, 2),
    );
  }

  // cover.jpg — the profile-grid cover (loud, centered identity over a clean late
  // frame). Needs props.json in the bundle; the operator AirDrops it to Photos and
  // sets it as the post's cover. Render failure is non-fatal — the rest of the
  // bundle still ships.
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

  // Extra variants: package whichever landscape/notext cuts a prior social-preview
  // run produced (see EXTRA_VARIANT_SOURCES). Never fabricated — only what's on disk.
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

  const register = flags.register ?? (renderManifest.register as ShipRegister | undefined) ?? null;
  if (!register) {
    log(
      "WARNING: no --register set (flag or render manifest) — the diversity ledger's third axis is unset for this ship. Pass --register <abstract|representational|framed>.",
    );
  }

  // Classify the STRUCTURAL family from the RESOLVED shader body — the diversity axis
  // the vehicle name can't carry. Best-effort by contract: any hiccup (no composition
  // source, an unresolvable interpolation, a classifier throw) WARNS and omits the
  // block — ship NEVER fails because structural classification stumbled.
  const vehicle = flags.vehicle ?? renderManifest.vehicle ?? null;
  let structure: StructureManifest | null = null;
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

  // Palette provenance: summarize the render's derived palette (social-preview's
  // paletteMix, in props.json) into a coarse hue-bucket tag + dominant swatches. Best-
  // effort — a missing/unparseable props palette leaves it null, exactly like structure.
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

  // scene.json — the fluncle.scene/1 replay manifest (RFC Unit S). The offline/live
  // hosts re-run the RESOLVED body from this file with no composition module in
  // reach. Emission is best-effort by contract: a hiccup (no composition source, an
  // unresolvable interpolation, a missing gate report) WARNS and skips the file —
  // ship NEVER fails because scene emission stumbled.
  try {
    if (existsSync(paths.compositionPath)) {
      const source = readFileSync(paths.compositionPath, "utf8");

      // Palette + grain from props (the finding's identity) — the four stops the
      // host feeds u_palette, dark→light.
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
          log(`scene palette fell back: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // Fold the ship-time gate verdicts from the metrics report (if analyze-motion
      // ran). Absent → `cleared` reads `unknown`, never a failure.
      const metricsPath = path.join(OUT_DIR, `${track.trackId}.metrics.json`);
      let metricsReport: unknown = null;
      if (existsSync(metricsPath)) {
        try {
          metricsReport = JSON.parse(readFileSync(metricsPath, "utf8"));
        } catch (error) {
          log(
            `scene cleared unresolved: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      const { scene, warnings } = buildScene({
        at: new Date().toISOString(),
        glsl: GLSL as unknown as Record<string, string>,
        grainFamily: flags.grain ?? renderManifest.grain ?? null,
        id: track.logId,
        kind: "finding",
        metricsReport,
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

  // Bundle-completeness self-check (fail loudly): ship's job is a COMPLETE,
  // re-renderable bundle. If props.json (no analyzed props) or composition.tsx (no
  // resolved render source) never got copied, the bundle would ship footage with no
  // re-renderable source and desync render.json from the DB ledger downstream. Refuse
  // to hand off a half-bundle — this is the ship-side twin of the CLI upload guard.
  const missingContract = missingContractFiles(paths, existsSync);
  if (missingContract.length > 0) {
    throw new Error(
      `bundle INCOMPLETE — the re-render contract is missing ${missingContract.join(", ")} in out/${track.logId}/. ` +
        `props.json needs out/${track.trackId}.props.json (run social-preview first) and composition.tsx needs a resolvable compositionSource in out/${track.trackId}.render.json. ` +
        `Refusing to leave a partial bundle a later \`track video\` would upload footage-only.`,
    );
  }

  // Preview audio cache: KEEP the audio by default. The Remotion bundle bakes a
  // COPY of public/ at bundle() time, so deleting public/<trackId>.m4a here left a
  // later re-render (which re-bundles on any src/ edit) baking a public/ WITHOUT the
  // audio → staticFile 404 until a manual re-download + bundle-cache clear. The
  // bounded cache is already capped by sweepPreviewAudioCache (social-preview), so
  // this delete was redundant AND load-bearing-in-the-wrong-direction. `--prune-audio`
  // opts back into an immediate clean-up when a tidy public/ is wanted.
  if (flags.pruneAudio) {
    const removedPreviewAudio = await deletePreviewAudio(track.trackId);
    if (removedPreviewAudio) {
      log(`public/${track.trackId}.m4a removed (--prune-audio)`);
    }
  }

  if (posterMissing) {
    console.error(
      `[ship] NOTE: poster.jpg is MISSING from out/${track.logId}/ — its render failed (see the WARNING above). The bundle is otherwise complete; re-run ship or render the poster before the diversity/calibrate gates need it.`,
    );
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
