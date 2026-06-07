import { colors } from "@fluncle/tokens";
import { useEffect, useMemo, useRef, useState } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { hexToRgb } from "../color";
import { useBass } from "../hooks/use-bass";
import { useBeat } from "../hooks/use-beat";
import { useEnergy } from "../hooks/use-energy";
import { type CosmosPalette, type EnergySample } from "../types";

/**
 * A custom uniform value. Floats, vec2 (`[x, y]`), and vec3 (`[x, y, z]`) are
 * supported; the type is inferred from the array length (1/2/3). Booleans pass
 * as 0.0/1.0 floats. Keep these frame-derived for determinism.
 */
export type ShaderUniformValue = number | boolean | [number, number] | [number, number, number];

export type ShaderLayerProps = {
  /**
   * The fragment shader BODY as a GLSL string. ShaderLayer injects a standard
   * header before it (see HEADER below): `precision highp float;`, all the
   * audio/journey/brand uniforms, the `u_palette[4]` stops, and the `dither8`
   * banding-killer helper. Your string must declare any custom `uniform`s it
   * reads from the `uniforms` prop, then define `void main()` writing
   * `gl_FragColor`. Compose snippets from `./glsl` ahead of main().
   */
  fragmentShader: string;
  /**
   * The four palette stops fed to `u_palette[0..3]` (dark -> light ramp for the
   * Retint gradient-map). Defaults to the canon ramp: Deep Field -> Re-entry Red
   * -> Eclipse Gold -> Starlight Cream. Pass the track's CosmosPalette to bend
   * the shader to the artwork while keeping the warm-dark-to-cream shape.
   */
  palette?: Partial<CosmosPalette>;
  /** Explicit four-stop override; wins over `palette`. Hex strings, dark->light. */
  paletteStops?: [string, string, string, string];
  /** 0..1 clip progress for `u_progress`. Defaults to frame/(durationInFrames-1). */
  progress?: number;
  /** Seed for `u_seed` (a float). Defaults to 1. Derive from the track seed. */
  seed?: number;
  /** Beat grid (ms offsets) for `u_beatPulse` via useBeat. Omitted = pulse stays 0. */
  beatGrid?: number[];
  /** Exponential decay for the beat pulse (see useBeat). Default 3.2. */
  beatDecay?: number;
  /** Energy curve for `u_energy` via useEnergy. Omitted = u_energy stays 0. */
  energyCurve?: EnergySample[];
  /** Bass curve for `u_bass` via useBass. Omitted = u_bass stays 0. */
  bassCurve?: EnergySample[];
  /**
   * Custom uniforms keyed by name (without the `u_` you choose your own names),
   * each a float / vec2 / vec3. Declare matching `uniform`s in your shader. Set
   * per frame; keep values frame-derived so renders stay deterministic.
   */
  uniforms?: Record<string, ShaderUniformValue>;
  /** Canvas/layer opacity 0..1. Default 1. */
  opacity?: number;
  /** Blend mode of the layer over its parent. Default "normal". */
  blendMode?: React.CSSProperties["mixBlendMode"];
};

// The standard header injected ahead of every fragmentShader body. Anything an
// agent's shader can rely on lives here: precision, the audio/journey/brand
// uniforms, the four palette stops, and dither8() to break 8-bit banding on
// smooth gradients. Keep in sync with the prop docs and the returned API.
const HEADER = /* glsl */ `precision highp float;

uniform float u_time;      // seconds since clip start (frame / fps)
uniform vec2  u_res;       // canvas resolution in px
uniform float u_progress;  // 0..1 clip progress
uniform float u_energy;    // 0..1 smoothed overall energy
uniform float u_bass;      // 0..1 smoothed low-end energy
uniform float u_beatPulse; // 0..1, snaps to 1 on each beat, decays before the next
uniform float u_seed;      // per-track seed
uniform vec3  u_palette[4];// Retint ramp stops, dark -> light

// Ordered-dither (Bayer-ish via a hash) applied at ~1/255 to break banding when
// quantizing smooth gradients to 8-bit. Call on the final color before output.
float ditherValue(vec2 fragCoord) {
  vec2 p = fract(fragCoord * vec2(0.7548776662, 0.5698402909));
  float n = fract(p.x * p.y * 437.585453);
  return (n - 0.5) / 255.0;
}
vec3 dither8(vec3 col, vec2 uv) {
  return col + ditherValue(uv * u_res);
}
`;

const VERT = `attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}`;

const DEFAULT_STOPS: [string, string, string, string] = [
  colors.deepField,
  colors.reentryRed,
  colors.eclipseGold,
  colors.starlightCream,
];

const toVec3 = (hex: string): [number, number, number] => {
  const { r, g, b } = hexToRgb(hex);
  return [r / 255, g / 255, b / 255];
};

type GlBundle = {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  buffer: WebGLBuffer;
};

/**
 * The semi-headless GLSL workhorse. Renders a fullscreen-triangle fragment
 * shader into a canvas, compiling/linking once per shader string and updating
 * uniforms + drawing synchronously every frame. Generalizes the working
 * gl-probe pattern: same fullscreen triangle, same per-frame uniform push, but
 * with the full brand/audio/journey uniform header injected and custom uniforms,
 * palette ramp, context-loss recovery, and a visible error overlay on failure.
 *
 * Owns the GPU plumbing and BRAND LAW (the injected u_palette ramp + dither8);
 * the consuming agent owns the shader body and custom uniforms. Determinism:
 * u_time/u_progress derive from useCurrentFrame()/fps and every audio uniform
 * comes from the curve hooks, never wall clock or Math.random.
 *
 * GPU is available via ANGLE/Metal (see remotion.config.ts + render.ts); a
 * frame is drawn in a useEffect keyed on the frame so headless captures get a
 * painted canvas.
 */
