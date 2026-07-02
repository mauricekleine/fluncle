import { colors } from "@fluncle/tokens";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AbsoluteFill,
  cancelRender,
  continueRender,
  delayRender,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { hexToRgb } from "../color";
import { useAudioReactivity, type AudioReactivityOptions } from "../hooks/use-audio-reactivity";
import { type CosmosPalette, type EnergySample } from "../types";
import {
  assignTextureUnits,
  buildFragmentHeader,
  buildVertexShader,
  isRemoteSrc,
} from "./shader-header";

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
  /** Onset offsets (ms) for `u_onsetPulse` and the richer audio bus. */
  onsets?: number[];
  /** Linear onset decay window in ms. Default 140. */
  onsetWindowMs?: number;
  /** Energy curve for `u_energy` via useEnergy. Omitted = u_energy stays 0. */
  energyCurve?: EnergySample[];
  /** Bass curve (<150Hz) for `u_bass` via useBass. Omitted = u_bass stays 0. */
  bassCurve?: EnergySample[];
  /** Mid curve (150Hz-2kHz) for `u_mid` via useMid. Omitted = u_mid stays 0. */
  midCurve?: EnergySample[];
  /** Treble curve (>2kHz) for `u_treble` via useTreble. Omitted = u_treble stays 0. */
  trebleCurve?: EnergySample[];
  /** Flux curve (continuous transient/attack) for `u_flux` via useFlux. Omitted = u_flux stays 0. */
  fluxCurve?: EnergySample[];
  /**
   * Shared audio-reactivity profile. Use these to disturb MATERIAL (width,
   * density, threshold, glow, grain, refraction, exposure) on the immediate
   * beat, and to drive MOTION (travel, flow, convergence) too — but motion only
   * through a SMOOTHED signal (an envelope, or a beat run through attack/decay),
   * never the raw transient, so movement glides and never snaps on the kick
   * (Motion law, doctrine 7). Audio disturbs the material AND moves the picture.
   */
  reactivity?: AudioReactivityOptions;
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
  /**
   * Opt-in real emission bloom (multi-pass: bright-pass + separable blur, added
   * back). Omit and the render path is unchanged. Bloom the vehicle's OWN hot
   * material — NOT a licence for the banned bolted-on glow-orb (doctrine 1).
   */
  bloom?: BloomOptions;
  /**
   * Image inputs, keyed by the GLSL uniform name your shader samples. The value is
   * an https URL (e.g. `track.artworkUrl` passed straight in) or a `staticFile()`
   * path / bare `public/` filename. For each entry `<name>` the injected header
   * gains:
   *
   *   uniform sampler2D <name>;      // the image, CLAMP_TO_EDGE + LINEAR, no mipmaps
   *   uniform float <name>AspectRatio; // image width / height, for aspect-correct sampling
   *
   * Every image is loaded once (crossOrigin="anonymous") behind Remotion's
   * `delayRender()`/`continueRender()`, so no frame is captured before the
   * textures are ready; a load failure `cancelRender`s with a clear message.
   * Uploads flip Y (UNPACK_FLIP_Y_WEBGL), so sampling with the canonical
   * `uv = gl_FragCoord.xy / u_res` (y-up) shows the image UPRIGHT. Units are
   * assigned deterministically in sorted name order. Re-uploaded on context
   * restore. Remote URLs work headless (the render fetches them directly). Keep
   * `textures` identity stable across frames (frame-derived props only).
   */
  textures?: Record<string, string>;
  /**
   * Opt in to WebGL2 / GLSL ES 3.00: the context becomes `webgl2`, the header is
   * emitted as `#version 300 es`, and the body writes to the injected
   * `out vec4 fragColor;` (declare no color output yourself) and samples textures
   * with `texture(...)`. The injected uniform NAMES are unchanged. There is NO
   * silent fallback — if webgl2 is unavailable the error overlay shows. Absent
   * (default) stays WebGL1 with byte-identical behavior. Purpose: verbatim GLSL3
   * lifts. `OES_standard_derivatives` (`fwidth`/`dFdx`) is built in under GLSL3
   * and auto-enabled under WebGL1 when the host supports it.
   */
  glsl3?: boolean;
};

