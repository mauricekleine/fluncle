// Standalone scene emission — the fluncle.scene/1 replay manifest WITHOUT shipping.
//
// ship.ts is otherwise the ONLY emitter of scene.json, and ship requires a full,
// non-draft render bundle — so a PILOT (which must NOT ship) had no way to emit a
// scene.json to lint with `validate:scene` or to read `liveReady` before committing
// to a render. This wraps the SAME pure emitter (scene.ts `buildScene`) so a
// workbench composition, a bundled logId, or a bare `.tsx` source can produce a
// scene.json, touching nothing else — no render, no upload, no bundle.
//
// The emitter is reused VERBATIM; all this module owns is (1) resolving WHERE the
// composition source + palette (props) + gate report live from a target, and (2)
// writing the result. Both are exported as pure helpers so the wrapper is testable
// without a render.
//
// CLI: bun src/pipeline/emit-scene.ts <logId | workbench-comp | source.tsx> [flags]
//   --props <file>    props.json for the palette (default: auto-resolved for a bundle)
//   --metrics <file>  the gate report folded into `cleared` (default: auto-resolved)
//   --palette a,b,c,d override the four stops (background,accent,glow,ink)
//   --grain <family>  the grain family id recorded in the manifest
//   --id <id>         the scene id (default: the logId / comp filename)
//   --kind <finding|default|holding>  (default: finding)
//   --out <file>      where to write scene.json (default: beside the resolved source)
//   --json            also print the emitted scene to stdout
// Exit 0 = scene emitted, 1 = emission skipped (body unresolvable), 2 = usage/read error.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type CosmosPalette } from "../remotion/types";

import { GLSL } from "../remotion/journey/glsl";

import { parseArgs } from "./args";
import { buildScene, type Scene, type SceneKind, type ScenePalette } from "./scene";

const OUT_DIR = path.resolve(import.meta.dirname, "../../out");
const REMOTION_DIR = path.resolve(import.meta.dirname, "../remotion");

// The same warm-dark default ship falls back to when props carry no palette.
export const DEFAULT_SCENE_PALETTE: ScenePalette = ["#0b0a10", "#171611", "#8e8378", "#f4ead7"];

export type EmitTargetKind = "source-file" | "bundle" | "workbench";

export type EmitTargetPaths = {
  /** how the target was interpreted (a bare .tsx, a bundled logId, or a workbench comp). */
  targetKind: EmitTargetKind;
  /** the composition source to emit from. */
  sourcePath: string;
  /** the scene id (logId / comp filename). */
  id: string;
  kind: SceneKind;
  /** where props.json (palette) lives — auto-resolved for a bundle, else undefined. */
  propsPath?: string;
  /** where the gate report lives — auto-resolved for a bundle, else undefined. */
  metricsPath?: string;
  /** the default output path (overridable by --out). */
  outPath: string;
};

/**
 * Resolve a target (a logId, a workbench comp id, or a `.tsx` path) into the paths
 * the emitter needs. Pure given `exists` (defaults to fs `existsSync`) so the test
 * drives all three branches without touching disk. Resolution order:
 *   1. ends with `.tsx`          → a bare source file (props/metrics via flags).
 *   2. `<outDir>/<t>/composition.tsx` exists → a bundled logId (props + metrics auto-resolve).
 *   3. otherwise                 → a workbench comp `<remotionDir>/workbench/<t>.tsx`.
 */
