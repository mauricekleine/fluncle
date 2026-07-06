// Coverage for the standalone scene-emission WRAPPER (emit-scene.ts). The pure
// emitter itself (scene.ts buildScene) is covered by scene.test.ts; this locks the
// wrapper's own logic: target resolution across the three kinds, palette resolution
// (flag / props / default), and the end-to-end emit (read source + props + metrics
// → buildScene → write scene.json) WITHOUT a render or a ship.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import {
  DEFAULT_SCENE_PALETTE,
  emitScene,
  paletteFromProps,
  parsePaletteFlag,
  resolveEmitTarget,
} from "./emit-scene";
import { SCENE_SCHEMA } from "./scene";
import { validateSceneStrict } from "./validate-scene";

const OUT = "/tmp/out";
const REMOTION = "/tmp/remotion";

// A live-ready fixture body: header uniforms only, deps as bare `${GLSL.*}` refs.
const FIXTURE_SOURCE = `
const FRAG = /* glsl */ \`
\${GLSL.hash}
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec3 col = u_palette[0] * (0.5 + 0.5 * u_energy);
  gl_FragColor = vec4(col, 1.0);
}
\`;
<ShaderLayer fragmentShader={FRAG} />
`;
const FIXTURE_GLSL: Record<string, string> = {
  hash: "float hash21(vec2 p){ return fract(sin(dot(p, vec2(1.0,2.0)))*43758.5); }",
};

describe("resolveEmitTarget", () => {
  test("a .tsx path is a bare source file (id from the filename, sibling out path)", () => {
    const r = resolveEmitTarget("src/remotion/workbench/passing-hull.tsx", {
      exists: () => false,
      outDir: OUT,
      remotionDir: REMOTION,
    });
    expect(r.targetKind).toBe("source-file");
    expect(r.id).toBe("passing-hull");
    expect(r.sourcePath.endsWith("passing-hull.tsx")).toBe(true);
    expect(r.outPath.endsWith("passing-hull.scene.json")).toBe(true);
    expect(r.propsPath).toBeUndefined();
  });

  test("a logId with a bundle composition.tsx is a bundle (props + metrics auto-resolve)", () => {
    const r = resolveEmitTarget("033.0.1O", {
      exists: (p) => p === path.join(OUT, "033.0.1O", "composition.tsx"),
      outDir: OUT,
      remotionDir: REMOTION,
    });
    expect(r.targetKind).toBe("bundle");
    expect(r.id).toBe("033.0.1O");
    expect(r.sourcePath).toBe(path.join(OUT, "033.0.1O", "composition.tsx"));
    expect(r.propsPath).toBe(path.join(OUT, "033.0.1O", "props.json"));
    expect(r.metricsPath).toBe(path.join(OUT, "033.0.1O.metrics.json"));
    expect(r.outPath).toBe(path.join(OUT, "033.0.1O", "scene.json"));
  });

  test("a bare id with no bundle falls through to a workbench comp", () => {
    const r = resolveEmitTarget("passing-hull", {
      exists: () => false,
      outDir: OUT,
      remotionDir: REMOTION,
    });
    expect(r.targetKind).toBe("workbench");
    expect(r.sourcePath).toBe(path.join(REMOTION, "workbench", "passing-hull.tsx"));
    expect(r.outPath).toBe(path.join(OUT, "passing-hull.scene.json"));
    expect(r.propsPath).toBeUndefined();
  });
});

describe("paletteFromProps", () => {
  test("pulls the four stops from a props palette", () => {
    expect(
      paletteFromProps({
        palette: { accent: "#a", background: "#b", glow: "#g", ink: "#i" },
      }),
    ).toEqual(["#b", "#a", "#g", "#i"]);
  });
  test("null on a missing/partial palette", () => {
    expect(paletteFromProps({})).toBeNull();
    expect(paletteFromProps({ palette: { background: "#b" } })).toBeNull();
    expect(paletteFromProps(null)).toBeNull();
  });
});

describe("parsePaletteFlag", () => {
  test("parses exactly four comma-separated stops", () => {
    expect(parsePaletteFlag("#0b0a10,#171611,#8e8378,#f4ead7")).toEqual([
      "#0b0a10",
      "#171611",
      "#8e8378",
      "#f4ead7",
    ]);
  });
  test("null on the wrong count or an empty stop", () => {
    expect(parsePaletteFlag("#a,#b,#c")).toBeNull();
    expect(parsePaletteFlag("#a,#b,#c,#d,#e")).toBeNull();
    expect(parsePaletteFlag("#a,,#c,#d")).toBeNull();
    expect(parsePaletteFlag(undefined)).toBeNull();
  });
});

