// The glass — client orchestrator. Owns the plan, the pointer, arrivals, holding,
// intensity and the render loop; drives the GlassPipeline; and wires the crown
// (source-side FlashLimiter + output-side FlashMonitor), the bridge, and the RFC §4
// reliability rails. Standalone-complete: with no bridge it is the v0.6 failure floor.
import { type ShowState } from "../../contract.ts";
import { type BloomConfig } from "../glsl-runtime.ts";
import { DEFAULT_BLOOM } from "../glsl-runtime.ts";
import { FlashLimiter, FlashMonitor, isSaturatedRed, redValue } from "../flash-limiter.ts";
import {
  bindingsByGroup,
  GROUP_LABEL,
  KEY_GROUPS,
  type KeybindingId,
  keyToBinding,
} from "../keybindings.ts";
import { type Scene } from "../scene-extract.ts";
import { settleGain } from "../settle.ts";
import { BridgeClient } from "./bridge.ts";
import { Dsp, MIC_CONSTRAINTS } from "./dsp.ts";
import { GlassPipeline } from "./pipeline.ts";

type PlanItem = {
  logId: string;
  title: string;
  artists: string[];
  foundAt: string | null;
  palette: {
    background?: string;
    accent?: string;
    glow?: string;
    ink?: string;
    swatches?: string[];
  } | null;
  seed: number | null;
  durationMs: number | null;
  videoVehicle: string | null;
  replay: Scene;
};

