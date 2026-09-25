import { type BloomConfig } from "../glsl-runtime.ts";
import {
  assignTextureUnits,
  BLIT_FRAG,
  BLOOM_BLUR_FRAG,
  BLOOM_BRIGHT_FRAG,
  BLOOM_COMPOSITE_FRAG,
  bodyDeclaresSampler,
  FRAG,
  REPLAY_HEADER,
  textureUniformDecls,
  VERT,
} from "../glsl-runtime.ts";
import { type CustomU, type SceneLayer } from "../scene-extract.ts";

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = (): void => resolve(img);
    img.onerror = (): void => reject(new Error(`texture load failed: ${url}`));
    img.src = url;
  });
}

const CROSSFADE_FRAG = `precision highp float;
uniform sampler2D u_base;
uniform sampler2D u_replay;
uniform vec2 u_res;
uniform float u_fade;    // 0 = base only, 1 = replay only
uniform float u_time;
float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 78.233); return fract(p.x * p.y); }
void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec3 base = texture2D(u_base, uv).rgb;
  vec4 rep = texture2D(u_replay, uv);
  // replay composites OVER the base by its own coverage AND the arrival fade.
  vec3 col = mix(base, rep.rgb, clamp(u_fade, 0.0, 1.0) * max(rep.a, u_fade));
  col = min(col, vec3(0.92));                        // RAIL 1 — Warm Dark ceiling
  float g = (hash21(uv * u_res + u_time) - 0.5) / 255.0 * 12.0;
  col += vec3(g);                                    // RAIL 2 — grain floor (never dead black)
  gl_FragColor = vec4(col, 1.0);
}`;

type Program = {
  prog: WebGLProgram;
  vs: WebGLShader;
  fs: WebGLShader;
  loc: Map<string, WebGLUniformLocation | null>;
};
type Target = { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number };

export type ReplayFrameInputs = {
  time: number;
  progress: number;
  bass: number;
  mid: number;
  treble: number;
  energy: number;
  kick: number;

  bassFast: number;
  midFast: number;
  trebleFast: number;
  energyFast: number;
  swell: number;
  drop: number;
  seedRaw: number;
  palette: Float32Array;
  dwellSec: number;
};

export type BaseFrameInputs = {
  time: number;
  scene: number;
  holding: number;
  seed: number;
  bass: number;
  mid: number;
  treble: number;
  energy: number;
  kick: number;
  swell: number;
  palette: Float32Array;
};

type VelEntry = {
  pos: string;
  vel: string;
  type: "float" | "vec2";
  dir: [number, number];
  x: number;
  y: number;

  step: number;
};

export class GlassPipeline {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private quad!: WebGLBuffer;

  private pBase!: Program;
  private pCross!: Program;
  private pBlit!: Program;
  private pBright!: Program;
  private pBlur!: Program;
  private pBloomComposite!: Program;

  private fboBase!: Target;
  private fboReplay!: Target;
  private fboComposite!: Target;
  private fboFinal!: Target;
  private fboBloomA!: Target;
  private fboBloomB!: Target;
  private fboSmall!: Target;

  private replayLayers: Array<{
    prog: Program;
    customs: CustomU[];
    blend: "opaque" | "over";

    textureNames: string[];
  }> = [];
  private integrators: VelEntry[] = [];
  private lastMs = performance.now();

  private activeTextures = new Map<string, { tex: WebGLTexture; aspect: number }>();
  private replayUnits: Record<string, number> = {};
  private replayTextureUrls: Array<{ name: string; url: string }> = [];
  private texCache = new Map<string, { tex: WebGLTexture; aspect: number; lastUsed: number }>();
  private texLoading = new Map<string, Promise<{ tex: WebGLTexture; aspect: number }>>();
  private texClock = 0;
  private static readonly TEX_CACHE_CAP = 8;

  private pbo: WebGLBuffer | null = null;
  private fence: WebGLSync | null = null;
  private readbackData = new Uint8Array(16 * 16 * 4);
  private frameCount = 0;

  private w = 2;
  private h = 2;

  private loseCtxExt: WEBGL_lose_context | null = null;