describe("emitScene (end to end, no render)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "emit-scene-"));
  afterAll(() => rmSync(dir, { force: true, recursive: true }));

  const outDir = path.join(dir, "out");
  const remotionDir = path.join(dir, "remotion");
  mkdirSync(path.join(remotionDir, "workbench"), { recursive: true });
  mkdirSync(outDir, { recursive: true });

  test("emits a scene.json from a workbench comp + explicit palette/metrics + fixture GLSL", () => {
    writeFileSync(path.join(remotionDir, "workbench", "the-passing-hull.tsx"), FIXTURE_SOURCE);
    const metricsPath = path.join(outDir, "hull.metrics.json");
    writeFileSync(
      metricsPath,
      JSON.stringify({
        arc: { verdict: "inconclusive" },
        beatPull: { beatLocked: false },
        flashSafety: { verdict: "safe" },
      }),
    );

    const result = emitScene("the-passing-hull", {
      at: "2026-07-04T00:00:00.000Z",
      glsl: FIXTURE_GLSL,
      grainFamily: "grainCoarseSilver",
      metricsPath,
      outDir,
      palette: ["#0b0a10", "#3a2b4d", "#c98a5a", "#f4ead7"],
      remotionDir,
    });

    expect(result.scene).not.toBeNull();
    expect(result.writtenTo).toBe(path.join(outDir, "the-passing-hull.scene.json"));
    expect(existsSync(result.writtenTo ?? "")).toBe(true);

    const scene = result.scene;
    if (!scene) {
      throw new Error("scene was null");
    }
    expect(scene.schema).toBe(SCENE_SCHEMA);
    expect(scene.id).toBe("the-passing-hull");
    expect(scene.kind).toBe("finding");
    expect(scene.liveReady).toBe(true); // header-uniforms-only body
    expect(scene.palette).toEqual(["#0b0a10", "#3a2b4d", "#c98a5a", "#f4ead7"]);
    expect(scene.grain.family).toBe("grainCoarseSilver");
    // the metrics folded: beat-pull + flash pass, arc inconclusive (presence-quiet path folds here)
    expect(scene.cleared.beatPull).toBe("pass");
    expect(scene.cleared.flash).toBe("pass");
    expect(scene.cleared.arc).toBe("inconclusive");

    // the written file is a STRICTLY valid fluncle.scene/1 manifest.
    const written = JSON.parse(readFileSync(result.writtenTo ?? "", "utf8"));
    expect(validateSceneStrict(written).valid).toBe(true);
  });

  test("falls back to the warm-dark default palette with a warning when no props/flag given", () => {
    writeFileSync(path.join(remotionDir, "workbench", "no-props.tsx"), FIXTURE_SOURCE);
    const result = emitScene("no-props", {
      at: "2026-07-04T00:00:00.000Z",
      dryRun: true,
      glsl: FIXTURE_GLSL,
      outDir,
      remotionDir,
    });
    expect(result.scene?.palette).toEqual(DEFAULT_SCENE_PALETTE);
    expect(result.warnings.some((w) => w.includes("warm-dark default"))).toBe(true);
    expect(result.writtenTo).toBeNull(); // dryRun writes nothing
  });

  test("scene null (skipped, never a throw) when the source has no resolvable body", () => {
    writeFileSync(path.join(remotionDir, "workbench", "no-body.tsx"), "export const x = 1;\n");
    const result = emitScene("no-body", {
      at: "2026-07-04T00:00:00.000Z",
      glsl: FIXTURE_GLSL,
      outDir,
      remotionDir,
    });
    expect(result.scene).toBeNull();
    expect(result.writtenTo).toBeNull();
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("scene null when the target resolves to a missing source", () => {
    const result = emitScene("does-not-exist", {
      at: "2026-07-04T00:00:00.000Z",
      glsl: FIXTURE_GLSL,
      outDir,
      remotionDir,
    });
    expect(result.scene).toBeNull();
    expect(result.warnings.some((w) => w.includes("no composition source"))).toBe(true);
  });
});
