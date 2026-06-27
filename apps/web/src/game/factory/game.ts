import { createGrain } from "../earth/grain";
import { createFactoryAudio } from "./audio";
import { createFactoryInput } from "./input";
import { BELT_Y, stationX, TOKEN_H, TOKEN_W, VIEW_H, VIEW_W, WORLD_W } from "./layout";
import { factoryPalette as C } from "./palette";
import { createFactorySim, type FactoryFinding } from "./sim";
import { buildMachineSprites, makeShip } from "./sprites";
import { LAUNCH_INDEX, STATIONS } from "./stations";

// The factory engine — an ambient side-on conveyor that RENDERS TRUE STATE
// (docs/factory-to-orbit-brief.md). A fixed logical viewport pans across a wide
// world of machines; findings ride the belt to the furthest step they've reached,
// pile in front of the slow render bay, and a finished finding boards a ship and
// lifts off to the Galaxy. Execute calm (DESIGN.md): slow, dark, warm, one gold
// light per working machine, no dashboard chrome. The sim is the truth; this draws
// it. Cover art rides each finding so the line stays music-first and cover-led.

const PAN_SPEED = 150; // logical px/sec from held keys
const BELT_SCROLL = 0.4; // belt-slat drift per frame
const SLAT_GAP = 10;
const LAUNCH_DURATION = 2.4; // the deliberate "enter the Galaxy" cinematic
const WALL_TOP = 48; // the back wall starts here; cosmos skylight above it

type Options = {
  onInspect: (finding: FactoryFinding) => void;
  onLaunch: () => void;
};

export type FactoryGame = {
  destroy: () => void;
  setFindings: (findings: FactoryFinding[]) => void;
};

type Star = { c: string; x: number; y: number };