// The audio/journey/brand uniform block injected ahead of every fragmentShader
// body — anything a shader can rely on: the audio/journey/brand uniforms and the
// four palette stops. This block is OWNED HERE: a new uniform is declared here
// and pushed by name in the draw effect below (keep the two in sync). The header
// is assembled by buildFragmentHeader (shader-header.ts), which frames this block
// with precision/version/extension/texture lines. Keep in sync with the prop docs.
const CORE_UNIFORMS = /* glsl */ `uniform float u_time;      // seconds since clip start (frame / fps)
uniform vec2  u_res;       // canvas resolution in px
uniform float u_progress;  // 0..1 clip progress
uniform float u_energy;    // 0..1 smoothed overall energy
uniform float u_bass;      // 0..1 smoothed low band <150Hz (kick/sub)
uniform float u_mid;       // 0..1 smoothed mid band 150Hz-2kHz (lead/vocal/snare)
uniform float u_treble;    // 0..1 smoothed high band >2kHz (hats/cymbals/air)
uniform float u_beatPulse; // 0..1, snaps to 1 on each beat, decays before the next
uniform float u_onsetPulse;// 0..1, snaps on detected transients and decays linearly
uniform float u_audioHit;  // beat + onset composite for immediate material hits
uniform float u_audioSwell;// slower beat + bass + energy composite for organic after-pulse
uniform float u_audioDrop; // envelope around the strongest musical moment or configured peak
uniform float u_audioDisturbance; // hit+swell+drop, a general material disruption signal
uniform float u_energyFast;// near-raw energy, for sharper non-positional reactions
uniform float u_bassFast;  // near-raw bass, for pressure without smoothing lag
uniform float u_midFast;   // near-raw mid, snappier lead-driven reactions
uniform float u_trebleFast;// near-raw treble, snappy hat/cymbal sparkle
uniform float u_flux;      // 0..1 continuous transient/attack envelope (between-onset shimmer)
uniform float u_seed;      // per-track seed
uniform vec3  u_palette[4];// Retint ramp stops, dark -> light`;

// Ordered-dither banding-killer helpers (GLSL1/GLSL3-agnostic — no gl_FragColor
// or texture2D). Framed into the header by buildFragmentHeader.
const DITHER_HELPERS = /* glsl */ `// Ordered-dither (Bayer-ish via a hash) applied at ~1/255 to break banding when
// quantizing smooth gradients to 8-bit. Call on the final color before output.
float ditherValue(vec2 fragCoord) {
  vec2 p = fract(fragCoord * vec2(0.7548776662, 0.5698402909));
  float n = fract(p.x * p.y * 437.585453);
  return (n - 0.5) / 255.0;
}
vec3 dither8(vec3 col, vec2 uv) {
  return col + ditherValue(uv * u_res);
}`;

// The fullscreen-triangle vertex shader for the BLOOM helper passes (GLSL ES 1.00;
// a WebGL2 context still compiles version-100 shaders, so bloom is glsl3-safe).
// The MAIN program's vertex shader comes from buildVertexShader(glsl3).
const VERT = `attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}`;

// Neutral warm-dark ramp — the fallback when a layer is given no palette. Kept
// colourless ON PURPOSE (only the Warm Dark Rule is imposed): a real scene
// passes its own stops from the artwork palette, so no gold/red is forced here.
const DEFAULT_STOPS: [string, string, string, string] = [
  colors.deepField,
  colors.tapeBlack,
  colors.stardust,
  colors.starlightCream,
];

const toVec3 = (hex: string): [number, number, number] => {
  const { r, g, b } = hexToRgb(hex);
  return [r / 255, g / 255, b / 255];
};

// --- Bloom: opt-in real emission glow (multi-pass) ---------------------------
// Render the scene to a texture, isolate the bright pixels, separable-gaussian
// blur them at half resolution, and add them back. Single-frame and fully
// deterministic — there is NO cross-frame feedback (Remotion renders frames
// independently, so frame N cannot read frame N-1's GPU state; feedback trails
// are intentionally out of scope). Off by default: the render path below is
// untouched unless a `bloom` prop is passed. DOCTRINE: this blooms the vehicle's
// OWN hot material; it is not a licence for the banned bolted-on glow-orb.