const CANON: number[][] = [
  [0.035, 0.039, 0.043],
  [1.0, 0.42, 0.34],
  [0.96, 0.72, 0.0],
  [0.957, 0.918, 0.843],
];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const err = (m: string): void => {
  $("err").textContent = m;
};
// ---- palette helpers -------------------------------------------------------
function hexToRgb(h?: string): number[] | null {
  if (!h) {
    return null;
  }
  h = h.replace("#", "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function warmDarkClamp(rgb: number[] | null): number[] {
  if (!rgb) {
    return CANON[0].slice();
  }
  const cap = 0.11;
  const mx = Math.max(rgb[0], rgb[1], rgb[2]);
  const k = mx > cap ? cap / mx : 1;
  return [rgb[0] * k, rgb[1] * k, rgb[2] * k];
}
function paletteFromEntry(e: PlanItem): number[][] {
  const P = e.palette;
  if (!P) {
    return CANON.map((c) => c.slice());
  }
  const bg = warmDarkClamp(hexToRgb(P.background));
  const accent = hexToRgb(P.accent) || CANON[1];
  const glow = hexToRgb(P.glow) || CANON[2];
  return [bg, accent.map((c) => c * 0.5), accent, glow];
}
function paletteReplay(e: PlanItem): number[][] {
  const P = e.palette;
  if (!P) {
    return CANON.map((c) => c.slice());
  }
  return [
    hexToRgb(P.background) || CANON[0],
    hexToRgb(P.accent) || CANON[1],
    hexToRgb(P.glow) || CANON[2],
    hexToRgb(P.ink) || hexToRgb(P.glow) || CANON[3],
  ];
}
function flat(stops: number[][]): number[] {
  return ([] as number[]).concat(stops[0], stops[1], stops[2], stops[3]);
}
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function vehicleToScene(tag: string | null | undefined): number {
  if (!tag) {
    return -1;
  }
  const t = tag.toLowerCase();
  if (/caustic|liquid|ripple|refract|glass|water|crystal|iridescent|thin-film|film|veil/.test(t)) {
    return 0;
  }
  if (/filament|vein|wire|dendrite|weft|sinew|thread|web|strand|neuro|nerve/.test(t)) {
    return 1;
  }
  if (
    /roil|smoke|cloud|field|drape|bloom|swarm|murmur|spindrift|flux|drift|haze|plume|mist|billow|dust|vapor|fog/.test(
      t,
    )
  ) {
    return 2;
  }
  return -1;
}
const vehName = (i: number): string =>
  i === 0 ? "caustic" : i === 1 ? "neuro" : i === 2 ? "roil" : "hash";

// ---- pipeline + audio + limiter + monitor + bridge -------------------------
const canvas = $("c") as HTMLCanvasElement;
let pipeline: GlassPipeline;
try {
  pipeline = new GlassPipeline(canvas);
} catch (e) {
  err("WebGL2 init failed: " + (e as Error).message);
  throw e;
}
const dsp = new Dsp();
const limiter = new FlashLimiter();
const monitor = new FlashMonitor();
const bridge = new BridgeClient();

// ---- state -----------------------------------------------------------------
let PLAN: PlanItem[] = [];
let pointer = -1;
let scene = 0;
let sceneTarget = 0;
let autoMorph = false;
let dipped = false;
let dipT = 0;
let renderScale = 0.75;
let palCur = flat(CANON.map((c) => c.slice()));
let palTar = flat(CANON.map((c) => c.slice()));
let palCurR = flat(CANON.map((c) => c.slice()));
let palTarR = flat(CANON.map((c) => c.slice()));
let seedCur = 0;
let seedTar = 0;
let seedRawCur = 0;
let seedRawTar = 0;
let holdCur = 0;
let intensity = 1.0;
let manualHold = false;
let blackoutEngaged = false;
let silenceHold = false;
let blackoutTimer: ReturnType<typeof setTimeout> | null = null;
let silentSince = 0;
let replayEnabled = true;
let replayActive = false;
let replayFade = 0;
let arriveMs = 0;
let replayExpectedLenMs = 300000;
let bloomEnabled = true;
let currentBloom: BloomConfig | null = null;
let worldStatus = "world: —";
let outputTripCooldown = 0; // frames of forced holding after an output-side trip
let smokeResult = "not run";

// Arrival settle guard (fix for the "racing" arrival): eases the audio-reactive input
// gains up from a floor over ~1.5s so a fresh world wakes rather than spawns mid-sprint,
// and snaps the raw seed (a world's identity is never swept through). `?noSettle=1`
// disables it for an A/B; `?trace=1` prints the 100ms arrival uniform trace to console.
const PARAMS = new URLSearchParams(location.search);
const settleGuardOn = !PARAMS.has("noSettle");
const traceOn = PARAMS.has("trace");
let traceLastMs = 0;

// ---- plate -----------------------------------------------------------------
function foundStr(iso: string | null): string {
  if (!iso) {
    return "";
  }
  const d = new Date(iso);
  if (isNaN(d.getTime())) {
    return "";
  }
  return "Found " + MONTHS[d.getUTCMonth()] + " " + d.getUTCDate();
}
let plateVisible = true;
function showPlate(e: PlanItem): void {
  if (!plateVisible) {
    return;
  }
  $("p-coord").textContent = e.logId;
  $("p-title").textContent = e.title || "";
  $("p-artist").textContent = (e.artists || []).join(", ");
  const f = foundStr(e.foundAt);
  const fe = $("p-found");
  fe.textContent = f;
  fe.style.display = f ? "block" : "none";
  $("plate").classList.add("show");
}

// ---- arrival ---------------------------------------------------------------
function arrive(idx: number): void {
  if (!PLAN.length) {
    return;
  }
  pointer = ((idx % PLAN.length) + PLAN.length) % PLAN.length;
  const e = PLAN[pointer];
  palTar = flat(paletteFromEntry(e));
  palTarR = flat(paletteReplay(e));
  seedTar = ((e.seed || 0) % 100000) / 100000;
  seedRawTar = e.seed || 0;
  // ROOT FIX for the racing arrival: snap the RAW seed instead of easing it. seedRawCur
  // eased toward a large new seed at 0.06/frame, sweeping u_seed through ~a thousand
  // intermediate values over the first ~1.5s — for any world whose field offset keys off
  // u_seed, that sweep IS the "scene zooming past". A seed is a world's fixed identity;
  // the palette crossfade + arrival fade own the transition, the seed just arrives.
  if (settleGuardOn) {
    seedRawCur = seedRawTar;
  }
  autoMorph = false;
  manualHold = false;
  arriveMs = performance.now();
  traceLastMs = 0;
  replayExpectedLenMs = e.durationMs || 300000;

  const rp = e.replay;
  const vehScene = vehicleToScene(e.videoVehicle);
  let ok = false;
  if (replayEnabled && rp?.replayable && rp.layers.length > 0) {
    try {
      pipeline.setReplay(rp.layers);
      replayActive = true;
      ok = true;
      const layers = rp.layers.length > 1 ? `${rp.layers.length} layers · ` : "";
      worldStatus = `world: replayed (own shader) · ${layers}${rp.customUniforms.length} custom u`;
    } catch (ex) {
      err("replay compile [" + e.logId + "]: " + (ex as Error).message);
      replayActive = false;
      pipeline.disposeReplay();
      worldStatus = `world: default[${vehName(vehScene)}] (replay FAILED to compile — free fallback)`;
    }
  } else {
    replayActive = false;
    pipeline.disposeReplay();
    worldStatus =
      `world: default[${vehName(vehScene)}]` +
      (rp?.replayable ? "" : ` (reason: ${rp?.reason || "n/a"})`);
  }
  currentBloom = ok ? (rp.bloom ?? null) : null;
  sceneTarget = replayActive
    ? hashStr(e.logId) % 3
    : vehScene >= 0
      ? vehScene
      : hashStr(e.logId) % 3;
  showPlate(e);
  updateHud();
}

// ---- keys ------------------------------------------------------------------
// Every action is dispatched through the ONE keybindings table (../keybindings.ts):
// the handler map below is typed `Record<KeybindingId, …>`, so the compiler forces
// it to match the table exactly, and the `i` overlay renders from the SAME table —
// the legend can never drift from the behaviour. `blackout` (press-and-hold, with a
// keyup partner) and `smoke` (Shift+X) stay special-cased inside their handlers, but
// both still ride the table so they appear in the legend.
const HANDLERS: Record<KeybindingId, (ev: KeyboardEvent) => void> = {
  advance: (ev) => {
    ev.preventDefault();
    arrive(pointer < 0 ? 0 : pointer + 1);
    bridge.send({ cmd: "advance" });
  },
  auto: () => {
    autoMorph = !autoMorph;
  },
  blackout: () => {
    if (blackoutEngaged) {
      blackoutEngaged = false;
      bridge.send({ cmd: "blackout", on: false });
      updateHud();
    } else if (!blackoutTimer) {
      $("plate").classList.add("blackarm");
      blackoutTimer = setTimeout(() => {
        blackoutEngaged = true;
        blackoutTimer = null;
        $("plate").classList.remove("blackarm");
        bridge.send({ cmd: "blackout", on: true });
        updateHud();
      }, 360);
    }
  },
  bloom: () => {
    bloomEnabled = !bloomEnabled;
    updateHud();
  },
  demo: () => {
    demo();
  },
  holding: () => {
    manualHold = !manualHold;
  },
  hud: () => {
    const el = $("hud");
    el.style.display = el.style.display === "none" ? "block" : "none";
  },
  intensity: (ev) => {
    if (ev.key === "-" || ev.key === "_") {
      intensity = Math.max(0.4, +(intensity - 0.1).toFixed(2));
    } else {
      // Ceiling 1.6 (was 1.3): operator headroom on the reactive INPUT drive. The
      // OUTPUT rails still bound the frame — the Warm-Dark clamp (crossfade shader),
      // the per-band 1.15 clamp (`cl`), and the source+output flash nets all hold.
      intensity = Math.min(1.6, +(intensity + 0.1).toFixed(2));
    }
    bridge.send({ cmd: "intensity", value: intensity });
    updateHud();
  },
  keys: () => {
    toggleKeysOverlay();
  },
  lowLatency: () => {
    // A/B the low-latency dual-resolution DSP against the legacy single-4096 path.
    dsp.lowLatency = !dsp.lowLatency;
    updateHud();
  },
  plate: () => {
    plateVisible = !plateVisible;
    const el = document.getElementById("plate");
    if (el) {
      el.classList.toggle("show", plateVisible && el.textContent !== "");
    }
  },
  replay: () => {
    replayEnabled = !replayEnabled;
    if (pointer >= 0) {
      arrive(pointer);
    }
  },
  rewind: (ev) => {
    ev.preventDefault();
    arrive(pointer < 0 ? 0 : pointer - 1);
    bridge.send({ cmd: "rewind" });
  },
  scale: () => {
    renderScale = renderScale === 1 ? 0.75 : renderScale === 0.75 ? 0.5 : 1;
  },
  smoke: () => {
    // pre-show smoke: force a context loss (Shift+X), then restore — the rails must
    // rebuild via the SAME path as cold boot. webglcontextrestored writes the verdict.
    smokeResult = "running…";
    updateHud();
    pipeline.loseContextForSmoke();
    setTimeout(() => pipeline.restoreContextForSmoke(), 500);
  },
  vehicle: (ev) => {
    const v = +ev.key - 1;
    sceneTarget = v;
    autoMorph = false;
    replayActive = false;
    pipeline.disposeReplay();
    worldStatus = "world: default[" + vehName(v) + "] (manual vehicle)";
    updateHud();
  },
};
const BY_KEY = keyToBinding();
addEventListener("keydown", (ev: KeyboardEvent) => {
  // Escape only ever closes the overlay; it never dispatches a show action.
  if (ev.key === "Escape") {
    if (keysOverlayOpen) {
      closeKeysOverlay();
    }
    return;
  }
  const binding = BY_KEY.get(ev.key);
  if (!binding) {
    return;
  }
  // Show-safe: the overlay captures nothing but its own close — every show key still
  // acts while it is open (and stays open; `i`/Esc are the only ways out).
  HANDLERS[binding.id](ev);
});
addEventListener("keyup", (ev: KeyboardEvent) => {
  if (ev.key === "b" && blackoutTimer) {
    clearTimeout(blackoutTimer);
    blackoutTimer = null;
    $("plate").classList.remove("blackarm");
  }
});

// ---- keys overlay (the `i` legend) -----------------------------------------
// Generated from the ONE table at boot, hidden until summoned, and never pausing
// the render (the world keeps breathing behind the scrim).
let keysOverlayOpen = false;
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function buildKeysOverlay(): void {
  $("keys-grid").innerHTML = KEY_GROUPS.map((g) => {
    const rows = bindingsByGroup(g)
      .map(
        (b) =>
          `<div class="krow"><span class="k">${escapeHtml(b.label)}</span>` +
          `<span class="a">${escapeHtml(b.action)}</span></div>`,
      )
      .join("");
    return `<div class="kgroup"><div class="khead">${escapeHtml(GROUP_LABEL[g])}</div>${rows}</div>`;
  }).join("");
}
function openKeysOverlay(): void {
  keysOverlayOpen = true;
  $("keys").classList.add("show");
}
function closeKeysOverlay(): void {
  keysOverlayOpen = false;
  $("keys").classList.remove("show");
}
function toggleKeysOverlay(): void {
  if (keysOverlayOpen) {
    closeKeysOverlay();
  } else {
    openKeysOverlay();
  }
}
buildKeysOverlay();

// ---- reliability rail: WebGL context loss (RFC §4) -------------------------
canvas.addEventListener(
  "webglcontextlost",
  (e) => {
    e.preventDefault(); // MANDATORY — lets the context be restored
    smokeResult = "lost…";
    updateHud();
  },
  false,
);
canvas.addEventListener(
  "webglcontextrestored",
  () => {
    pipeline.rebuild(); // ONE code path shared with cold boot
    replayActive = false;
    if (pointer >= 0) {
      arrive(pointer); // re-arm the current world
    }
    smokeResult = "restored OK";
    updateHud();
  },
  false,
);

// ---- render loop -----------------------------------------------------------
const t0 = performance.now();
let fps = 0;
let fpsAcc = 0;
let fpsT = performance.now();
let renderFrame = 0;

function frame(): void {
  const now = (performance.now() - t0) / 1000;
  const nowMs = performance.now();
  renderFrame++;
  const a = dsp.update();

  // auto-morph on a long dip -> surge (a demoted HINT; arrivals own morphs)
  if (autoMorph && a.swell >= 0.08) {
    if (a.energy < a.swell * 0.45 && !dipped) {
      dipped = true;
      dipT = now;
    }
    if (dipped && a.energy > a.swell * 1.15 && now - dipT > 2) {
      dipped = false;
      sceneTarget = (sceneTarget + 1) % 3;
    }
  }

  // silence -> holding
  if (a.energy < 0.03 && a.swell < 0.03) {
    if (!silentSince) {
      silentSince = nowMs;
    }
    if (nowMs - silentSince > 5000) {
      silenceHold = true;
    }
  } else {
    silentSince = 0;
    silenceHold = false;
  }

  // ---- the CROWN: source-side flash limiter ----
  // Intended global luminance drive (the reactive brightness); red proxy from the
  // accent stop when the kick fires. The limiter returns a scalar that caps rises.
  const drive = (a.bass + a.mid + a.treble + a.kick) * 0.25 * intensity;
  const accentR = palCur[6];
  const accentG = palCur[7];
  const accentB = palCur[8];
  const redProxy = {
    saturated: isSaturatedRed(accentR, accentG, accentB),
    value: redValue(accentR, accentG, accentB) * drive,
  };
  const fr = limiter.push(nowMs, Math.min(drive, 1), redProxy);
  const rg = intensity * fr.scalar;
  const cl = (x: number): number => Math.min(x * rg, 1.15);

  // ---- output-side monitor: read the LAST frame's mean colour, trip -> holding ----
  const mean = pipeline.pollReadback();
  if (mean) {
    const m = monitor.push(nowMs, mean[0], mean[1], mean[2]);
    if (m.tripped) {
      outputTripCooldown = 90; // ~1.5s of forced holding
      // eslint-disable-next-line no-console
      console.warn(
        `[flash] output-side trip at ${nowMs.toFixed(0)}ms (general ${m.general}, red ${m.red}) → holding`,
      );
    }
  }
  if (outputTripCooldown > 0) {
    outputTripCooldown--;
  }

  // holding target
  const holdTarget = blackoutEngaged || manualHold || silenceHold || outputTripCooldown > 0 ? 1 : 0;
  holdCur += (holdTarget - holdCur) * 0.06;

  // glide base vehicle crossfade
  const wrap = (sceneTarget + 3 - (scene % 3)) % 3;
  scene += (wrap <= 1.5 ? wrap : wrap - 3) * 0.02;
  if (scene < 0) {
    scene += 3;
  }

  // ease palettes + seed toward the arrival target
  for (let i = 0; i < 12; i++) {
    palCur[i] += (palTar[i] - palCur[i]) * 0.035;
    palCurR[i] += (palTarR[i] - palCurR[i]) * 0.035;
  }
  seedCur += (seedTar - seedCur) * 0.035;
  seedRawCur += (seedRawTar - seedRawCur) * 0.06;

  // replay crossfade (fade OUT under holding — the rails hold, replay never survives blackout)
  const fadeTarget = replayActive ? 1 : 0;
  replayFade += (fadeTarget - replayFade) * 0.05;
  const effFade = replayFade * (1 - holdCur);

  // resize
  const tw = Math.round(innerWidth * Math.min(devicePixelRatio, 2) * renderScale);
  const th = Math.round(innerHeight * Math.min(devicePixelRatio, 2) * renderScale);
  pipeline.resize(Math.max(2, tw), Math.max(2, th));

  const basePalette = new Float32Array(palCur);
  const replayPalette = new Float32Array(palCurR);
  const dwellSec = (nowMs - arriveMs) / 1000;

  // Arrival settle: the eased audio-reactive INPUT gain (floor→1 over ~1.5s). `rx`
  // scales the band/transient drive; `sw` scales swell; drop rides it too. It is NOT
  // applied to time / drift / progress / seed / palette — the constant clock never
  // pauses, so the world keeps breathing and travelling while its reactivity comes up.
  const settle = settleGuardOn ? settleGain(nowMs - arriveMs) : 1;
  const rx = (x: number): number => cl(x) * settle;
  const sw = Math.min(a.swell * intensity, 1.1) * settle;
  const progress = Math.min((nowMs - arriveMs) / replayExpectedLenMs, 1);

  const bloomCfg = !bloomEnabled ? null : replayActive ? currentBloom : DEFAULT_BLOOM;

  pipeline.render(
    {
      bass: rx(a.bass),
      energy: rx(a.energy),
      holding: holdCur,
      kick: rx(a.kick),
      mid: rx(a.mid),
      palette: basePalette,
      scene: scene % 3,
      seed: seedCur,
      swell: sw,
      time: now,
      treble: rx(a.treble),
    },
    replayActive
      ? {
          active: true,
          fade: effFade,
          inputs: {
            bass: rx(a.bass),
            bassFast: rx(a.bassFast),
            drop: a.drop * settle,
            dwellSec,
            energy: rx(a.energy),
            energyFast: rx(a.energyFast),
            kick: rx(a.kick),
            mid: rx(a.mid),
            midFast: rx(a.midFast),
            palette: replayPalette,
            progress,
            seedRaw: seedRawCur,
            swell: sw,
            time: now,
            treble: rx(a.treble),
            trebleFast: rx(a.trebleFast),
          },
        }
      : null,
    bloomCfg,
  );

  // Arrival instrumentation (`?trace=1`): dump every replay-fed signal at 100ms
  // intervals across the first 6s of an arrival, so the racing fix is provable
  // before/after (A/B via `?noSettle=1`) from the same trace.
  if (traceOn && arriveMs > 0 && nowMs - arriveMs <= 6000 && nowMs - traceLastMs >= 100) {
    traceLastMs = nowMs;
    const ls = limiter.status(nowMs);
    const it0 = pipeline.debugIntegrators()[0] ?? null;
    // eslint-disable-next-line no-console
    console.log(
      "[trace] " +
        JSON.stringify({
          bass: +a.bass.toFixed(3),
          bassFast: +a.bassFast.toFixed(3),
          drop: +a.drop.toFixed(3),
          eases: ls.eases,
          energy: +a.energy.toFixed(3),
          gen: ls.generalCount,
          intPos: it0 ? +it0.pos.toFixed(3) : null,
          intStep: it0 ? +it0.step.toFixed(4) : null,
          kick: +a.kick.toFixed(3),
          mid: +a.mid.toFixed(3),
          progress: +progress.toFixed(4),
          red: ls.redCount,
          seedCur: +seedRawCur.toFixed(1),
          seedTar: +seedRawTar.toFixed(1),
          settle: +settle.toFixed(3),
          swell: +a.swell.toFixed(3),
          t: +((nowMs - arriveMs) / 1000).toFixed(2),
          treble: +a.treble.toFixed(3),
        }),
    );
  }

  // bridge: heartbeat (1Hz) + mel (10Hz)
  bridge.heartbeat(nowMs, renderFrame);
  bridge.mel(nowMs, dsp.melFrame());

  fpsAcc++;
  if (nowMs - fpsT >= 500) {
    fps = Math.round((fpsAcc * 1000) / (nowMs - fpsT));
    fpsAcc = 0;
    fpsT = nowMs;
    updateHud();
    $("meters").textContent =
      `bass ${a.bass.toFixed(2)}  mid ${a.mid.toFixed(2)}  treble ${a.treble.toFixed(2)}  kick ${a.kick.toFixed(2)}  swell ${a.swell.toFixed(2)}  drop ${a.drop.toFixed(2)}`;
  }
  requestAnimationFrame(frame);
}

// ---- HUD -------------------------------------------------------------------
let deviceName = "—";
function updateHud(): void {
  const hi = $("hudinfo");
  let planLine: string;
  if (!PLAN.length) {
    planLine = "plan: (loading)";
  } else if (pointer < 0) {
    planLine = "plan: uncharted · press → for " + PLAN[0].title;
  } else {
    const nx = PLAN[(pointer + 1) % PLAN.length];
    planLine = `track ${pointer + 1}/${PLAN.length} · ${PLAN[pointer].title}  → next ${nx.title}`;
  }
  const rest = blackoutEngaged
    ? "BLACKOUT"
    : manualHold
      ? "holding"
      : silenceHold
        ? "silence-hold"
        : outputTripCooldown > 0
          ? "flash-hold"
          : "live";
  const ls = limiter.status(performance.now());
  const limiterLine = `limiter: armed · gen ${ls.generalCount}/3 red ${ls.redCount}/3 · eases ${ls.eases} · out-trips ${monitor.tripCount}`;
  const bridgeLine = `bridge: ${bridge.status}  ·  smoke: ${smokeResult}`;
  hi.textContent =
    planLine +
    "\n" +
    `dev ${deviceName}  ·  ${fps}fps  ·  scene ${(scene % 3).toFixed(1)}${autoMorph ? " auto" : ""}  ·  intensity ${intensity.toFixed(1)}  ·  ${rest}  ·  dsp: ${dsp.lowLatency ? "low-latency" : "legacy"}${replayEnabled ? "" : "  ·  replay OFF"}${bloomEnabled ? "" : "  ·  bloom OFF"}` +
    "\n" +
    limiterLine +
    "\n" +
    bridgeLine;
  const w = $("world");
  w.textContent = worldStatus;
  w.className = replayActive ? "rep" : "dim";
}

// ---- bridge wiring: pointer advances (fingerprint) drive arrivals ----------
let lastBridgePointer = -1;
let pendingBridgePointer: number | null = null;
function applyBridgePointer(p: number): void {
  if (p === lastBridgePointer) {
    return;
  }
  if (p >= 0 && p < PLAN.length) {
    lastBridgePointer = p;
    pendingBridgePointer = null;
    arrive(p);
  } else if (p >= 0) {
    // state can arrive before /plan finishes loading — apply it once PLAN is ready.
    pendingBridgePointer = p;
  }
}
// ---- load THE PLAN (bridge-first, via the glass server proxy) --------------
// The glass server resolves /plan bridge-first and marks the winner in `x-plan-source`;
// the client narrates it. On a bridge that comes up (or back) AFTER a local-fixture boot,
// re-load so the glass upgrades to the operator's real plan — and the bridge pointer then
// indexes the SAME list (the first-set debrief fix: no more cycling the 5-entry demo).
let lastPlanSource: "bridge" | "local" | null = null;
async function loadPlan(): Promise<void> {
  try {
    const res = await fetch("/plan");
    const list = (await res.json()) as PlanItem[];
    PLAN = list || [];
    lastPlanSource = res.headers.get("x-plan-source") === "bridge" ? "bridge" : "local";
    // eslint-disable-next-line no-console
    console.log(
      lastPlanSource === "bridge"
        ? `plan: ${PLAN.length} findings via the bridge`
        : `plan: ${PLAN.length} findings, local fixture — no bridge`,
    );
    updateHud();
    if (pendingBridgePointer !== null) {
      applyBridgePointer(pendingBridgePointer);
    }
  } catch (e) {
    err("plan load failed: " + e);
  }
}

bridge.onState = (s: ShowState): void => applyBridgePointer(s.plan.pointer);
bridge.onStatus = (s): void => {
  // A bridge that comes up (or back) while we're on the local fixture is the cue to
  // re-load: its plan wins. If we already hold the bridge's plan, there's nothing to do.
  if (s === "live" && lastPlanSource === "local") {
    void loadPlan();
  }
  updateHud();
};
bridge.connect();
void loadPlan();

frame();

// ---- audio inputs (with the mandated constraints + device-loss handling) ---
let currentDeviceId: string | undefined;
async function listDevices(): Promise<void> {
  const sel = $("devices") as HTMLSelectElement;
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter(
    (d) => d.kind === "audioinput",
  );
  sel.innerHTML = devs
    .map((d) => `<option value='${d.deviceId}'>${d.label || "input"}</option>`)
    .join("");
  const pick =
    devs.find((d) => /m-track/i.test(d.label)) ||
    devs.find((d) => /usb audio/i.test(d.label)) ||
    devs.find((d) => /blackhole/i.test(d.label));
  if (pick) {
    sel.value = pick.deviceId;
  }
}
async function acquire(deviceId?: string): Promise<void> {
  await dsp.ctx.resume();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: deviceId ? { exact: deviceId } : undefined, ...MIC_CONSTRAINTS },
  });
  dsp.connect(stream);
  currentDeviceId = deviceId;
  const track = stream.getAudioTracks()[0];
  // device loss -> holding + gesture-free reacquisition loop
  track.addEventListener("ended", () => {
    err("audio device lost — reacquiring…");
    silenceHold = true;
    // Fire-and-forget: the loop retries internally; a terminal failure surfaces live.
    reacquireLoop().catch((e: unknown) => err("audio reacquire failed: " + String(e)));
  });
}
let reacquiring = false;
async function reacquireLoop(): Promise<void> {
  if (reacquiring) {
    return;
  }
  reacquiring = true;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await acquire(currentDeviceId);
      err("");
      silenceHold = false;
      reacquiring = false;
      return;
    } catch {
      await new Promise((res) => setTimeout(res, 1000));
    }
  }
  reacquiring = false;
}
navigator.mediaDevices.addEventListener("devicechange", () => {
  listDevices().catch(() => undefined);
});
($("live") as HTMLButtonElement).onclick = async (): Promise<void> => {
  const sel = $("devices") as HTMLSelectElement;
  await acquire(sel.value || undefined);
  await listDevices();
  deviceName = (sel.options[sel.selectedIndex] || { text: "input" }).text || "input";
  updateHud();
};
listDevices().catch(() => undefined);