export const ShaderLayer: React.FC<ShaderLayerProps> = ({
  fragmentShader,
  palette,
  paletteStops,
  progress,
  seed = 1,
  beatGrid,
  beatDecay = 3.2,
  energyCurve,
  bassCurve,
  uniforms,
  opacity = 1,
  blendMode = "normal",
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bundleRef = useRef<GlBundle | null>(null);
  const shaderKeyRef = useRef<string>("");
  const [error, setError] = useState<null | string>(null);

  // Audio uniforms from the existing hooks (no-op when no curve/grid supplied).
  const { pulse } = useBeat(beatGrid ?? [], { decay: beatDecay });
  const beatPulse = beatGrid && beatGrid.length > 0 ? pulse : 0;
  const energy = useEnergy(energyCurve ?? []);
  const bass = useBass(bassCurve ?? []);

  const stops = useMemo<[string, string, string, string]>(
    () =>
      paletteStops ??
      (palette
        ? [
            palette.background ?? DEFAULT_STOPS[0],
            palette.accent ?? DEFAULT_STOPS[1],
            palette.glow ?? DEFAULT_STOPS[2],
            palette.ink ?? DEFAULT_STOPS[3],
          ]
        : DEFAULT_STOPS),
    [palette, paletteStops],
  );

  const clipProgress = progress ?? Math.min(1, frame / Math.max(1, durationInFrames - 1));

  // (Re)compile + link the program whenever the shader string changes, and
  // (re)acquire the context on loss. Returns a live bundle or null on failure.
  const ensureBundle = (canvas: HTMLCanvasElement): GlBundle | null => {
    const fullFrag = HEADER + "\n" + fragmentShader;
    const existing = bundleRef.current;
    if (existing && !existing.gl.isContextLost() && shaderKeyRef.current === fullFrag) {
      return existing;
    }

    const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true });
    if (!gl) {
      setError("WebGL unavailable (no context). Renders require --gl=angle.");
      return null;
    }

    const compile = (type: number, src: string): WebGLShader | null => {
      const sh = gl.createShader(type);
      if (!sh) {
        return null;
      }
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh) ?? "unknown compile error";
        setError(
          `${type === gl.FRAGMENT_SHADER ? "Fragment" : "Vertex"} shader failed to compile:\n${log}`,
        );
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    };

    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, fullFrag);
    if (!vs || !fs) {
      return null;
    }

    const program = gl.createProgram();
    if (!program) {
      setError("Failed to create WebGL program.");
      return null;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      setError(`Program link failed:\n${gl.getProgramInfoLog(program) ?? "unknown link error"}`);
      return null;
    }

    const buffer = gl.createBuffer();
    if (!buffer) {
      setError("Failed to create vertex buffer.");
      return null;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    // Fullscreen triangle (covers the clip space with one primitive).
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const bundle: GlBundle = { buffer, gl, program };
    bundleRef.current = bundle;
    shaderKeyRef.current = fullFrag;
    setError(null);
    return bundle;
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const onLost = (e: Event) => {
      e.preventDefault();
      bundleRef.current = null;
      shaderKeyRef.current = "";
    };
    canvas.addEventListener("webglcontextlost", onLost, false);

    const bundle = ensureBundle(canvas);
    if (!bundle) {
      canvas.removeEventListener("webglcontextlost", onLost, false);
      return;
    }
    const { gl, program, buffer } = bundle;

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const loc = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const u = (name: string) => gl.getUniformLocation(program, name);

    gl.uniform1f(u("u_time"), frame / fps);
    gl.uniform2f(u("u_res"), canvas.width, canvas.height);
    gl.uniform1f(u("u_progress"), clipProgress);
    gl.uniform1f(u("u_energy"), energy);
    gl.uniform1f(u("u_bass"), bass);
    gl.uniform1f(u("u_beatPulse"), beatPulse);
    gl.uniform1f(u("u_seed"), seed);

    const flatPalette = new Float32Array(stops.flatMap((hex) => toVec3(hex)));
    gl.uniform3fv(u("u_palette[0]"), flatPalette);

    if (uniforms) {
      for (const [name, value] of Object.entries(uniforms)) {
        const l = u(name);
        if (l === null) {
          continue;
        }
        if (typeof value === "number") {
          gl.uniform1f(l, value);
        } else if (typeof value === "boolean") {
          gl.uniform1f(l, value ? 1 : 0);
        } else if (value.length === 2) {
          gl.uniform2f(l, value[0], value[1]);
        } else {
          gl.uniform3f(l, value[0], value[1], value[2]);
        }
      }
    }

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.flush();

    return () => {
      canvas.removeEventListener("webglcontextlost", onLost, false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, fragmentShader, fps, clipProgress, energy, bass, beatPulse, seed, stops, uniforms]);

  if (error) {
    return (
      <AbsoluteFill
        style={{
          backgroundColor: colors.deepField,
          color: colors.reentryRed,
          fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
          fontSize: 22,
          lineHeight: 1.4,
          padding: 48,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        <div style={{ color: colors.eclipseGold, fontWeight: 800, marginBottom: 16 }}>
          ShaderLayer error
        </div>
        {error}
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{ mixBlendMode: blendMode, opacity }}>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        style={{ height: "100%", width: "100%" }}
      />
    </AbsoluteFill>
  );
};