export type BloomOptions = {
  /** Luminance above which a pixel blooms, 0..1. Default 0.7. */
  threshold?: number;
  /** How strongly the blurred bloom is added back, ~0..2. Default 0.8. */
  intensity?: number;
  /** Blur spread per tap in half-res pixels (wider = more halation). Default 1. */
  radius?: number;
};

const BLOOM_BRIGHT_FRAG = `precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_res;
uniform float u_threshold;
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec3 c = texture2D(u_tex, uv).rgb;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  float k = smoothstep(u_threshold, u_threshold + 0.25, l);
  gl_FragColor = vec4(c * k, 1.0);
}`;

const BLOOM_BLUR_FRAG = `precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_res;
uniform vec2 u_dir;
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 px = u_dir / u_res;
  vec3 sum = texture2D(u_tex, uv).rgb * 0.227027;
  sum += texture2D(u_tex, uv + px * 1.3846).rgb * 0.316216;
  sum += texture2D(u_tex, uv - px * 1.3846).rgb * 0.316216;
  sum += texture2D(u_tex, uv + px * 3.2307).rgb * 0.070270;
  sum += texture2D(u_tex, uv - px * 3.2307).rgb * 0.070270;
  gl_FragColor = vec4(sum, 1.0);
}`;

const BLOOM_COMPOSITE_FRAG = `precision highp float;
uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform vec2 u_res;
uniform float u_intensity;
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  // Bloom adds RGB ENERGY only; the alpha stays the SCENE's, so a localized
  // alpha-composited layer (orb/glow that fades to true zero) keeps its soft edge
  // under bloom instead of printing an opaque rectangle (the quad law).
  vec4 scene = texture2D(u_scene, uv);
  vec3 bloom = texture2D(u_bloom, uv).rgb;
  gl_FragColor = vec4(scene.rgb + bloom * u_intensity, scene.a);
}`;

type RenderTarget = { tex: WebGLTexture; fbo: WebGLFramebuffer };
type BloomGl = {
  bright: WebGLProgram;
  blur: WebGLProgram;
  composite: WebGLProgram;
  scene: RenderTarget;
  ping: RenderTarget;
  pong: RenderTarget;
  halfW: number;
  halfH: number;
  key: string;
};

/** Compile VERT + a helper fragment into a linked program (null on failure). */
const compileFrag = (gl: WebGLRenderingContext, fragSrc: string): WebGLProgram | null => {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  if (!vs || !fs) {
    return null;
  }
  gl.shaderSource(vs, VERT);
  gl.compileShader(vs);
  gl.shaderSource(fs, fragSrc);
  gl.compileShader(fs);
  if (
    !gl.getShaderParameter(vs, gl.COMPILE_STATUS) ||
    !gl.getShaderParameter(fs, gl.COMPILE_STATUS)
  ) {
    return null;
  }
  const program = gl.createProgram();
  if (!program) {
    return null;
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    return null;
  }
  return program;
};

/** An RGBA8 texture + framebuffer at (w,h), LINEAR + clamp (null on failure). */
const makeTarget = (gl: WebGLRenderingContext, w: number, h: number): RenderTarget | null => {
  const tex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  if (!tex || !fbo) {
    return null;
  }
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { fbo, tex };
};

/** Build the bloom programs + targets for a (w,h). Null if any step fails. */
const buildBloomGl = (gl: WebGLRenderingContext, w: number, h: number): BloomGl | null => {
  const bright = compileFrag(gl, BLOOM_BRIGHT_FRAG);
  const blur = compileFrag(gl, BLOOM_BLUR_FRAG);
  const composite = compileFrag(gl, BLOOM_COMPOSITE_FRAG);
  const halfW = Math.max(1, Math.floor(w / 2));
  const halfH = Math.max(1, Math.floor(h / 2));
  const scene = makeTarget(gl, w, h);
  const ping = makeTarget(gl, halfW, halfH);
  const pong = makeTarget(gl, halfW, halfH);
  if (!bright || !blur || !composite || !scene || !ping || !pong) {
    return null;
  }
  return { blur, bright, composite, halfH, halfW, key: `${w}x${h}`, ping, pong, scene };
};

