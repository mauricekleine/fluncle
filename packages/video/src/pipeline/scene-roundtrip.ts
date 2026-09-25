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

const TAG = "scene-roundtrip-proof";
const SOURCE_ID = `${TAG}-source`;
const HOST_ID = `${TAG}-host`;

const STOPS: [string, string, string, string] = ["#0b0a10", "#8e0a2e", "#cc5374", "#f4ead7"];

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
    writeFileSync(sourcePath, SOURCE_COMP);

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

    writeFileSync(hostPath, hostComp(JSON.stringify(scene, null, 2)));

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
