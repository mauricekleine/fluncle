// The glass render pipeline — ONE WebGL2 context, one shared FBO chain (RFC §3's
// "one shared post-pass FBO"). Productionizes the seed's two-canvas crossfade into
// a single-context graph so the constructive rails, bloom, and the OUTPUT-side flash
// monitor all read the SAME rendered pixels:
//
//   base vehicle ─▶ fboBase ─┐
//                            ├─▶ crossfade + Warm-Dark/grain rails ─▶ fboComposite
//   replay layers ─▶ fboReplay┘         (multi-layer: layer0 opaque, later over)
//                            │
//   fboComposite ─▶ [bloom bright▶blur▶composite | blit] ─▶ fboFinal ─▶ screen
//                            └─▶ downsample ─▶ 16×16 ─▶ ASYNC PBO readback ─▶ mean colour
//
// build() compiles every static program + allocates the FBOs; it is the ONE code
// path shared by cold boot AND webglcontextrestored (RFC §4). setReplay() compiles
// the matched finding's own layer program(s) and arms the JS velocity integrator.
import { type BloomConfig } from "../glsl-runtime.ts";
import {
  BLIT_FRAG,
  BLOOM_BLUR_FRAG,
  BLOOM_BRIGHT_FRAG,
  BLOOM_COMPOSITE_FRAG,
  FRAG,
  REPLAY_HEADER,
  VERT,
} from "../glsl-runtime.ts";
import { type CustomU, type SceneLayer } from "../scene-extract.ts";

// The crossfade + shared rails: mix the base and replay fields, clamp to the Warm
// Dark ceiling, and keep a grain floor so the frame is never a dead flat black.
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
  // header uniforms (already scalar-limited by the source-side FlashLimiter)
  time: number;
  progress: number;
  bass: number;
  mid: number;
  treble: number;
  energy: number;
  kick: number;
  swell: number;
  drop: number;
  seedRaw: number;
  palette: Float32Array; // 12 floats
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
};

export class GlassPipeline {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private quad!: WebGLBuffer;

  // static programs
  private pBase!: Program;
  private pCross!: Program;
  private pBlit!: Program;
  private pBright!: Program;
  private pBlur!: Program;
  private pBloomComposite!: Program;

  // targets (allocated in build/resize)
  private fboBase!: Target;
  private fboReplay!: Target;
  private fboComposite!: Target;
  private fboFinal!: Target;
  private fboBloomA!: Target;
  private fboBloomB!: Target;
  private fboSmall!: Target;

  // replay (per-arrival) state
  private replayLayers: Array<{ prog: Program; customs: CustomU[]; blend: "opaque" | "over" }> = [];
  private integrators: VelEntry[] = [];
  private lastMs = performance.now();

  // async readback
  private pbo: WebGLBuffer | null = null;
  private fence: WebGLSync | null = null;
  private readbackData = new Uint8Array(16 * 16 * 4);
  private frameCount = 0;

  private w = 2;
  private h = 2;
  // Cached at construction — getExtension() returns null on an already-lost context,
  // so the smoke must hold the reference from before the loss.
  private loseCtxExt: WEBGL_lose_context | null = null;
  // True during a post-restore rebuild: the old GL objects are gone with the dead
  // context, so allocTargets must NOT try to delete them.
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

  // ---- program + target helpers ----
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