/**
 * Run bright -> separable-blur -> composite. The scene must already be rendered
 * into `b.scene`; composites scene + blurred bloom to the default framebuffer.
 */
const runBloom = (
  gl: WebGLRenderingContext,
  b: BloomGl,
  buffer: WebGLBuffer,
  fullW: number,
  fullH: number,
  opts: Required<BloomOptions>,
): void => {
  const pass = (
    program: WebGLProgram,
    target: WebGLFramebuffer | null,
    vw: number,
    vh: number,
    setup: (p: WebGLProgram) => void,
  ): void => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, vw, vh);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const attrib = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(attrib);
    gl.vertexAttribPointer(attrib, 2, gl.FLOAT, false, 0, 0);
    setup(program);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const U = (p: WebGLProgram, n: string): WebGLUniformLocation | null =>
    gl.getUniformLocation(p, n);

  // Bright-pass: scene (full) -> ping (half).
  pass(b.bright, b.ping.fbo, b.halfW, b.halfH, (p) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, b.scene.tex);
    gl.uniform1i(U(p, "u_tex"), 0);
    gl.uniform2f(U(p, "u_res"), b.halfW, b.halfH);
    gl.uniform1f(U(p, "u_threshold"), opts.threshold);
  });

  // Separable gaussian, a few iterations for spread (ping -H-> pong -V-> ping).
  for (let i = 0; i < 5; i++) {
    pass(b.blur, b.pong.fbo, b.halfW, b.halfH, (p) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, b.ping.tex);
      gl.uniform1i(U(p, "u_tex"), 0);
      gl.uniform2f(U(p, "u_res"), b.halfW, b.halfH);
      gl.uniform2f(U(p, "u_dir"), opts.radius, 0);
    });
    pass(b.blur, b.ping.fbo, b.halfW, b.halfH, (p) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, b.pong.tex);
      gl.uniform1i(U(p, "u_tex"), 0);
      gl.uniform2f(U(p, "u_res"), b.halfW, b.halfH);
      gl.uniform2f(U(p, "u_dir"), 0, opts.radius);
    });
  }

  // Composite scene + blurred bloom -> default framebuffer (the canvas).
  pass(b.composite, null, fullW, fullH, (p) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, b.scene.tex);
    gl.uniform1i(U(p, "u_scene"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, b.ping.tex);
    gl.uniform1i(U(p, "u_bloom"), 1);
    gl.uniform2f(U(p, "u_res"), fullW, fullH);
    gl.uniform1f(U(p, "u_intensity"), opts.intensity);
  });
};

// --- Texture inputs: artwork-as-texture, the biggest expressive lane ----------
// Each `textures` entry uploads an image as a sampler2D the shader can read.
// NPOT-safe (CLAMP_TO_EDGE + LINEAR, no mipmaps) so any artwork size works in
// WebGL1. Y is flipped on upload so the canonical y-up `uv = gl_FragCoord/u_res`
// samples the image UPRIGHT. Loading (crossOrigin) is gated by delayRender so a
// frame is never captured before the pixels arrive.

/** Upload an already-loaded image as an NPOT-safe, upright sampler2D (null on failure). */
const uploadTexture = (gl: WebGLRenderingContext, image: TexSource): WebGLTexture | null => {
  const tex = gl.createTexture();
  if (!tex) {
    return null;
  }
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
};

// The subset of HTMLImageElement texImage2D accepts; kept narrow for testability.
type TexSource = TexImageSource & { height: number; width: number };

// The GL-side texture cache: which images are uploaded, on which context, keyed by
// the loaded-image identity so a context restore or a new image set re-uploads.
type TextureCache = {
  gl: WebGLRenderingContext;
  key: string;
  textures: Record<string, WebGLTexture>;
};