  private freshContext = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      powerPreference: "high-performance",
    });
    if (!gl) {
      throw new Error("WebGL2 unavailable");
    }
    this.gl = gl;
    this.loseCtxExt = gl.getExtension("WEBGL_lose_context");
    this.build();
  }

  private compile(type: number, src: string, tag: string): WebGLShader {
    const gl = this.gl;
    const s = gl.createShader(type);
    if (!s) {
      throw new Error("createShader failed");
    }
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error(`${tag}: ${log}`);
    }
    return s;
  }

  private link(fragSrc: string, tag: string): Program {
    const gl = this.gl;
    const vs = this.compile(gl.VERTEX_SHADER, VERT, `${tag}.vert`);
    const fs = this.compile(gl.FRAGMENT_SHADER, fragSrc, `${tag}.frag`);
    const prog = gl.createProgram();
    if (!prog) {
      throw new Error("createProgram failed");
    }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error(`${tag}.link: ${log}`);
    }
    return { fs, loc: new Map(), prog, vs };
  }

  private deleteProgram(p: Program): void {
    const gl = this.gl;
    gl.deleteProgram(p.prog);
    gl.deleteShader(p.vs);
    gl.deleteShader(p.fs);
  }

  private u(p: Program, name: string): WebGLUniformLocation | null {
    if (!p.loc.has(name)) {
      p.loc.set(name, this.gl.getUniformLocation(p.prog, name));
    }
    return p.loc.get(name) ?? null;
  }

  private makeTarget(w: number, h: number): Target {
    const gl = this.gl;
    const tex = gl.createTexture();
    const fbo = gl.createFramebuffer();
    if (!tex || !fbo) {
      throw new Error("makeTarget failed");
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, h, tex, w };
  }

  private deleteTarget(t: Target | undefined): void {
    if (!t) {
      return;
    }
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fbo);
  }

  build(): void {
    const gl = this.gl;

    this.loseCtxExt = gl.getExtension("WEBGL_lose_context");
    this.quad = gl.createBuffer() as WebGLBuffer;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    this.pBase = this.link(FRAG, "base");
    this.pCross = this.link(CROSSFADE_FRAG, "crossfade");
    this.pBlit = this.link(BLIT_FRAG, "blit");
    this.pBright = this.link(BLOOM_BRIGHT_FRAG, "bloom-bright");
    this.pBlur = this.link(BLOOM_BLUR_FRAG, "bloom-blur");
    this.pBloomComposite = this.link(BLOOM_COMPOSITE_FRAG, "bloom-composite");

    this.pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, 16 * 16 * 4, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

    this.allocTargets(Math.max(2, this.w), Math.max(2, this.h));
  }

  private allocTargets(w: number, h: number): void {
    if (!this.freshContext) {
      this.deleteTarget(this.fboBase);
      this.deleteTarget(this.fboReplay);
      this.deleteTarget(this.fboComposite);
      this.deleteTarget(this.fboFinal);
      this.deleteTarget(this.fboBloomA);
      this.deleteTarget(this.fboBloomB);
      this.deleteTarget(this.fboSmall);
    }
    this.freshContext = false;
    const hw = Math.max(1, Math.floor(w / 2));
    const hh = Math.max(1, Math.floor(h / 2));
    this.fboBase = this.makeTarget(w, h);
    this.fboReplay = this.makeTarget(w, h);
    this.fboComposite = this.makeTarget(w, h);
    this.fboFinal = this.makeTarget(w, h);
    this.fboBloomA = this.makeTarget(hw, hh);
    this.fboBloomB = this.makeTarget(hw, hh);
    this.fboSmall = this.makeTarget(16, 16);
    this.w = w;
    this.h = h;
  }

  resize(w: number, h: number): void {
    if (w === this.w && h === this.h) {
      return;
    }
    this.canvas.width = w;
    this.canvas.height = h;
    this.allocTargets(w, h);
  }

  setReplay(layers: SceneLayer[]): void {
    this.disposeReplay();

    const urlByName = new Map<string, string>();
    for (const layer of layers) {
      for (const t of layer.textures) {
        if (t.url && !urlByName.has(t.name)) {
          urlByName.set(t.name, t.url);
        }
      }
    }
    const sceneNames = [...urlByName.keys()];
    this.replayUnits = assignTextureUnits(sceneNames);
    this.replayTextureUrls = sceneNames.flatMap((name) => {
      const url = urlByName.get(name);
      return url ? [{ name, url }] : [];
    });

    for (const layer of layers) {
      const names = layer.textures.filter((t) => t.url).map((t) => t.name);
      const declaredInBody = new Set(names.filter((n) => bodyDeclaresSampler(layer.body, n)));
      const decls = textureUniformDecls(names, declaredInBody);
      const prog = this.link(REPLAY_HEADER + decls + layer.body, "replay");
      this.replayLayers.push({
        blend: layer.blend,
        customs: layer.customUniforms,
        prog,
        textureNames: names,
      });
    }

    this.integrators = [];
    for (const layer of layers) {
      for (const c of layer.customUniforms) {
        if (c.class !== "velocityPos") {
          continue;
        }
        const type = c.type === "vec2" ? "vec2" : "float";

        const a = (Math.abs(this.hashName(c.name)) % 360) * (Math.PI / 180);
        this.integrators.push({
          dir: [Math.cos(a), Math.sin(a)],
          pos: c.name,
          step: 0,
          type,
          vel: c.name + "Vel",
          x: 0,
          y: 0,
        });
      }
    }
  }

  get replayNeedsTextures(): boolean {
    return this.replayTextureUrls.length > 0;
  }

  async loadReplayTextures(): Promise<void> {
    const wanted = this.replayTextureUrls;
    if (wanted.length === 0) {
      return;
    }
    const loaded = await Promise.all(
      wanted.map(async ({ name, url }) => ({ name, tex: await this.loadTexture(url) })),
    );
    const map = new Map<string, { tex: WebGLTexture; aspect: number }>();
    for (const { name, tex } of loaded) {
      map.set(name, tex);
    }
    this.activeTextures = map;
  }

  prefetchTextures(urls: readonly string[]): void {
    for (const url of urls) {
      void this.loadTexture(url).catch(() => undefined);
    }
  }

  private async loadTexture(url: string): Promise<{ tex: WebGLTexture; aspect: number }> {
    const cached = this.texCache.get(url);
    if (cached) {
      cached.lastUsed = ++this.texClock;
      return { aspect: cached.aspect, tex: cached.tex };
    }
    const inflight = this.texLoading.get(url);
    if (inflight) {
      return inflight;
    }
    const p = this.fetchAndUpload(url).finally(() => this.texLoading.delete(url));
    this.texLoading.set(url, p);
    return p;
  }

  private async fetchAndUpload(url: string): Promise<{ tex: WebGLTexture; aspect: number }> {
    const img = await loadImage(url);
    const tex = this.uploadTexture(img);
    const aspect = img.naturalHeight === 0 ? 1 : img.naturalWidth / img.naturalHeight;
    this.texCache.set(url, { aspect, lastUsed: ++this.texClock, tex });
    this.evictTextures();
    return { aspect, tex };
  }

  private uploadTexture(img: HTMLImageElement): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) {
      throw new Error("createTexture failed");
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private evictTextures(): void {
    const pinned = new Set(this.replayTextureUrls.map((u) => u.url));
    while (this.texCache.size > GlassPipeline.TEX_CACHE_CAP) {
      let victim: string | null = null;
      let oldest = Infinity;
      for (const [url, e] of this.texCache) {
        if (pinned.has(url)) {
          continue;
        }
        if (e.lastUsed < oldest) {
          oldest = e.lastUsed;
          victim = url;
        }
      }
      if (victim === null) {
        break;
      }
      const v = this.texCache.get(victim);
      if (v) {
        this.gl.deleteTexture(v.tex);
      }
      this.texCache.delete(victim);
    }
  }

  private bindLayerTextures(p: Program, names: string[]): void {
    const gl = this.gl;
    for (const name of names) {
      const t = this.activeTextures.get(name);
      if (!t) {
        continue;
      }
      const unit = this.replayUnits[name] ?? 0;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      const sampler = this.u(p, name);
      if (sampler !== null) {
        gl.uniform1i(sampler, unit);
      }
      const aspect = this.u(p, `${name}AspectRatio`);
      if (aspect !== null) {
        gl.uniform1f(aspect, t.aspect);
      }
    }
  }

  private hashName(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h | 0;
  }

  disposeReplay(): void {
    for (const l of this.replayLayers) {
      this.deleteProgram(l.prog);
    }
    this.replayLayers = [];
    this.integrators = [];

    this.activeTextures = new Map();
    this.replayUnits = {};
    this.replayTextureUrls = [];
  }

  get replayLayerCount(): number {
    return this.replayLayers.length;
  }

  debugIntegrators(): Array<{ pos: number; step: number }> {
    return this.integrators.map((it) => ({
      pos: it.type === "vec2" ? Math.hypot(it.x, it.y) : it.x,
      step: it.step,
    }));
  }

  private pass(p: Program, target: Target | null, vw: number, vh: number, setup: () => void): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, vw, vh);
    gl.useProgram(p.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const a = gl.getAttribLocation(p.prog, "a");
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    setup();
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private bindTex(unit: number, t: Target, p: Program, sampler: string): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.uniform1i(this.u(p, sampler), unit);
  }

  render(
    base: BaseFrameInputs,
    replay: { active: boolean; fade: number; inputs: ReplayFrameInputs } | null,
    bloom: BloomConfig | null,
  ): void {
    const gl = this.gl;
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0, (now - this.lastMs) / 1000));
    this.lastMs = now;
    this.frameCount++;

    this.pass(this.pBase, this.fboBase, this.w, this.h, () => {
      gl.uniform2f(this.u(this.pBase, "u_res"), this.w, this.h);
      gl.uniform1f(this.u(this.pBase, "u_time"), base.time);
      gl.uniform1f(this.u(this.pBase, "u_bass"), base.bass);
      gl.uniform1f(this.u(this.pBase, "u_mid"), base.mid);
      gl.uniform1f(this.u(this.pBase, "u_treble"), base.treble);
      gl.uniform1f(this.u(this.pBase, "u_energy"), base.energy);
      gl.uniform1f(this.u(this.pBase, "u_kickHit"), base.kick);
      gl.uniform1f(this.u(this.pBase, "u_swell"), base.swell);
      gl.uniform1f(this.u(this.pBase, "u_scene"), base.scene);
      gl.uniform1f(this.u(this.pBase, "u_holding"), base.holding);
      gl.uniform1f(this.u(this.pBase, "u_seed"), base.seed);
      gl.uniform3fv(this.u(this.pBase, "u_palette[0]"), base.palette);
    });

    const replayActive = replay?.active && this.replayLayers.length > 0;
    if (replayActive && replay) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboReplay.fbo);
      gl.viewport(0, 0, this.w, this.h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      for (let i = 0; i < this.replayLayers.length; i++) {
        const layer = this.replayLayers[i];
        if (i === 0 || layer.blend === "opaque") {
          gl.disable(gl.BLEND);
        } else {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        }
        this.pass(layer.prog, this.fboReplay, this.w, this.h, () => {
          this.setReplayUniforms(layer.prog, layer.customs, replay.inputs, dt);
          this.bindLayerTextures(layer.prog, layer.textureNames);
        });
      }
      gl.disable(gl.BLEND);
    }

    const fade = replayActive && replay ? replay.fade : 0;
    this.pass(this.pCross, this.fboComposite, this.w, this.h, () => {
      this.bindTex(0, this.fboBase, this.pCross, "u_base");
      this.bindTex(1, this.fboReplay, this.pCross, "u_replay");
      gl.uniform2f(this.u(this.pCross, "u_res"), this.w, this.h);
      gl.uniform1f(this.u(this.pCross, "u_fade"), fade);
      gl.uniform1f(this.u(this.pCross, "u_time"), base.time);
    });

    if (bloom) {
      this.runBloom(this.fboComposite, bloom);
    } else {
      this.pass(this.pBlit, this.fboFinal, this.w, this.h, () => {
        this.bindTex(0, this.fboComposite, this.pBlit, "u_tex");
        gl.uniform2f(this.u(this.pBlit, "u_res"), this.w, this.h);
      });
    }

    this.pass(this.pBlit, null, this.w, this.h, () => {
      this.bindTex(0, this.fboFinal, this.pBlit, "u_tex");
      gl.uniform2f(this.u(this.pBlit, "u_res"), this.w, this.h);
    });

    if (this.frameCount % 3 === 0) {
      this.pass(this.pBlit, this.fboSmall, 16, 16, () => {
        this.bindTex(0, this.fboFinal, this.pBlit, "u_tex");
        gl.uniform2f(this.u(this.pBlit, "u_res"), 16, 16);
      });
      this.startReadback();
    }
  }

  private setReplayUniforms(
    p: Program,
    customs: CustomU[],
    inp: ReplayFrameInputs,
    dt: number,
  ): void {
    const gl = this.gl;
    gl.uniform1f(this.u(p, "u_time"), inp.time);
    gl.uniform2f(this.u(p, "u_res"), this.w, this.h);
    gl.uniform1f(this.u(p, "u_progress"), inp.progress);
    gl.uniform1f(this.u(p, "u_energy"), inp.energy);
    gl.uniform1f(this.u(p, "u_bass"), inp.bass);
    gl.uniform1f(this.u(p, "u_mid"), inp.mid);
    gl.uniform1f(this.u(p, "u_treble"), inp.treble);
    gl.uniform1f(this.u(p, "u_beatPulse"), inp.kick);
    gl.uniform1f(this.u(p, "u_onsetPulse"), inp.kick);
    gl.uniform1f(this.u(p, "u_audioHit"), inp.kick);
    gl.uniform1f(this.u(p, "u_audioSwell"), inp.swell);
    gl.uniform1f(this.u(p, "u_audioDrop"), inp.drop);
    gl.uniform1f(
      this.u(p, "u_audioDisturbance"),
      Math.min(inp.kick * 0.5 + inp.swell * 0.3 + inp.drop * 0.5, 1.2),
    );

    gl.uniform1f(this.u(p, "u_energyFast"), inp.energyFast);
    gl.uniform1f(this.u(p, "u_bassFast"), inp.bassFast);
    gl.uniform1f(this.u(p, "u_midFast"), inp.midFast);
    gl.uniform1f(this.u(p, "u_trebleFast"), inp.trebleFast);
    gl.uniform1f(this.u(p, "u_flux"), inp.kick);
    gl.uniform1f(this.u(p, "u_sub"), inp.bass);
    gl.uniform1f(this.u(p, "u_kickHit"), inp.kick);
    gl.uniform1f(this.u(p, "u_snareHit"), inp.midFast * inp.kick);
    gl.uniform1f(this.u(p, "u_air"), inp.treble);
    gl.uniform1f(this.u(p, "u_downbeatPulse"), inp.kick);
    gl.uniform1f(this.u(p, "u_seed"), inp.seedRaw);
    gl.uniform3fv(this.u(p, "u_palette[0]"), inp.palette);

    for (const c of customs) {
      const l = this.u(p, c.name);
      if (l === null) {
        continue;
      }
      if (c.type === "vec3") {
        const stop = typeof c.params?.stop === "number" ? (c.params.stop as number) : 2;
        gl.uniform3f(
          l,
          inp.palette[stop * 3],
          inp.palette[stop * 3 + 1],
          inp.palette[stop * 3 + 2],
        );
      } else if (c.class === "riseRamp") {
        const x = Math.min(inp.dwellSec / 30, 1);
        gl.uniform1f(l, x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
      } else if (c.class === "settleDim") {
        gl.uniform1f(l, typeof c.params?.hold === "number" ? (c.params.hold as number) : 1);
      } else if (c.class === "audioAlias") {
        const f = (c.params?.field as string) || "swell";
        const v =
          f === "bass"
            ? inp.bass
            : f === "mid"
              ? inp.mid
              : f === "treble"
                ? inp.treble
                : f === "hit"
                  ? inp.kick
                  : f === "drop"
                    ? inp.drop
                    : inp.swell;
        gl.uniform1f(l, v);
      }
    }

    for (const it of this.integrators) {
      const speed =
        it.type === "vec2" ? 0.1 * (1 + 0.25 * inp.swell) : 0.3 * (1 + 0.25 * inp.swell);
      if (it.type === "vec2") {
        it.x += it.dir[0] * speed * dt;
        it.y += it.dir[1] * speed * dt;
        it.step = Math.hypot(it.dir[0] * speed * dt, it.dir[1] * speed * dt);
        const lp = this.u(p, it.pos);
        if (lp) {
          gl.uniform2f(lp, it.x, it.y);
        }
        const lv = this.u(p, it.vel);
        if (lv) {
          gl.uniform2f(lv, it.dir[0] * speed, it.dir[1] * speed);
        }
      } else {
        it.x += speed * dt;
        it.step = speed * dt;
        const lp = this.u(p, it.pos);
        if (lp) {
          gl.uniform1f(lp, it.x);
        }
        const lv = this.u(p, it.vel);
        if (lv) {
          gl.uniform1f(lv, speed);
        }
      }
    }
  }

  private runBloom(scene: Target, cfg: BloomConfig): void {
    const gl = this.gl;
    const hw = this.fboBloomA.w;
    const hh = this.fboBloomA.h;

    this.pass(this.pBright, this.fboBloomA, hw, hh, () => {
      this.bindTex(0, scene, this.pBright, "u_tex");
      gl.uniform2f(this.u(this.pBright, "u_res"), hw, hh);
      gl.uniform1f(this.u(this.pBright, "u_threshold"), cfg.threshold);
    });

    for (let i = 0; i < 4; i++) {
      this.pass(this.pBlur, this.fboBloomB, hw, hh, () => {
        this.bindTex(0, this.fboBloomA, this.pBlur, "u_tex");
        gl.uniform2f(this.u(this.pBlur, "u_res"), hw, hh);
        gl.uniform2f(this.u(this.pBlur, "u_dir"), cfg.radius, 0);
      });
      this.pass(this.pBlur, this.fboBloomA, hw, hh, () => {
        this.bindTex(0, this.fboBloomB, this.pBlur, "u_tex");
        gl.uniform2f(this.u(this.pBlur, "u_res"), hw, hh);
        gl.uniform2f(this.u(this.pBlur, "u_dir"), 0, cfg.radius);
      });
    }

    this.pass(this.pBloomComposite, this.fboFinal, this.w, this.h, () => {
      this.bindTex(0, scene, this.pBloomComposite, "u_scene");
      this.bindTex(1, this.fboBloomA, this.pBloomComposite, "u_bloom");
      gl.uniform2f(this.u(this.pBloomComposite, "u_res"), this.w, this.h);
      gl.uniform1f(this.u(this.pBloomComposite, "u_intensity"), cfg.intensity);
    });
  }

  private startReadback(): void {
    const gl = this.gl;
    if (this.fence || !this.pbo) {
      return;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboSmall.fbo);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.readPixels(0, 0, 16, 16, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
  }

  pollReadback(): [number, number, number] | null {
    const gl = this.gl;
    if (!this.fence || !this.pbo) {
      return null;
    }
    const status = gl.clientWaitSync(this.fence, 0, 0);
    if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED) {
      return null;
    }
    gl.deleteSync(this.fence);
    this.fence = null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.readbackData);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    let r = 0,
      g = 0,
      b = 0;
    const n = 16 * 16;
    for (let i = 0; i < n; i++) {
      r += this.readbackData[i * 4];
      g += this.readbackData[i * 4 + 1];
      b += this.readbackData[i * 4 + 2];
    }
    return [r / n / 255, g / n / 255, b / n / 255];
  }

  isContextLost(): boolean {
    return this.gl.isContextLost();
  }

  loseContextForSmoke(): void {
    this.loseCtxExt?.loseContext();
  }
  restoreContextForSmoke(): void {
    this.loseCtxExt?.restoreContext();
  }

  rebuild(): void {
    this.replayLayers = [];
    this.integrators = [];

    this.activeTextures = new Map();
    this.replayUnits = {};
    this.replayTextureUrls = [];
    this.texCache = new Map();
    this.texLoading = new Map();
    this.fence = null;
    this.pbo = null;
    this.freshContext = true;
    this.build();
  }

  destroy(): void {
    this.disposeReplay();
    for (const e of this.texCache.values()) {
      this.gl.deleteTexture(e.tex);
    }
    this.texCache = new Map();
    this.deleteTarget(this.fboBase);
    this.deleteTarget(this.fboReplay);
    this.deleteTarget(this.fboComposite);
    this.deleteTarget(this.fboFinal);
    this.deleteTarget(this.fboBloomA);
    this.deleteTarget(this.fboBloomB);
    this.deleteTarget(this.fboSmall);
    this.deleteProgram(this.pBase);
    this.deleteProgram(this.pCross);
    this.deleteProgram(this.pBlit);
    this.deleteProgram(this.pBright);
    this.deleteProgram(this.pBlur);
    this.deleteProgram(this.pBloomComposite);
    if (this.pbo) {
      this.gl.deleteBuffer(this.pbo);
    }
  }
}