  // ---- build (cold boot AND context restore share this ONE path) ----
  build(): void {
    const gl = this.gl;
    // Re-query the lose-context ext each build so a repeated smoke works after a
    // restore (extension objects from before a loss are invalidated by the restore).
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
    // After a context RESTORE the old targets belong to the dead context — deleting
    // them throws INVALID_OPERATION. freshContext skips the (unnecessary) cleanup.
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

  // ---- replay: compile the matched finding's own layer program(s) ----
  setReplay(layers: SceneLayer[]): void {
    this.disposeReplay();
    for (const layer of layers) {
      const prog = this.link(REPLAY_HEADER + layer.body, "replay"); // throws on failure -> caller frees
      this.replayLayers.push({ blend: layer.blend, customs: layer.customUniforms, prog });
    }
    // Arm the velocity integrator: each velocityPos + its …Vel sibling.
    this.integrators = [];
    for (const layer of layers) {
      for (const c of layer.customUniforms) {
        if (c.class !== "velocityPos") {
          continue;
        }
        const type = c.type === "vec2" ? "vec2" : "float";
        // seeded diagonal so a vec2 glide streams a consistent one-way direction.
        const a = (Math.abs(this.hashName(c.name)) % 360) * (Math.PI / 180);
        this.integrators.push({
          dir: [Math.cos(a), Math.sin(a)],
          pos: c.name,
          type,
          vel: c.name + "Vel",
          x: 0,
          y: 0,
        });
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
  }

  get replayLayerCount(): number {
    return this.replayLayers.length;
  }

  // ---- a fullscreen-triangle pass ----
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

  // ---- the frame ----
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

    // 1. base vehicle -> fboBase
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

    // 2. replay layers -> fboReplay (opaque layer0, alpha-over the rest)
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
        });
      }
      gl.disable(gl.BLEND);
    }

    // 3. crossfade + rails -> fboComposite
    const fade = replayActive && replay ? replay.fade : 0;
    this.pass(this.pCross, this.fboComposite, this.w, this.h, () => {
      this.bindTex(0, this.fboBase, this.pCross, "u_base");
      this.bindTex(1, this.fboReplay, this.pCross, "u_replay");
      gl.uniform2f(this.u(this.pCross, "u_res"), this.w, this.h);
      gl.uniform1f(this.u(this.pCross, "u_fade"), fade);
      gl.uniform1f(this.u(this.pCross, "u_time"), base.time);
    });

    // 4. bloom (optional) or blit -> fboFinal
    if (bloom) {
      this.runBloom(this.fboComposite, bloom);
    } else {
      this.pass(this.pBlit, this.fboFinal, this.w, this.h, () => {
        this.bindTex(0, this.fboComposite, this.pBlit, "u_tex");
        gl.uniform2f(this.u(this.pBlit, "u_res"), this.w, this.h);
      });
    }

    // 5. fboFinal -> screen
    this.pass(this.pBlit, null, this.w, this.h, () => {
      this.bindTex(0, this.fboFinal, this.pBlit, "u_tex");
      gl.uniform2f(this.u(this.pBlit, "u_res"), this.w, this.h);
    });

    // 6. downsample fboFinal -> 16x16 for the output-side readback (kick every 3rd frame)
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
    gl.uniform1f(this.u(p, "u_energyFast"), inp.energy);
    gl.uniform1f(this.u(p, "u_bassFast"), inp.bass);
    gl.uniform1f(this.u(p, "u_midFast"), inp.mid);
    gl.uniform1f(this.u(p, "u_trebleFast"), inp.treble);
    gl.uniform1f(this.u(p, "u_flux"), inp.kick);
    gl.uniform1f(this.u(p, "u_sub"), inp.bass);
    gl.uniform1f(this.u(p, "u_kickHit"), inp.kick);
    gl.uniform1f(this.u(p, "u_snareHit"), inp.mid * inp.kick);
    gl.uniform1f(this.u(p, "u_air"), inp.treble);
    gl.uniform1f(this.u(p, "u_downbeatPulse"), inp.kick);
    gl.uniform1f(this.u(p, "u_seed"), inp.seedRaw);
    gl.uniform3fv(this.u(p, "u_palette[0]"), inp.palette);

    // journey-helper customs, per their classified role
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
      // velocityPos / velocity are set by the integrator below.
    }

    // velocity integrator: advance each position at frame rate, set pos + its Vel.
    for (const it of this.integrators) {
      const speed =
        it.type === "vec2" ? 0.1 * (1 + 0.25 * inp.swell) : 0.3 * (1 + 0.25 * inp.swell);
      if (it.type === "vec2") {
        it.x += it.dir[0] * speed * dt;
        it.y += it.dir[1] * speed * dt;
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
    // bright: scene(full) -> bloomA(half)
    this.pass(this.pBright, this.fboBloomA, hw, hh, () => {
      this.bindTex(0, scene, this.pBright, "u_tex");
      gl.uniform2f(this.u(this.pBright, "u_res"), hw, hh);
      gl.uniform1f(this.u(this.pBright, "u_threshold"), cfg.threshold);
    });
    // separable blur, a few iterations (A -H-> B -V-> A)
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
    // composite scene + bloom -> fboFinal
    this.pass(this.pBloomComposite, this.fboFinal, this.w, this.h, () => {
      this.bindTex(0, scene, this.pBloomComposite, "u_scene");
      this.bindTex(1, this.fboBloomA, this.pBloomComposite, "u_bloom");
      gl.uniform2f(this.u(this.pBloomComposite, "u_res"), this.w, this.h);
      gl.uniform1f(this.u(this.pBloomComposite, "u_intensity"), cfg.intensity);
    });
  }

  // ---- async output readback (WebGL2 PBO + fence; never a per-frame sync stall) ----
  private startReadback(): void {
    const gl = this.gl;
    if (this.fence || !this.pbo) {
      return; // one in flight
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboSmall.fbo);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.readPixels(0, 0, 16, 16, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
  }

  /** Poll the in-flight readback; returns the frame's mean colour when ready, else null. */
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

  /** Debug: force a context loss to smoke-test the rebuild path. */
  loseContextForSmoke(): void {
    this.loseCtxExt?.loseContext();
  }
  restoreContextForSmoke(): void {
    this.loseCtxExt?.restoreContext();
  }

  /** Rebuild after webglcontextrestored — the SAME path as cold boot. Replay is dropped. */
  rebuild(): void {
    this.replayLayers = [];
    this.integrators = [];
    this.fence = null;
    this.pbo = null;
    this.freshContext = true; // the old GL objects died with the lost context
    this.build();
  }

  destroy(): void {
    this.disposeReplay();
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
