import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type CosmosPalette } from "../remotion/types";

import { GLSL } from "../remotion/journey/glsl";

import { parseArgs } from "./args";
import { buildScene, type Scene, type SceneKind, type ScenePalette } from "./scene";

const OUT_DIR = path.resolve(import.meta.dirname, "../../out");
const REMOTION_DIR = path.resolve(import.meta.dirname, "../remotion");

export const DEFAULT_SCENE_PALETTE: ScenePalette = ["#0b0a10", "#171611", "#8e8378", "#f4ead7"];

export type EmitTargetKind = "source-file" | "bundle" | "workbench";

export type EmitTargetPaths = {
  targetKind: EmitTargetKind;

  sourcePath: string;

  id: string;
  kind: SceneKind;

  propsPath?: string;

  metricsPath?: string;

  outPath: string;
};

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

  propsPath?: string;

  metricsPath?: string;

  palette?: ScenePalette;

  grainFamily?: string | null;

  id?: string;
  kind?: SceneKind;

  outPath?: string;

  glsl?: Record<string, string>;

  at: string;

  dryRun?: boolean;
};

export type EmitSceneResult = {
  scene: Scene | null;
  warnings: string[];
  resolved: EmitTargetPaths;

  writtenTo: string | null;
};

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
