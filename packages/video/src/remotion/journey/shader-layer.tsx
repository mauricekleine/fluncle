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
import { MONO_STACK } from "../fonts";
import { useAudioReactivity, type AudioReactivityOptions } from "../hooks/use-audio-reactivity";
import { type CosmosPalette, type EnergySample } from "../types";
import {
  assignTextureUnits,
  buildFragmentHeader,
  buildVertexShader,
  isRemoteSrc,
} from "./shader-header";

export type ShaderUniformValue = number | boolean | [number, number] | [number, number, number];

export type ShaderLayerProps = {
  fragmentShader: string;

  palette?: Partial<CosmosPalette>;

  paletteStops?: [string, string, string, string];

  progress?: number;

  seed?: number;

  beatGrid?: number[];

  beatDecay?: number;

  onsets?: number[];

  onsetWindowMs?: number;

  energyCurve?: EnergySample[];

  bassCurve?: EnergySample[];

  midCurve?: EnergySample[];

  trebleCurve?: EnergySample[];

  fluxCurve?: EnergySample[];

  subCurve?: EnergySample[];

  kickCurve?: EnergySample[];

  snareCurve?: EnergySample[];

  airCurve?: EnergySample[];

  downbeats?: number[];

  dropMs?: number;

  reactivity?: AudioReactivityOptions;

  uniforms?: Record<string, ShaderUniformValue>;

  opacity?: number;

  blendMode?: React.CSSProperties["mixBlendMode"];

  bloom?: BloomOptions;

  textures?: Record<string, string>;

  glsl3?: boolean;

  resolutionScale?: number;
};

export function backingStoreSize(
  width: number,
  height: number,
  resolutionScale: number | undefined,
): { width: number; height: number } {
  const scale =
    typeof resolutionScale === "number" && Number.isFinite(resolutionScale) && resolutionScale > 0
      ? Math.min(resolutionScale, 1)
      : 1;
  return {
    height: Math.max(1, Math.round(height * scale)),
    width: Math.max(1, Math.round(width * scale)),
  };
}

const CORE_UNIFORMS = `uniform float u_time;      // seconds since clip start (frame / fps)
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
uniform float u_sub;       // 0..1 smoothed sub weight <60Hz (low-end pressure/mass)
uniform float u_kickHit;   // 0..1 near-raw transient-emphasized kick punch 60-150Hz (MATERIAL only)
uniform float u_snareHit;  // 0..1 near-raw transient-emphasized snare crack 2-5kHz (MATERIAL only)
uniform float u_air;       // 0..1 air band >5kHz (hat tails/cymbal wash, fine sparkle)
uniform float u_downbeatPulse; // 0..1, snaps on each bar downbeat and decays across the bar
uniform float u_seed;      // per-track seed
uniform vec3  u_palette[4];// Retint ramp stops, dark -> light`;

const DITHER_HELPERS = `// Ordered-dither (Bayer-ish via a hash) applied at ~1/255 to break banding when
// quantizing smooth gradients to 8-bit. Call on the final color before output.
float ditherValue(vec2 fragCoord) {
  vec2 p = fract(fragCoord * vec2(0.7548776662, 0.5698402909));
  float n = fract(p.x * p.y * 437.585453);
  return (n - 0.5) / 255.0;
}
vec3 dither8(vec3 col, vec2 uv) {
  return col + ditherValue(uv * u_res);
}`;

const VERT = `attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}`;

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

export type BloomOptions = {
  threshold?: number;

  intensity?: number;

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

  pass(b.bright, b.ping.fbo, b.halfW, b.halfH, (p) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, b.scene.tex);
    gl.uniform1i(U(p, "u_tex"), 0);
    gl.uniform2f(U(p, "u_res"), b.halfW, b.halfH);
    gl.uniform1f(U(p, "u_threshold"), opts.threshold);
  });

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

type TexSource = TexImageSource & { height: number; width: number };

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

type LoadedTextures = { images: Record<string, HTMLImageElement>; key: string };

