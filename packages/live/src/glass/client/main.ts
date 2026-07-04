// The glass — client orchestrator. Owns the plan, the pointer, arrivals, holding,
// intensity and the render loop; drives the GlassPipeline; and wires the crown
// (source-side FlashLimiter + output-side FlashMonitor), the bridge, and the RFC §4
// reliability rails. Standalone-complete: with no bridge it is the v0.6 failure floor.
import { type ShowState } from "../../contract.ts";
import { type BloomConfig } from "../glsl-runtime.ts";
import { DEFAULT_BLOOM } from "../glsl-runtime.ts";
import { FlashLimiter, FlashMonitor, isSaturatedRed, redValue } from "../flash-limiter.ts";
import { type Scene } from "../scene-extract.ts";
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
function showPlate(e: PlanItem): void {
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
  autoMorph = false;
  manualHold = false;
  arriveMs = performance.now();
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
addEventListener("keydown", (ev: KeyboardEvent) => {
  const k = ev.key;
  if (k >= "1" && k <= "3") {
    sceneTarget = +k - 1;
    autoMorph = false;
    replayActive = false;
    pipeline.disposeReplay();
    worldStatus = "world: default[" + vehName(+k - 1) + "] (manual vehicle)";
    updateHud();
  } else if (k === "m") {
    autoMorph = !autoMorph;
  } else if (k === "v") {
    replayEnabled = !replayEnabled;
    if (pointer >= 0) {
      arrive(pointer);
    }
  } else if (k === "g") {
    bloomEnabled = !bloomEnabled;
    updateHud();
  } else if (k === "h") {
    const el = $("hud");
    el.style.display = el.style.display === "none" ? "block" : "none";
  } else if (k === "r") {
    renderScale = renderScale === 1 ? 0.75 : renderScale === 0.75 ? 0.5 : 1;
  } else if (k === "d") {
    demo();
  } else if (k === "l") {
    // A/B the low-latency dual-resolution DSP against the legacy single-4096 path.
    dsp.lowLatency = !dsp.lowLatency;
    updateHud();
  } else if (k === "X") {
    // pre-show smoke: force a context loss (shift+x), then restore — the rails must
    // rebuild via the SAME path as cold boot. webglcontextrestored writes the verdict.
    smokeResult = "running…";
    updateHud();
    pipeline.loseContextForSmoke();
    setTimeout(() => pipeline.restoreContextForSmoke(), 500);
  } else if (k === "ArrowRight" || k === "n") {
    ev.preventDefault();
    arrive(pointer < 0 ? 0 : pointer + 1);
    bridge.send({ cmd: "advance" });
  } else if (k === "ArrowLeft" || k === "p") {
    ev.preventDefault();
    arrive(pointer < 0 ? 0 : pointer - 1);
    bridge.send({ cmd: "rewind" });
  } else if (k === "0") {
    manualHold = !manualHold;
  } else if (k === "-" || k === "_") {
    intensity = Math.max(0.4, +(intensity - 0.1).toFixed(2));
    bridge.send({ cmd: "intensity", value: intensity });
    updateHud();
  } else if (k === "=" || k === "+") {
    intensity = Math.min(1.3, +(intensity + 0.1).toFixed(2));
    bridge.send({ cmd: "intensity", value: intensity });
    updateHud();
  } else if (k === "b") {
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
  }
});
addEventListener("keyup", (ev: KeyboardEvent) => {
  if (ev.key === "b" && blackoutTimer) {
    clearTimeout(blackoutTimer);
    blackoutTimer = null;
    $("plate").classList.remove("blackarm");
  }
});

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

  const bloomCfg = !bloomEnabled ? null : replayActive ? currentBloom : DEFAULT_BLOOM;

  pipeline.render(
    {
      bass: cl(a.bass),
      energy: cl(a.energy),
      holding: holdCur,
      kick: cl(a.kick),
      mid: cl(a.mid),
      palette: basePalette,
      scene: scene % 3,
      seed: seedCur,
      swell: Math.min(a.swell * intensity, 1.1),
      time: now,
      treble: cl(a.treble),
    },
    replayActive
      ? {
          active: true,
          fade: effFade,
          inputs: {
            bass: cl(a.bass),
            bassFast: cl(a.bassFast),
            drop: a.drop,
            dwellSec,
            energy: cl(a.energy),
            energyFast: cl(a.energyFast),
            kick: cl(a.kick),
            mid: cl(a.mid),
            midFast: cl(a.midFast),
            palette: replayPalette,
            progress: Math.min((nowMs - arriveMs) / replayExpectedLenMs, 1),
            seedRaw: seedRawCur,
            swell: Math.min(a.swell * intensity, 1.1),
            time: now,
            treble: cl(a.treble),
            trebleFast: cl(a.trebleFast),
          },
        }
      : null,
    bloomCfg,
  );

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
bridge.onState = (s: ShowState): void => applyBridgePointer(s.plan.pointer);
bridge.onStatus = (): void => updateHud();
bridge.connect();

// ---- load THE PLAN then boot ----------------------------------------------
fetch("/plan")
  .then((r) => r.json())
  .then((list: PlanItem[]) => {
    PLAN = list || [];
    updateHud();
    if (pendingBridgePointer !== null) {
      applyBridgePointer(pendingBridgePointer);
    }
  })
  .catch((e) => err("plan load failed: " + e));

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