export function resolveEmitTarget(
  target: string,
  opts: { outDir: string; remotionDir: string; exists?: (p: string) => boolean },
): EmitTargetPaths {
  const exists = opts.exists ?? existsSync;

  if (target.endsWith(".tsx")) {
    const sourcePath = path.resolve(target);
    const id = path.basename(sourcePath).replace(/\.tsx$/, "");
    return {
      id,
      kind: "finding",
      outPath: path.join(path.dirname(sourcePath), `${id}.scene.json`),
      sourcePath,
      targetKind: "source-file",
    };
  }

  const bundleSource = path.join(opts.outDir, target, "composition.tsx");
  if (exists(bundleSource)) {
    return {
      id: target,
      kind: "finding",
      metricsPath: path.join(opts.outDir, `${target}.metrics.json`),
      outPath: path.join(opts.outDir, target, "scene.json"),
      propsPath: path.join(opts.outDir, target, "props.json"),
      sourcePath: bundleSource,
      targetKind: "bundle",
    };
  }

  return {
    id: target,
    kind: "finding",
    outPath: path.join(opts.outDir, `${target}.scene.json`),
    sourcePath: path.join(opts.remotionDir, "workbench", `${target}.tsx`),
    targetKind: "workbench",
  };
}

/** Pull the four palette stops (background, accent, glow, ink) from parsed props JSON, or null. */
export function paletteFromProps(raw: unknown): ScenePalette | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const p = (raw as { palette?: Partial<CosmosPalette> }).palette;
  if (!p) {
    return null;
  }
  const { background, accent, glow, ink } = p;
  if (
    typeof background === "string" &&
    typeof accent === "string" &&
    typeof glow === "string" &&
    typeof ink === "string"
  ) {
    return [background, accent, glow, ink];
  }
  return null;
}

/** Parse a `--palette a,b,c,d` CSV into the four stops, or null when it isn't exactly four. */
export function parsePaletteFlag(csv: string | undefined): ScenePalette | null {
  if (!csv) {
    return null;
  }
  const parts = csv.split(",").map((s) => s.trim());
  if (parts.length !== 4 || parts.some((s) => s.length === 0)) {
    return null;
  }
  return [parts[0], parts[1], parts[2], parts[3]];
}

export type EmitSceneOptions = {
  outDir: string;
  remotionDir: string;
  /** override the props file (palette source). */
  propsPath?: string;
  /** override the gate report folded into `cleared`. */
  metricsPath?: string;
  /** override the four palette stops directly. */
  palette?: ScenePalette;
  /** the grain family id recorded in the manifest. */
  grainFamily?: string | null;
  /** override the scene id / kind. */
  id?: string;
  kind?: SceneKind;
  /** override the output path. */
  outPath?: string;
  /** the GLSL snippet object (defaults to the real `GLSL`; the test injects a fixture). */
  glsl?: Record<string, string>;
  /** the ISO stamp folded into `cleared.at` (deterministic given this). */
  at: string;
  /** skip writing the file (return the scene only) — the CLI writes, the test can too. */
  dryRun?: boolean;
};

export type EmitSceneResult = {
  /** the emitted scene, or null when the body was unresolvable (skipped, never a throw). */
  scene: Scene | null;
  warnings: string[];
  resolved: EmitTargetPaths;
  /** the path the scene WAS written to (null when dryRun or scene is null). */
  writtenTo: string | null;
};

/**
 * Resolve a target, read its source + palette + gate report, and run the SAME
 * `buildScene` emitter — WITHOUT shipping. Writes scene.json unless `dryRun`.
 * Degrades like ship: a missing palette/props/report falls back to a sane default
 * (with a warning); only an unresolvable shader body yields `scene: null`.
 */
