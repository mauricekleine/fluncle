// The offline round-trip PROOF (RFC Unit S, proof obligation (a)): a NEW-contract
// scene rendered from its manifest must match its source composition's render.
//
// It is a SCRIPT, not a bun:test, because it needs a real GL context (ANGLE/Metal
// locally, swangle on a GPU-less host — same as every render). It:
//   1. authors a minimal, self-contained, LIVE-READY composition fixture in the
//      gitignored workbench (header uniforms only — the contract's teeth),
//   2. emits its scene.json via the production extraction path (buildScene),
//   3. authors a SceneHost wrapper fed that emitted scene,
//   4. renders a still of BOTH (frame 0) through the same bundle,
//   5. pixel-compares them: byte-identical is the strong pass; otherwise a PSNR
//      floor catches trivial encoder nondeterminism.
// The source's runtime `${GLSL.*}` template and the manifest's resolved body come
// from the SAME GLSL object, so a faithful extraction + SceneHost wiring yields
// identical pixels. A mismatch means the emitter or the host drifted.
//
// Usage: bun src/pipeline/scene-roundtrip.ts   (exit 0 = match, 1 = mismatch/error)

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

import { GLSL } from "../remotion/journey/glsl";
import { type NostalgicCosmosProps } from "../remotion/types";

import { glRenderer } from "./gl";
import { buildScene } from "./scene";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const WORKBENCH = path.resolve(import.meta.dirname, "../remotion/workbench");
const ENTRY_POINT = path.resolve(import.meta.dirname, "../remotion/index.ts");
const OUT_DIR = path.resolve(PACKAGE_ROOT, "out");

// A stable id suffix so the temp comps never collide with a real workbench drop-in.
const TAG = "scene-roundtrip-proof";
const SOURCE_ID = `${TAG}-source`;
const HOST_ID = `${TAG}-host`;

// The four palette stops both sides share (a warm-dark ground → cream).
const STOPS: [string, string, string, string] = ["#0b0a10", "#8e0a2e", "#cc5374", "#f4ead7"];

// A LIVE-READY fragment: header uniforms only, deps as bare ${GLSL.*} refs. The
// SOURCE comp's runtime template resolves these via the SAME GLSL object the
// emitter uses, so its body is byte-identical to scene.glsl.body.
const FRAG_TEMPLATE = [
  "${GLSL.hash}",
  "${GLSL.valueNoise}",
  "${GLSL.filmGrain}",
  "void main() {",
  "  vec2 uv = gl_FragCoord.xy / u_res;",
  "  float n = hash21(uv * 20.0 + u_seed);",
  "  vec3 col = mix(u_palette[0], u_palette[2], 0.5 + 0.3 * sin(u_time + uv.x * 6.0 + u_seed));",
  "  col += 0.05 * (n - 0.5);",
  "  col = filmGrain(col, uv, u_time, 0.05);",
  "  gl_FragColor = vec4(col, 1.0);",
  "}",
].join("\n");

// The source composition (a real workbench-shaped comp). ShaderLayer draws the
// header-only body; no TypePlate/CloseCard/audio file — so no staticFile load.
const SOURCE_COMP = `import { type FC } from "react";
import { AbsoluteFill } from "remotion";
import { GLSL, ShaderLayer, type NostalgicCosmosProps } from "../cosmos";

const FRAG = /* glsl */ \`
${FRAG_TEMPLATE}
\`;

const STOPS: [string, string, string, string] = ${JSON.stringify(STOPS)};

const RoundtripSource: FC<NostalgicCosmosProps> = ({ audio, seed }) => (
  <AbsoluteFill>
    <ShaderLayer
      fragmentShader={FRAG}
      paletteStops={STOPS}
      seed={seed}
      energyCurve={audio.energyCurve}
      beatGrid={audio.beatGrid}
    />
  </AbsoluteFill>
);

export default RoundtripSource;
`;

/** The host composition: SceneHost fed the emitted scene (embedded verbatim). */
function hostComp(sceneJson: string): string {
  return `import { type FC } from "react";
import { type Scene } from "../../pipeline/scene";
import { type NostalgicCosmosProps } from "../types";
import { SceneHost } from "../scene-host";

const SCENE = ${sceneJson} as unknown as Scene;

const RoundtripHost: FC<NostalgicCosmosProps> = ({ audio, seed }) => (
  <SceneHost scene={SCENE} audio={audio} seed={seed} />
);

export default RoundtripHost;
`;
}