// ---- demo beat (174bpm DnB-ish) through the SAME analyser ------------------
let demoOn = false;
function demo(): void {
  if (demoOn) {
    return;
  }
  demoOn = true;
  // Resume failure would leave the demo silent — surface it live rather than swallow.
  dsp.ctx.resume().catch((e: unknown) => err("audio context resume failed: " + String(e)));
  deviceName = "demo beat";
  updateHud();
  const AC = dsp.ctx;
  const bus = AC.createGain();
  bus.gain.value = 0.9;
  bus.connect(dsp.analyserNode);
  bus.connect(dsp.fastAnalyserNode); // feed the low-latency analyser too
  const out = AC.createGain();
  out.gain.value = 0.4;
  bus.connect(out);
  out.connect(AC.destination);
  const beat = 60 / 174;
  const kickAt = (t: number): void => {
    const o = AC.createOscillator();
    const g = AC.createGain();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.09);
    g.gain.setValueAtTime(1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    o.connect(g);
    g.connect(bus);
    o.start(t);
    o.stop(t + 0.25);
  };
  const hatAt = (t: number): void => {
    const b = AC.createBufferSource();
    const g = AC.createGain();
    const f = AC.createBiquadFilter();
    const buf = AC.createBuffer(1, 2205, AC.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      d[i] = Math.random() * 2 - 1;
    }
    b.buffer = buf;
    f.type = "highpass";
    f.frequency.value = 6000;
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    b.connect(f);
    f.connect(g);
    g.connect(bus);
    b.start(t);
  };
  let bar = 0;
  setInterval(
    () => {
      const t = AC.currentTime + 0.05;
      const inBreak = bar % 16 >= 12;
      if (!inBreak) {
        kickAt(t);
        kickAt(t + beat * 2.5);
        for (let i = 0; i < 4; i++) {
          hatAt(t + beat * i + beat / 2);
        }
      }
      bar++;
    },
    beat * 4 * 1000,
  );
}
($("demo") as HTMLButtonElement).onclick = demo;