type GlBundle = {
  buffer: WebGLBuffer;
  gl: WebGLRenderingContext;
  glsl3: boolean;
  program: WebGLProgram;
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
 *
 * Beyond the header + audio bus it also carries: `textures` (artwork-as-texture,
 * loaded behind delayRender and exposed as `sampler2D <name>` + `float
 * <name>AspectRatio`), opt-in `glsl3` (a `#version 300 es` / WebGL2 context for
 * verbatim GLSL3 lifts — writes `out vec4 fragColor`), and auto-enabled
 * `OES_standard_derivatives` (`fwidth`) on WebGL1. See the prop docs above.
 */
/** The loaded texture images + a content key that changes only when the set does. */
type LoadedTextures = { images: Record<string, HTMLImageElement>; key: string };

/**
 * Load every `textures` entry once as an HTMLImageElement (crossOrigin), gated by
 * Remotion's delayRender so no frame is captured before the pixels are ready; a
 * load failure cancelRenders with a clear message. Re-runs only when the CONTENT
 * of the map changes (a stable string key), never on mere prop-identity churn, so
 * a per-frame-recreated `textures` object does not reload every frame.
 */
const useTextureImages = (textures: Record<string, string> | undefined): LoadedTextures => {
  const texturesRef = useRef(textures);
  texturesRef.current = textures;

  // A stable content key: sorted "name=src" pairs. Same content → same string →
  // the loader effect does not re-run even if the object identity changed.
  const key = useMemo(() => {
    const t = textures ?? {};
    return Object.keys(t)
      .sort()
      .map((name) => `${name}=${t[name]}`)
      .join("|");
  }, [textures]);

  const [loaded, setLoaded] = useState<LoadedTextures>({ images: {}, key: "" });

  useEffect(() => {
    const current = texturesRef.current ?? {};
    const names = Object.keys(current).sort();
    if (names.length === 0) {
      setLoaded({ images: {}, key });
      return;
    }

    let cancelled = false;
    const handle = delayRender(`ShaderLayer: loading ${names.length} texture(s)`);
    const images: Record<string, HTMLImageElement> = {};
    let remaining = names.length;

    for (const name of names) {
      const src = current[name] ?? "";
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        if (cancelled) {
          return;
        }
        images[name] = img;
        remaining -= 1;
        if (remaining === 0) {
          setLoaded({ images, key });
          continueRender(handle);
        }
      };
      img.onerror = () => {
        if (cancelled) {
          return;
        }
        cancelRender(new Error(`ShaderLayer texture "${name}" failed to load from ${src}`));
      };
      img.src = isRemoteSrc(src) ? src : staticFile(src);
    }

    return () => {
      cancelled = true;
      // Release the delay if this set is torn down before it finished loading.
      continueRender(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on content, not identity
  }, [key]);

  return loaded;
};

// The error-overlay surface — a static fallback shown only when WebGL setup
// fails. All fixed, so it stays stable instead of rebuilding each render.
const ERROR_STYLE: React.CSSProperties = {
  backgroundColor: colors.deepField,
  color: colors.reentryRed,
  fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
  fontSize: 22,
  lineHeight: 1.4,
  padding: 48,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

export const ShaderLayer: React.FC<ShaderLayerProps> = ({
  fragmentShader,
  palette,
  paletteStops,
  progress,
  seed = 1,
  beatGrid,
  beatDecay = 3.2,
  onsets,
  onsetWindowMs,
  energyCurve,
  bassCurve,
  midCurve,
  trebleCurve,
  fluxCurve,
  reactivity,
  uniforms,
  opacity = 1,
  blendMode = "normal",
  bloom,
  textures,
  glsl3 = false,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bundleRef = useRef<GlBundle | null>(null);
  const bloomGlRef = useRef<BloomGl | null>(null);
  const texGlRef = useRef<TextureCache | null>(null);
  const shaderKeyRef = useRef<string>("");
  const [error, setError] = useState<null | string>(null);

  // Load the artwork/texture images once (delayRender-gated). The stable string of
  // sorted names is what the header + unit assignment key off, so a per-frame
  // re-created `textures` object never triggers a recompile or reload.
  const loadedTextures = useTextureImages(textures);
  const textureNames = useMemo(() => Object.keys(textures ?? {}).sort(), [textures]);
  const textureNamesKey = useMemo(() => textureNames.join(","), [textureNames]);

  // Audio uniforms from the shared bus (no-op when no curve/grid supplied).
  const audio = useAudioReactivity(
    {
      bassCurve: bassCurve ?? [],
      beatGrid: beatGrid ?? [],
      energyCurve: energyCurve ?? [],
      fluxCurve: fluxCurve ?? [],
      midCurve: midCurve ?? [],
      onsets: onsets ?? [],
      trebleCurve: trebleCurve ?? [],
    },
    {
      ...reactivity,
      beatDecay: reactivity?.beatDecay ?? beatDecay,
      onsetWindowMs: reactivity?.onsetWindowMs ?? onsetWindowMs,
    },
  );

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
  const ensureBundle = useCallback(
    (canvas: HTMLCanvasElement): GlBundle | null => {
      const names = textureNamesKey ? textureNamesKey.split(",") : [];
      // OES_standard_derivatives is a header line under WebGL1 only (WebGL2 has it
      // built in). Computing it needs the live context, so a full-frag rebuild
      // reads it off whichever context is in play.
      const buildFrag = (derivatives: boolean): string =>
        buildFragmentHeader({
          coreUniforms: CORE_UNIFORMS,
          derivatives,
          ditherHelpers: DITHER_HELPERS,
          glsl3,
          textureNames: names,
        }) +
        "\n" +
        fragmentShader;

      const existing = bundleRef.current;
      if (existing && !existing.gl.isContextLost() && existing.glsl3 === glsl3) {
        const derivatives = !glsl3 && Boolean(existing.gl.getExtension("OES_standard_derivatives"));
        if (shaderKeyRef.current === buildFrag(derivatives)) {
          return existing;
        }
      }

      // No silent fallback: glsl3 demands a real webgl2 context. The context is a
      // superset of WebGL1 at runtime, so it is typed as WebGLRenderingContext for
      // the shared GPU helpers; the `#version 300 es` source is what selects the
      // dialect, not the TS type.
      const gl = (
        glsl3
          ? canvas.getContext("webgl2", { preserveDrawingBuffer: true })
          : canvas.getContext("webgl", { preserveDrawingBuffer: true })
      ) as WebGLRenderingContext | null;
      if (!gl) {
        setError(
          glsl3
            ? "WebGL2 unavailable (no webgl2 context). glsl3 needs a WebGL2/ANGLE renderer; drop glsl3 or use a webgl2-capable host."
            : "WebGL unavailable (no context). Renders need a GL renderer — angle or swangle (FLUNCLE_GL).",
        );
        return null;
      }

      // Enable derivatives on WebGL1 when present (guarded — absent just means a
      // shader can't use fwidth; no crash). WebGL2 has it built in.
      const derivatives = !glsl3 && Boolean(gl.getExtension("OES_standard_derivatives"));
      const fullFrag = buildFrag(derivatives);

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

      const vs = compile(gl.VERTEX_SHADER, buildVertexShader(glsl3));
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

      // A fresh program/context invalidates any textures uploaded to the old one.
      texGlRef.current = null;

      const bundle: GlBundle = { buffer, gl, glsl3, program };
      bundleRef.current = bundle;
      shaderKeyRef.current = fullFrag;
      setError(null);
      return bundle;
    },
    [fragmentShader, glsl3, textureNamesKey],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const onLost = (e: Event) => {
      e.preventDefault();
      bundleRef.current = null;
      bloomGlRef.current = null;
      texGlRef.current = null;
      shaderKeyRef.current = "";
    };
    canvas.addEventListener("webglcontextlost", onLost, false);

    const bundle = ensureBundle(canvas);
    if (!bundle) {
      canvas.removeEventListener("webglcontextlost", onLost, false);
      return;
    }
    const { gl, program, buffer } = bundle;

    // Build bloom resources first (once per size, cached) so the scene-program
    // vertex/uniform state set below is the last thing bound before we draw.
    let bloomGl: BloomGl | null = null;
    if (bloom) {
      const bloomKey = `${canvas.width}x${canvas.height}`;
      bloomGl = bloomGlRef.current;
      if (!bloomGl || bloomGl.key !== bloomKey) {
        bloomGl = buildBloomGl(gl, canvas.width, canvas.height);
        bloomGlRef.current = bloomGl;
        if (!bloomGl) {
          setError("Bloom setup failed (framebuffer or helper shader).");
        }
      }
    }

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const loc = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const u = (name: string) => gl.getUniformLocation(program, name);

    gl.uniform1f(u("u_time"), frame / fps);
    gl.uniform2f(u("u_res"), canvas.width, canvas.height);
    gl.uniform1f(u("u_progress"), clipProgress);
    gl.uniform1f(u("u_energy"), audio.energy);
    gl.uniform1f(u("u_bass"), audio.bass);
    gl.uniform1f(u("u_mid"), audio.mid);
    gl.uniform1f(u("u_treble"), audio.treble);
    gl.uniform1f(u("u_beatPulse"), audio.beat);
    gl.uniform1f(u("u_onsetPulse"), audio.onset);
    gl.uniform1f(u("u_audioHit"), audio.hit);
    gl.uniform1f(u("u_audioSwell"), audio.swell);
    gl.uniform1f(u("u_audioDrop"), audio.drop);
    gl.uniform1f(u("u_audioDisturbance"), audio.uniforms.u_audioDisturbance ?? 0);
    gl.uniform1f(u("u_energyFast"), audio.energyFast);
    gl.uniform1f(u("u_bassFast"), audio.bassFast);
    gl.uniform1f(u("u_midFast"), audio.midFast);
    gl.uniform1f(u("u_trebleFast"), audio.trebleFast);
    gl.uniform1f(u("u_flux"), audio.flux);
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

    // Textures: (re)upload for this context/image-set, then bind each to its
    // deterministic unit and set the sampler + <name>AspectRatio uniforms. Done
    // BEFORE drawScene so both the bloom and non-bloom paths sample them.
    if (textureNames.length > 0) {
      const cache = texGlRef.current;
      if (!cache || cache.gl !== gl || cache.key !== loadedTextures.key) {
        if (cache && cache.gl === gl) {
          for (const old of Object.values(cache.textures)) {
            gl.deleteTexture(old);
          }
        }
        const uploaded: Record<string, WebGLTexture> = {};
        for (const name of textureNames) {
          const img = loadedTextures.images[name];
          if (!img) {
            continue;
          }
          const tex = uploadTexture(gl, img);
          if (tex) {
            uploaded[name] = tex;
          }
        }
        texGlRef.current = { gl, key: loadedTextures.key, textures: uploaded };
      }

      const units = assignTextureUnits(textureNames);
      const built = texGlRef.current?.textures ?? {};
      for (const name of textureNames) {
        const tex = built[name];
        if (!tex) {
          continue;
        }
        const unit = units[name] ?? 0;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        const sampler = u(name);
        if (sampler !== null) {
          gl.uniform1i(sampler, unit);
        }
        const aspect = u(`${name}AspectRatio`);
        const img = loadedTextures.images[name];
        if (aspect !== null && img) {
          gl.uniform1f(aspect, img.height === 0 ? 1 : img.width / img.height);
        }
      }
    }

    const drawScene = (target: WebGLFramebuffer | null): void => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    if (bloom && bloomGl) {
      // Scene -> its texture, then bright/blur/composite to the canvas.
      drawScene(bloomGl.scene.fbo);
      runBloom(gl, bloomGl, buffer, canvas.width, canvas.height, {
        intensity: bloom.intensity ?? 0.8,
        radius: bloom.radius ?? 1,
        threshold: bloom.threshold ?? 0.7,
      });
    } else {
      drawScene(null);
    }
    gl.flush();

    return () => {
      canvas.removeEventListener("webglcontextlost", onLost, false);
    };
  }, [
    audio,
    bloom,
    clipProgress,
    ensureBundle,
    fps,
    frame,
    loadedTextures,
    seed,
    stops,
    textureNames,
    uniforms,
  ]);

  if (error) {
    return (
      <AbsoluteFill style={ERROR_STYLE}>
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