export function emitScene(target: string, options: EmitSceneOptions): EmitSceneResult {
  const resolved = resolveEmitTarget(target, {
    outDir: options.outDir,
    remotionDir: options.remotionDir,
  });
  const warnings: string[] = [];

  if (!existsSync(resolved.sourcePath)) {
    return {
      resolved,
      scene: null,
      warnings: [`no composition source at ${resolved.sourcePath} (${resolved.targetKind})`],
      writtenTo: null,
    };
  }
  const source = readFileSync(resolved.sourcePath, "utf8");

  // Palette: an explicit override wins; else read the props file (the finding's
  // identity); else the warm-dark default (with a warning, exactly like ship).
  let palette = options.palette;
  if (!palette) {
    const propsPath = options.propsPath ?? resolved.propsPath;
    if (propsPath && existsSync(propsPath)) {
      try {
        const fromProps = paletteFromProps(JSON.parse(readFileSync(propsPath, "utf8")));
        if (fromProps) {
          palette = fromProps;
        } else {
          warnings.push(`props ${propsPath} carried no palette — using the warm-dark default`);
        }
      } catch (error) {
        warnings.push(
          `props ${propsPath} unreadable (${error instanceof Error ? error.message : String(error)}) — using the warm-dark default`,
        );
      }
    } else {
      warnings.push("no props palette (pass --props or --palette) — using the warm-dark default");
    }
  }

  // Gate report: fold the metrics into `cleared` when present; absent → `unknown`.
  const metricsPath = options.metricsPath ?? resolved.metricsPath;
  let metricsReport: unknown = null;
  if (metricsPath && existsSync(metricsPath)) {
    try {
      metricsReport = JSON.parse(readFileSync(metricsPath, "utf8"));
    } catch (error) {
      warnings.push(
        `metrics ${metricsPath} unreadable (${error instanceof Error ? error.message : String(error)}) — cleared stays unknown`,
      );
    }
  }

  const { scene, warnings: buildWarnings } = buildScene({
    at: options.at,
    glsl: options.glsl ?? (GLSL as unknown as Record<string, string>),
    grainFamily: options.grainFamily ?? null,
    id: options.id ?? resolved.id,
    kind: options.kind ?? resolved.kind,
    metricsReport,
    palette: palette ?? DEFAULT_SCENE_PALETTE,
    source,
  });
  warnings.push(...buildWarnings);

  if (!scene) {
    return { resolved, scene: null, warnings, writtenTo: null };
  }

  const outPath = options.outPath ?? resolved.outPath;
  if (options.dryRun) {
    return { resolved, scene, warnings, writtenTo: null };
  }
  writeFileSync(outPath, JSON.stringify(scene, null, 2));
  return { resolved, scene, warnings, writtenTo: outPath };
}

if (import.meta.main) {
  const { flags, positionals } = parseArgs(process.argv.slice(2), {
    grain: "string",
    id: "string",
    json: "boolean",
    kind: "string",
    metrics: "string",
    out: "string",
    palette: "string",
    props: "string",
  });
  const target = positionals[0];
  if (!target) {
    console.error(
      "usage: emit-scene <logId | workbench-comp | source.tsx> [--props <f>] [--metrics <f>] [--palette a,b,c,d] [--grain <family>] [--id <id>] [--kind finding|default|holding] [--out <f>] [--json]",
    );
    process.exit(2);
  }

  const kindFlag = flags.kind;
  if (kindFlag && kindFlag !== "finding" && kindFlag !== "default" && kindFlag !== "holding") {
    console.error(
      `--kind must be one of finding | default | holding (got ${JSON.stringify(kindFlag)})`,
    );
    process.exit(2);
  }

  const result = emitScene(target, {
    at: new Date().toISOString(),
    grainFamily: flags.grain ?? null,
    id: flags.id,
    kind: kindFlag as SceneKind | undefined,
    metricsPath: flags.metrics,
    outDir: OUT_DIR,
    outPath: flags.out,
    palette: parsePaletteFlag(flags.palette) ?? undefined,
    propsPath: flags.props,
    remotionDir: REMOTION_DIR,
  });

  for (const warning of result.warnings) {
    console.warn(`  ! ${warning}`);
  }

  if (!result.scene) {
    console.error(`✗ scene emission skipped (${result.resolved.targetKind}): body unresolvable`);
    process.exit(1);
  }

  if (flags.json) {
    console.log(JSON.stringify(result.scene, null, 2));
  }
  console.log(
    `✓ scene emitted → ${result.writtenTo} (${result.scene.liveReady ? "live-ready" : `replay-only: ${result.scene.liveReadyReasons.join("; ")}`})`,
  );
  console.log(`  lint it: bun run --cwd packages/video validate:scene ${result.writtenTo}`);
  process.exit(0);
}