/** A minimal props object: empty curves (audio uniforms read 0), ~3 frames. */
function minimalProps(): NostalgicCosmosProps {
  return {
    audio: {
      bassCurve: [],
      beatGrid: [],
      bpm: 174,
      durationMs: 100,
      energyCurve: [],
      file: "roundtrip.m4a",
      fluxCurve: [],
      midCurve: [],
      onsets: [],
      startMs: 0,
      trebleCurve: [],
    },
    palette: {
      accent: STOPS[1],
      background: STOPS[0],
      glow: STOPS[2],
      ink: STOPS[3],
      swatches: STOPS,
    },
    seed: 4242,
    track: {
      artists: ["Roundtrip"],
      discoveredAt: "2026-07-03T00:00:00.000Z",
      title: "Scene Roundtrip Proof",
      trackId: "roundtrip",
    },
  };
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** PSNR (dB) between two images via ffmpeg; Infinity when identical, null on failure. */
function psnr(a: string, b: string): number | null {
  const res = spawnSync("ffmpeg", ["-i", a, "-i", b, "-lavfi", "psnr", "-f", "null", "-"], {
    encoding: "utf8",
  });
  if (res.status !== 0 && !res.stderr) {
    return null;
  }
  const m = /average:(inf|\d+(?:\.\d+)?)/.exec(res.stderr ?? "");
  if (!m) {
    return null;
  }
  return m[1] === "inf" ? Infinity : Number(m[1]);
}

async function main(): Promise<void> {
  mkdirSync(WORKBENCH, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const sourcePath = path.join(WORKBENCH, `${SOURCE_ID}.tsx`);
  const hostPath = path.join(WORKBENCH, `${HOST_ID}.tsx`);
  const sourcePng = path.join(OUT_DIR, `${SOURCE_ID}.png`);
  const hostPng = path.join(OUT_DIR, `${HOST_ID}.png`);

  const cleanup = () => {
    for (const f of [sourcePath, hostPath]) {
      if (existsSync(f)) {
        rmSync(f);
      }
    }
  };

  try {
    // 1. Author the source fixture.
    writeFileSync(sourcePath, SOURCE_COMP);

    // 2. Emit its scene via the production extraction path.
    const { scene, warnings } = buildScene({
      at: "2026-07-03T00:00:00.000Z",
      glsl: GLSL as unknown as Record<string, string>,
      grainFamily: "grainFineEmulsion",
      id: "999.9.9Z",
      kind: "finding",
      metricsReport: null,
      palette: STOPS,
      source: SOURCE_COMP,
    });
    for (const w of warnings) {
      console.error(`[roundtrip] scene: ${w}`);
    }
    if (!scene) {
      throw new Error("buildScene returned no scene — the fixture failed to emit");
    }
    if (!scene.liveReady) {
      throw new Error(
        `the fixture must be LIVE-READY for the round-trip: ${scene.liveReadyReasons.join("; ")}`,
      );
    }

    // 3. Author the host wrapper fed the emitted scene.
    writeFileSync(hostPath, hostComp(JSON.stringify(scene, null, 2)));

    // 4. Bundle once (the workbench comps auto-register via root.tsx) + render both.
    console.error("[roundtrip] bundling…");
    const serveUrl = await bundle({ entryPoint: ENTRY_POINT, webpackOverride: (c) => c });
    const inputProps = minimalProps();

    for (const [id, output] of [
      [SOURCE_ID, sourcePng],
      [HOST_ID, hostPng],
    ] as const) {
      console.error(`[roundtrip] rendering ${id}…`);
      const composition = await selectComposition({
        chromiumOptions: { gl: glRenderer() },
        id,
        inputProps,
        serveUrl,
        timeoutInMilliseconds: 300_000,
      });
      await renderStill({
        chromiumOptions: { gl: glRenderer() },
        composition,
        frame: 0,
        imageFormat: "png",
        inputProps,
        output,
        serveUrl,
        timeoutInMilliseconds: 300_000,
      });
    }

    // 5. Compare.
    const sameBytes = sha256(sourcePng) === sha256(hostPng);
    if (sameBytes) {
      console.error("[roundtrip] ✓ MATCH — the manifest render is byte-identical to its source.");
      return;
    }
    const db = psnr(sourcePng, hostPng);
    if (db !== null && db >= 50) {
      console.error(
        `[roundtrip] ✓ MATCH — near-identical (PSNR ${db === Infinity ? "inf" : db.toFixed(1)} dB ≥ 50).`,
      );
      return;
    }
    throw new Error(
      `scene render DIVERGED from source (bytes differ${db !== null ? `, PSNR ${db.toFixed(1)} dB < 50` : ", PSNR unavailable"}). Compare ${sourcePng} vs ${hostPng}.`,
    );
  } finally {
    cleanup();
  }
}

if (import.meta.main) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`[roundtrip] ✗ ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