export function createFactory(container: HTMLElement, options: Options): FactoryGame {
  const canvas = document.createElement("canvas");
  canvas.width = VIEW_W;
  canvas.height = VIEW_H;
  canvas.style.imageRendering = "pixelated";
  canvas.style.display = "block";
  canvas.style.touchAction = "none";
  canvas.style.cursor = "grab";
  container.appendChild(canvas);

  const context = canvas.getContext("2d");
  if (!context) {
    return { destroy: () => canvas.remove(), setFindings: () => {} };
  }
  const ctx = context;
  ctx.imageSmoothingEnabled = false;

  const machines = buildMachineSprites();
  const ship = makeShip();
  const grain = createGrain(VIEW_W, VIEW_H);
  const sim = createFactorySim();

  // The skylight starfield over the works — cream-dominant, gold rare (One Sun).
  const stars: Star[] = [];
  for (let i = 0; i < 90; i++) {
    const h = (i * 2654435761) >>> 0;
    const c = i % 17 === 0 ? C.goldBright : i % 4 === 0 ? C.creamMuted : C.creamDim;
    stars.push({ c, x: h % WORLD_W, y: 4 + ((h >>> 8) % (WALL_TOP - 8)) });
  }

  // Remote cover art, loaded once per URL and drawn when ready (taints the canvas,
  // but we only ever draw — never read back — so that's fine).
  const covers = new Map<string, HTMLImageElement>();
  function cover(url: string | undefined): HTMLImageElement | undefined {
    if (!url) {
      return undefined;
    }
    const cached = covers.get(url);
    if (cached) {
      return cached.complete && cached.naturalWidth > 0 ? cached : undefined;
    }
    const img = new Image();
    img.src = url;
    covers.set(url, img);
    return undefined;
  }

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reducedMotion = reduced.matches;
  const onReduced = (event: MediaQueryListEvent) => {
    reducedMotion = event.matches;
  };
  reduced.addEventListener("change", onReduced);

  const input = createFactoryInput(canvas);

  // Audio unlocks on the first gesture (key or pointer); a local M owns the mute.
  const audio = createFactoryAudio();
  let audioUnlocked = false;
  function unlockAudio() {
    if (!audioUnlocked) {
      audioUnlocked = true;
      audio.resume();
      audio.ambient(true);
    }
  }
  const onAudioKey = (event: KeyboardEvent) => {
    unlockAudio();
    if (event.key === "m" || event.key === "M") {
      audio.setMuted(!audio.muted());
    }
  };
  window.addEventListener("keydown", onAudioKey);
  canvas.addEventListener("pointerdown", unlockAudio);

  let camX = 0;
  let scale = 1;
  let frame = 0;
  let raf = 0;
  let last = 0;
  let centred = false; // open the view where the line is actually busy

  // the deliberate launch cinematic (tap the pad → enter the Galaxy)
  let launching = false;
  let launchT = 0;

  function fit() {
    const rect = container.getBoundingClientRect();
    scale = Math.max(1, Math.floor(Math.min(rect.width / VIEW_W, rect.height / VIEW_H)));
    canvas.style.width = `${VIEW_W * scale}px`;
    canvas.style.height = `${VIEW_H * scale}px`;
  }
  fit();
  const onResize = () => fit();
  window.addEventListener("resize", onResize);

  function clampCam() {
    const max = Math.max(0, WORLD_W - VIEW_W);
    camX = camX < 0 ? 0 : camX > max ? max : camX;
  }

  // ── input → camera + taps ──────────────────────────────────────────────────
  function handleInput(dt: number) {
    camX += input.panKeys() * PAN_SPEED * dt;
    camX -= input.drag() / scale; // 1:1 grab-scroll
    clampCam();

    const tap = input.consumeTap();
    if (tap) {
      const wx = tap.x / scale + camX;
      const wy = tap.y / scale;
      hitTest(wx, wy);
    }
  }

  function hitTest(wx: number, wy: number) {
    // a finding token first (topmost = nearest the front of a pile)
    const list = sim.tokens();
    for (let i = list.length - 1; i >= 0; i--) {
      const token = list[i];
      if (!token || token.phase === "launching") {
        continue;
      }
      const left = token.x - TOKEN_W / 2;
      const top = BELT_Y - TOKEN_H - token.launchY;
      if (wx >= left - 2 && wx <= left + TOKEN_W + 2 && wy >= top - 2 && wy <= top + TOKEN_H + 2) {
        options.onInspect(token.finding);
        return;
      }
    }
    // otherwise the launch gantry → the trip up to the Galaxy
    const padX = stationX(LAUNCH_INDEX);
    if (Math.abs(wx - padX) < 22 && wy < BELT_Y + 4) {
      startLaunch();
    }
  }

  function startLaunch() {
    if (launching) {
      return;
    }
    launching = true;
    launchT = 0;
    audio.launch();
    // bring the pad into view for the liftoff
    camX = Math.max(
      0,
      Math.min(Math.max(0, WORLD_W - VIEW_W), stationX(LAUNCH_INDEX) - VIEW_W / 2),
    );
  }

  // ── drawing ────────────────────────────────────────────────────────────────
  function drawBackdrop() {
    // cosmos skylight over the works
    ctx.fillStyle = C.deepField;
    ctx.fillRect(camX, 0, VIEW_W, WALL_TOP);
    for (const star of stars) {
      if (star.x >= camX - 1 && star.x <= camX + VIEW_W) {
        ctx.fillStyle = star.c;
        ctx.fillRect(Math.round(star.x), star.y, 1, 1);
      }
    }
    // a soft gold horizon bloom over the launch pad — the way up (One Sun)
    const bloom = ctx.createRadialGradient(
      stationX(LAUNCH_INDEX),
      WALL_TOP,
      2,
      stationX(LAUNCH_INDEX),
      WALL_TOP,
      90,
    );
    bloom.addColorStop(0, "rgba(245,184,0,0.16)");
    bloom.addColorStop(1, "rgba(245,184,0,0)");
    ctx.fillStyle = bloom;
    ctx.fillRect(camX, 0, VIEW_W, WALL_TOP + 30);

    // the back wall of the works
    ctx.fillStyle = C.steelDim;
    ctx.fillRect(camX, WALL_TOP, VIEW_W, BELT_Y - WALL_TOP);
    // faint vertical seams + a couple of hung cables
    ctx.fillStyle = C.sleeveBlack;
    const seam0 = Math.floor(camX / 48) * 48;
    for (let x = seam0; x <= camX + VIEW_W; x += 48) {
      ctx.fillRect(x, WALL_TOP, 1, BELT_Y - WALL_TOP);
    }
    ctx.fillStyle = C.steel;
    for (let x = seam0 + 24; x <= camX + VIEW_W; x += 96) {
      ctx.fillRect(x, WALL_TOP, 1, 18);
    }
  }

  function drawBelt() {
    // the floor under the belt
    ctx.fillStyle = C.deepField;
    ctx.fillRect(camX, BELT_Y + 8, VIEW_W, VIEW_H - BELT_Y - 8);
    // the conveyor band
    ctx.fillStyle = C.belt;
    ctx.fillRect(camX, BELT_Y, VIEW_W, 8);
    ctx.fillStyle = C.beltLit;
    ctx.fillRect(camX, BELT_Y, VIEW_W, 1);
    ctx.fillStyle = C.steelDim;
    ctx.fillRect(camX, BELT_Y + 7, VIEW_W, 1);
    // scrolling slats so the belt reads as moving
    const drift = reducedMotion ? 0 : (frame * BELT_SCROLL) % SLAT_GAP;
    const slat0 = Math.floor(camX / SLAT_GAP) * SLAT_GAP - SLAT_GAP;
    ctx.fillStyle = C.beltSlat;
    for (let x = slat0 + drift; x <= camX + VIEW_W; x += SLAT_GAP) {
      ctx.fillRect(Math.round(x), BELT_Y + 2, 1, 4);
    }
  }

  function drawMachines() {
    // which machines are working a finding right now → a gold light
    const active = new Set<number>();
    for (const token of sim.tokens()) {
      if (
        token.settled &&
        token.slot === 0 &&
        token.station < LAUNCH_INDEX &&
        token.phase === "belt"
      ) {
        active.add(token.station);
      }
    }

    for (let i = 0; i < STATIONS.length; i++) {
      const station = STATIONS[i];
      const sprite = station ? machines[station.sprite] : undefined;
      if (!sprite) {
        continue;
      }
      const cx = stationX(i);
      if (cx + sprite.w / 2 < camX || cx - sprite.w / 2 > camX + VIEW_W) {
        continue;
      }
      ctx.drawImage(sprite.canvas, Math.round(cx - sprite.w / 2), BELT_Y - sprite.h);

      if (active.has(i)) {
        const pulse = reducedMotion ? 0.5 : 0.45 + Math.sin(frame * 0.12) * 0.25;
        ctx.save();
        ctx.globalAlpha = pulse;
        const glow = ctx.createRadialGradient(
          cx,
          BELT_Y - sprite.h / 2,
          1,
          cx,
          BELT_Y - sprite.h / 2,
          18,
        );
        glow.addColorStop(0, "rgba(255,208,87,0.9)");
        glow.addColorStop(1, "rgba(255,208,87,0)");
        ctx.fillStyle = glow;
        ctx.fillRect(cx - 20, BELT_Y - sprite.h - 6, 40, sprite.h + 12);
        ctx.restore();
      }
    }
  }

  function drawToken(token: ReturnType<typeof sim.tokens>[number]) {
    const left = Math.round(token.x - TOKEN_W / 2);
    const top = Math.round(BELT_Y - TOKEN_H - token.launchY);
    ctx.save();
    ctx.globalAlpha = token.alpha;

    // a launching finding rides the ship up
    if (token.phase === "launching" && ship) {
      ctx.drawImage(ship.canvas, Math.round(token.x - ship.w / 2), top + TOKEN_H - ship.h);
    }

    // the cover, framed — cover-led so the line stays music-first
    ctx.fillStyle = C.sleeveBlack;
    ctx.fillRect(left, top, TOKEN_W, TOKEN_H - 4);
    const img = cover(token.finding.albumImageUrl);
    if (img) {
      ctx.drawImage(img, left + 2, top + 2, TOKEN_W - 4, TOKEN_W - 4);
    } else {
      // the eclipse fallback — a gold-to-red wash over dust
      const g = ctx.createLinearGradient(left, top, left + TOKEN_W, top + TOKEN_W);
      g.addColorStop(0, C.gold);
      g.addColorStop(1, C.red);
      ctx.fillStyle = g;
      ctx.fillRect(left + 2, top + 2, TOKEN_W - 4, TOKEN_W - 4);
    }
    // a thin lit frame edge
    ctx.fillStyle = C.steelLit;
    ctx.fillRect(left, top, TOKEN_W, 1);
    ctx.restore();
  }

  function drawIncoming() {
    const n = sim.incoming();
    if (n <= 0) {
      return;
    }
    // a quiet left-edge marker; chevrons drift in unless reduced-motion
    const drift = reducedMotion ? 0 : Math.sin(frame * 0.1) * 1.2;
    ctx.fillStyle = C.goldBright;
    for (let i = 0; i < 2; i++) {
      const x = camX + 5 + i * 4 + drift;
      ctx.beginPath();
      ctx.moveTo(x, BELT_Y - 16);
      ctx.lineTo(x + 3, BELT_Y - 13);
      ctx.lineTo(x, BELT_Y - 10);
      ctx.lineTo(x - 1, BELT_Y - 10);
      ctx.lineTo(x + 2, BELT_Y - 13);
      ctx.lineTo(x - 1, BELT_Y - 16);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = C.creamMuted;
    ctx.fillRect(camX + 14, BELT_Y - 15, n, 1); // a tiny tally bar (n wide)
  }

  function render() {
    ctx.clearRect(0, 0, VIEW_W, VIEW_H);
    ctx.save();
    ctx.translate(-Math.round(camX), 0);
    drawBackdrop();
    drawBelt();
    drawMachines();
    const order = sim.tokens().sort((a, b) => a.x - b.x);
    for (const token of order) {
      drawToken(token);
    }
    drawIncoming();
    ctx.restore();
    grain.draw(ctx, frame, reducedMotion);
  }

  // ── the launch cinematic ─────────────────────────────────────────────────
  function renderLaunch() {
    render();
    const padX = stationX(LAUNCH_INDEX);
    const lift = Math.max(0, launchT - 0.3);
    const rise = 0.5 * 360 * lift * lift;
    ctx.save();
    ctx.translate(-Math.round(camX), 0);
    if (ship) {
      const ry = BELT_Y - ship.h - rise;
      // flame
      const flen = Math.round(8 + Math.min(34, lift * 60));
      for (let i = 0; i < flen; i++) {
        const w = Math.max(1, 5 - i * 0.14);
        ctx.fillStyle =
          i < 3 ? C.creamBright : i < flen * 0.4 ? C.goldBright : i < flen * 0.75 ? C.gold : C.red;
        ctx.fillRect(Math.round(padX - w), Math.round(ry + ship.h + i), Math.round(w * 2), 1);
      }
      ctx.drawImage(ship.canvas, Math.round(padX - ship.w), Math.round(ry), ship.w * 2, ship.h * 2);
    }
    ctx.restore();

    if (launchT > 1.7) {
      const flash = Math.max(0, 0.7 - (launchT - 1.7) * 2.5);
      if (flash > 0) {
        ctx.globalAlpha = flash;
        ctx.fillStyle = C.goldBright;
        ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      }
      ctx.globalAlpha = Math.min(1, Math.max(0, (launchT - 1.9) / 0.4));
      ctx.fillStyle = C.deepField;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      ctx.globalAlpha = 1;
    }
    grain.draw(ctx, frame, reducedMotion);
  }

  function loop(now: number) {
    const dt = last === 0 ? 0 : Math.min(0.05, (now - last) / 1000);
    last = now;
    frame++;

    if (launching) {
      launchT += dt;
      renderLaunch();
      if (launchT >= LAUNCH_DURATION) {
        launching = false;
        options.onLaunch();
      }
    } else {
      handleInput(dt);
      sim.update(dt);
      const events = sim.consumeEvents();
      if (events.clunks > 0) {
        audio.clunk();
      }
      if (events.launches > 0) {
        audio.launch();
      }
      render();
    }
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  return {
    destroy() {
      cancelAnimationFrame(raf);
      input.destroy();
      window.removeEventListener("keydown", onAudioKey);
      canvas.removeEventListener("pointerdown", unlockAudio);
      audio.destroy();
      reduced.removeEventListener("change", onReduced);
      window.removeEventListener("resize", onResize);
      canvas.remove();
    },
    setFindings(findings) {
      sim.sync(findings);
      // On the first populated sync, pan to the busiest stretch of the line — most
      // findings are far down the pipeline, so opening at the left looks dead.
      if (!centred) {
        const counts = new Map<number, number>();
        for (const token of sim.tokens()) {
          if (token.station < LAUNCH_INDEX) {
            counts.set(token.station, (counts.get(token.station) ?? 0) + 1);
          }
        }
        let busiest = 0;
        let most = -1;
        for (const [station, n] of counts) {
          if (n > most) {
            most = n;
            busiest = station;
          }
        }
        if (most > 0) {
          camX = stationX(busiest) - VIEW_W / 2;
          clampCam();
          centred = true;
        }
      }
    },
  };
}