function applyCustomUniforms(
  gl: WebGLRenderingContext,
  uniformLocation: (name: string) => WebGLUniformLocation | null,
  uniforms: ShaderLayerProps["uniforms"],
): void {
  for (const [name, value] of Object.entries(uniforms ?? {})) {
    const location = uniformLocation(name);
    if (location === null) {
      continue;
    }
    if (typeof value === "number") {
      gl.uniform1f(location, value);
    } else if (typeof value === "boolean") {
      gl.uniform1f(location, value ? 1 : 0);
    } else if (value.length === 2) {
      gl.uniform2f(location, value[0], value[1]);
    } else {
      gl.uniform3f(location, value[0], value[1], value[2]);
    }
  }
}

const useTextureImages = (textures: Record<string, string> | undefined): LoadedTextures => {
  const texturesRef = useRef(textures);
  texturesRef.current = textures;

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

      continueRender(handle);
    };
  }, [key]);

  return loaded;
};

const ERROR_STYLE: React.CSSProperties = {
  backgroundColor: colors.deepField,
  color: colors.reentryRed,

  fontFamily: MONO_STACK,
  fontSize: 22,
  lineHeight: 1.4,
  padding: 48,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

function prepareBloomResources(
  gl: WebGLRenderingContext,
  canvas: HTMLCanvasElement,
  enabled: ShaderLayerProps["bloom"],
  bloomRef: { current: BloomGl | null },
  setError: (message: string) => void,
): BloomGl | null {
  if (!enabled) {
    return null;
  }
  const bloomKey = `${canvas.width}x${canvas.height}`;
  let bloomGl = bloomRef.current;
  if (!bloomGl || bloomGl.key !== bloomKey) {
    bloomGl = buildBloomGl(gl, canvas.width, canvas.height);
    bloomRef.current = bloomGl;
    if (!bloomGl) {
      setError("Bloom setup failed (framebuffer or helper shader).");
    }
  }
  return bloomGl;
}

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
  subCurve,
  kickCurve,
  snareCurve,
  airCurve,
  downbeats,
  dropMs,
  reactivity,
  uniforms,
  opacity = 1,
  blendMode = "normal",
  bloom,
  textures,
  glsl3 = false,
  resolutionScale,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();

  const backing = backingStoreSize(width, height, resolutionScale);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bundleRef = useRef<GlBundle | null>(null);
  const bloomGlRef = useRef<BloomGl | null>(null);
  const texGlRef = useRef<TextureCache | null>(null);
  const shaderKeyRef = useRef<string>("");
  const [error, setError] = useState<null | string>(null);

  const loadedTextures = useTextureImages(textures);
  const textureNames = useMemo(() => Object.keys(textures ?? {}).sort(), [textures]);
  const textureNamesKey = useMemo(() => textureNames.join(","), [textureNames]);

  const audio = useAudioReactivity(
    {
      airCurve: airCurve ?? [],
      bassCurve: bassCurve ?? [],
      beatGrid: beatGrid ?? [],
      downbeats: downbeats ?? [],
      dropMs,
      energyCurve: energyCurve ?? [],
      fluxCurve: fluxCurve ?? [],
      kickCurve: kickCurve ?? [],
      midCurve: midCurve ?? [],
      onsets: onsets ?? [],
      snareCurve: snareCurve ?? [],
      subCurve: subCurve ?? [],
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

  const ensureBundle = useCallback(
    (canvas: HTMLCanvasElement): GlBundle | null => {
      const names = textureNamesKey ? textureNamesKey.split(",") : [];

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

      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

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

    const bloomGl = prepareBloomResources(gl, canvas, bloom, bloomGlRef, setError);

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
    gl.uniform1f(u("u_sub"), audio.sub);
    gl.uniform1f(u("u_kickHit"), audio.kickHit);
    gl.uniform1f(u("u_snareHit"), audio.snareHit);
    gl.uniform1f(u("u_air"), audio.air);
    gl.uniform1f(u("u_downbeatPulse"), audio.downbeat);
    gl.uniform1f(u("u_seed"), seed);

    const flatPalette = new Float32Array(stops.flatMap((hex) => toVec3(hex)));
    gl.uniform3fv(u("u_palette[0]"), flatPalette);

    applyCustomUniforms(gl, u, uniforms);

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
    backing.height,
    backing.width,
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
        width={backing.width}
        height={backing.height}
        style={{ height: "100%", width: "100%" }}
      />
    </AbsoluteFill>
  );
};
