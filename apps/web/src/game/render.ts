import { palette } from "./palette";
import { fnv1a } from "./placement";
import { type CarrierInfo, type RadarBlip, type SimState, wrapAngle } from "./sim";
import { SHIP_FLAME_ANCHORS, SHIP_SIZE, makeEarthSprite, makeShipSprite } from "./sprites";

// The renderer: one low-resolution canvas (270p) upscaled with
// image-rendering: pixelated, so every line of text and every sprite lands on
// the same chunky grid — the 80s look is the scaling, not a shader. Heavy
// grain and scanlines stay on top of every frame (the Light-Years Rule:
// lossy is narrative, a clean frame reads as fake).

const INTERNAL_HEIGHT = 270;
const HORIZON_FRACTION = 0.42;
const BOOT_SECONDS = 4.2;
const TOWED_SECONDS = 1.8;
const DISTANT_STARS = 170;
const STREAK_COUNT = 64;
/** World size of a banger star's glowing body. */
const STAR_BODY = 26;
const EARTH_BODY = 170;

export type MasterPhase = "boot" | "end" | "gate" | "play";

export type LogCardView = {
  age: number;
  artistLine: string;
  logId: string;
  refuelling: boolean;
  title: string;
};

export type RenderView = {
  bootT: number;
  carrier?: CarrierInfo;
  endT: number;
  logCard?: LogCardView;
  muted: boolean;
  nowS: number;
  phase: MasterPhase;
  radar: RadarBlip[];
  sim: SimState;
  steer: number;
  telemetry: string[];
  touch: boolean;
  towedT: number;
};

type DistantStar = {
  angle: number;
  ink: string;
  twinkle: number;
  yFraction: number;
};

type Streak = {
  /** Horizontal angle offset from dead ahead, radians. */
  bearing: number;
  depth: number;
  vOffset: number;
};

export type Renderer = {
  canvas: HTMLCanvasElement;
  destroy: () => void;
  draw: (view: RenderView) => void;
  resize: (cssWidth: number, cssHeight: number) => void;
};

export function createRenderer(container: HTMLElement): Renderer {
  const canvas = document.createElement("canvas");

  canvas.style.display = "block";
  canvas.style.height = "100%";
  canvas.style.imageRendering = "pixelated";
  canvas.style.width = "100%";
  container.appendChild(canvas);

  const maybeCtx = canvas.getContext("2d");

  if (!maybeCtx) {
    throw new Error("galaxy: canvas 2d context unavailable");
  }

  const ctx = maybeCtx;

  ctx.imageSmoothingEnabled = false;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const shipSprite = makeShipSprite();
  const earthSprites = new Map<number, HTMLCanvasElement>();
  const distant = makeDistantStars();
  const streaks = makeStreaks();

  let width = 480;
  let height = INTERNAL_HEIGHT;
  let lastNow = 0;

  // Oxanium is preloaded by the document; nudge the canvas-visible faces so
  // the first painted frame doesn't fall back to the system sans.
  document.fonts?.load('800 22px "Oxanium"').catch(() => undefined);
  document.fonts?.load('400 10px "Oxanium"').catch(() => undefined);

  function earthSprite(size: number): HTMLCanvasElement {
    const rounded = Math.max(8, Math.min(150, Math.round(size / 2) * 2));
    const cached = earthSprites.get(rounded);

    if (cached) {
      return cached;
    }

    const sprite = makeEarthSprite(rounded);

    earthSprites.set(rounded, sprite);

    return sprite;
  }

  function resize(cssWidth: number, cssHeight: number): void {
    const aspect = cssWidth / Math.max(1, cssHeight);

    height = INTERNAL_HEIGHT;
    width = Math.max(240, Math.min(560, Math.round((INTERNAL_HEIGHT * aspect) / 2) * 2));
    canvas.width = width;
    canvas.height = height;
    ctx.imageSmoothingEnabled = false;
  }

  function draw(view: RenderView): void {
    const dt = Math.min(0.1, Math.max(0, view.nowS - lastNow));

    lastNow = view.nowS;

    const { sim } = view;
    const horizon = Math.round(height * HORIZON_FRACTION);

    ctx.fillStyle = palette.deepField;
    ctx.fillRect(0, 0, width, height);

    if (view.phase === "gate") {
      drawGate(view);
      drawFilmTexture(view.nowS);

      return;
    }

    const speedFactor = view.phase === "boot" ? 0.4 + view.bootT * 3 : sim.ship.speed / 70;

    drawDistantStars(sim.ship.heading, horizon, view.nowS);
    drawStreaks(dt, speedFactor, view.steer, horizon);
    drawWorld(sim, view);

    if (view.phase === "boot") {
      drawBoot(view, horizon);
    } else {
      drawShip(view);
    }

    if (view.phase === "play" || view.phase === "boot") {
      drawHud(view);
    }

    if (view.phase === "end") {
      drawEnd(view);
    }

    if (view.towedT > 0) {
      drawTowed(view);
    }

    drawFilmTexture(view.nowS);
  }

  function makeDistantStars(): DistantStar[] {
    const stars: DistantStar[] = [];

    for (let index = 0; index < DISTANT_STARS; index++) {
      const hash = fnv1a(`bg:${index}`);
      const tier = hash % 10;

      stars.push({
        angle: ((hash >>> 4) % 6283) / 1000,
        ink: tier < 6 ? palette.creamDim : tier < 9 ? palette.creamMuted : palette.cream,
        twinkle: ((hash >>> 16) % 628) / 100,
        yFraction: ((hash >>> 8) % 1000) / 1000,
      });
    }

    return stars;
  }

  function makeStreaks(): Streak[] {
    const pool: Streak[] = [];

    for (let index = 0; index < STREAK_COUNT; index++) {
      pool.push(spawnStreak(index));
    }

    return pool;
  }

  function spawnStreak(seed: number): Streak {
    const hash = fnv1a(`streak:${seed}:${Math.floor(Math.random() * 1e9)}`);

    return {
      bearing: (((hash % 2000) / 1000 - 1) * Math.PI) / 2.4,
      depth: 1 + ((hash >>> 8) % 1000) / 250,
      vOffset: ((hash >>> 16) % 2000) / 1000 - 1,
    };
  }

  function drawDistantStars(heading: number, horizon: number, nowS: number): void {
    for (const star of distant) {
      const bearing = wrapAngle(star.angle - heading);

      if (Math.abs(bearing) > 1.35) {
        continue;
      }

      const x = Math.round(width / 2 + (bearing / 1.1) * (width / 2));
      const y = Math.round(star.yFraction * (height - 24));
      const twinkle = reducedMotion ? 1 : 0.7 + 0.3 * Math.sin(nowS * 1.7 + star.twinkle);

      ctx.globalAlpha = twinkle;
      ctx.fillStyle = star.ink;
      ctx.fillRect(x, y, 1, 1);
    }

    ctx.globalAlpha = 1;
  }

  // Foreground motion: pseudo-3D specks streaming out of the horizon. Their
  // outward acceleration is the speed read; boost stretches them to streaks.
  function drawStreaks(dt: number, speedFactor: number, steer: number, horizon: number): void {
    for (let index = 0; index < streaks.length; index++) {
      const streak = streaks[index];

      streak.depth -= dt * speedFactor * 1.6;
      streak.bearing -= dt * steer * 0.8;

      if (streak.depth <= 0.12 || Math.abs(streak.bearing) > Math.PI / 2) {
        streaks[index] = spawnStreak(index);
        continue;
      }

      const x = Math.round(width / 2 + (streak.bearing / 1.1) * (width / 2 / streak.depth));
      const y = Math.round(horizon + (streak.vOffset * 56 + 14) / streak.depth);

      if (x < 0 || x >= width || y < 0 || y >= height) {
        continue;
      }

      const length = speedFactor > 1.6 && !reducedMotion ? Math.min(7, speedFactor) : 1;

      ctx.globalAlpha = Math.min(0.85, 1.2 - streak.depth * 0.22);
      ctx.fillStyle = streak.depth < 1.4 ? palette.creamMuted : palette.creamDim;
      ctx.fillRect(x, y, 1, Math.round(length));
    }

    ctx.globalAlpha = 1;
  }

  type Projected = {
    /** Forward distance in the ship frame. */
    f: number;
    sx: number;
    sy: number;
  };

  function project(sim: SimState, x: number, y: number, vOffset: number): Projected | undefined {
    const { ship } = sim;
    const dx = x - ship.x;
    const dy = y - ship.y;
    const cos = Math.cos(ship.heading);
    const sin = Math.sin(ship.heading);
    const f = dx * cos + dy * sin;

    if (f < 10) {
      return undefined;
    }

    const lateral = -dx * sin + dy * cos;
    const focal = width * 0.55;
    const horizon = height * HORIZON_FRACTION;

    return {
      f,
      sx: width / 2 + (lateral / f) * focal,
      sy: horizon - (vOffset / f) * focal,
    };
  }

  function drawWorld(sim: SimState, view: RenderView): void {
    type Body = { draw: () => void; f: number };

    const bodies: Body[] = [];

    // Earth.
    const earth = project(sim, 0, 0, 0);

    if (earth) {
      const size = Math.min(130, (width * 0.55 * EARTH_BODY) / earth.f);

      if (size >= 2) {
        bodies.push({
          draw: () => {
            const sprite = earthSprite(size);

            ctx.drawImage(
              sprite,
              Math.round(earth.sx - sprite.width / 2),
              Math.round(earth.sy - sprite.height / 2),
            );
          },
          f: earth.f,
        });
      }
    }

    for (let index = 0; index < sim.stars.length; index++) {
      const star = sim.stars[index];
      const projected = project(sim, star.x, star.y, star.vOffset);

      if (!projected) {
        continue;
      }

      const collected = sim.collected[index];
      const isCarrier = view.carrier?.starIndex === index;
      const size = Math.min(34, Math.max(1, (width * 0.55 * STAR_BODY) / projected.f));

      bodies.push({
        draw: () =>
          drawStarBody(
            Math.round(projected.sx),
            Math.round(projected.sy),
            size,
            view.nowS,
            collected,
            isCarrier,
          ),
        f: projected.f,
      });
    }

    bodies.sort((a, b) => b.f - a.f);

    for (const body of bodies) {
      body.draw();
    }
  }

  /** A banger star: a pulsing pixel diamond, gold while uncollected. */
  function drawStarBody(
    x: number,
    y: number,
    size: number,
    nowS: number,
    collected: boolean,
    isCarrier: boolean,
  ): void {
    const pulse = reducedMotion || collected ? 0 : Math.sin(nowS * 4 + x) * Math.max(1, size * 0.1);
    const radius = Math.max(1, Math.round(size / 2 + pulse));
    const core = collected ? palette.creamMuted : palette.goldBright;
    const mid = collected ? palette.creamDim : palette.gold;
    const halo = collected ? palette.creamDim : palette.goldDim;

    if (radius > 2) {
      ctx.globalAlpha = collected ? 0.2 : 0.35;
      pixelDiamond(x, y, radius + 2, halo);
    }

    ctx.globalAlpha = collected ? 0.7 : 0.9;
    pixelDiamond(x, y, radius, mid);
    ctx.globalAlpha = 1;
    pixelDiamond(x, y, Math.max(1, Math.round(radius * 0.55)), core);

    if (isCarrier && !collected && radius >= 2) {
      ctx.fillStyle = palette.creamBright;
      ctx.fillRect(x, y - radius - 3, 1, 2);
    }
  }

  function pixelDiamond(x: number, y: number, radius: number, ink: string): void {
    ctx.fillStyle = ink;

    for (let dy = -radius; dy <= radius; dy++) {
      const span = radius - Math.abs(dy);

      ctx.fillRect(x - span, y + dy, span * 2 + 1, 1);
    }
  }

  function drawShip(view: RenderView): void {
    const { sim } = view;
    const scale = 2;
    const bob = reducedMotion ? 0 : Math.sin(view.nowS * 2.1) * 1.4;
    const shipX = width / 2;
    const shipY = height - 46 + bob;
    const tilt = view.steer * 0.16;

    ctx.save();
    ctx.translate(Math.round(shipX), Math.round(shipY));
    ctx.rotate(tilt);

    // Engine flames first, under the hull. Boost burns long and bright.
    const boosting = sim.ship.boosting;
    const flameBase = boosting ? 9 : 4;

    if (sim.phase !== "adrift") {
      for (const anchor of SHIP_FLAME_ANCHORS) {
        const flicker = reducedMotion ? 0 : Math.random() * 3;
        const length = Math.round(flameBase + flicker);
        const fx = Math.round((anchor - SHIP_SIZE / 2) * scale);

        ctx.fillStyle = boosting ? palette.goldBright : palette.red;
        ctx.fillRect(fx - 1, 15 * scale - 14, 2, length);
        ctx.fillStyle = boosting ? palette.red : palette.redDim;
        ctx.fillRect(fx - 1, 15 * scale - 14 + length, 2, 2);
      }
    }

    ctx.drawImage(
      shipSprite,
      Math.round((-SHIP_SIZE / 2) * scale),
      -15,
      SHIP_SIZE * scale,
      15 * scale,
    );
    ctx.restore();
  }

  function drawHud(view: RenderView): void {
    const { sim } = view;

    drawTally(sim);
    drawFuel(sim, view.nowS);
    drawRadar(view);
    drawSignal(view);
    drawTelemetry(view);
    drawLogCard(view);

    if (view.muted) {
      ctx.fillStyle = palette.creamDim;
      ctx.font = '7px "Oxanium", monospace';
      ctx.textAlign = "right";
      ctx.fillText("muted", width - 6, 8);
      ctx.textAlign = "left";
    }

    if (view.touch && view.phase === "play") {
      drawTouchHints();
    }
  }

  function drawTally(sim: SimState): void {
    ctx.font = '800 14px "Oxanium", monospace';
    ctx.fillStyle = palette.cream;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    const count = `${sim.collectedCount}/${sim.stars.length}`;

    ctx.fillText(count, 8, 7);

    const countWidth = ctx.measureText(count).width;

    ctx.font = '8px "Oxanium", monospace';
    ctx.fillStyle = palette.creamMuted;
    ctx.fillText("bangers", 8 + countWidth + 5, 12);
  }

  function drawFuel(sim: SimState, nowS: number): void {
    const x = 8;
    const y = height - 18;
    const segments = 12;
    const fraction = sim.ship.fuel / sim.config.tankCapacity;
    const filled = Math.ceil(fraction * segments);
    const low = fraction <= 0.25;
    const blink = low && !reducedMotion && Math.sin(nowS * 7) > 0;

    ctx.font = '7px "Oxanium", monospace';
    ctx.fillStyle = palette.creamDim;
    ctx.fillText("Fuel", x, y - 9);

    for (let segment = 0; segment < segments; segment++) {
      const lit = segment < filled;

      ctx.fillStyle = lit
        ? low
          ? blink
            ? palette.redBright
            : palette.red
          : palette.gold
        : palette.tapeBlack;
      ctx.fillRect(x + segment * 6, y, 4, 7);
    }
  }

  function drawRadar(view: RenderView): void {
    const radius = 26;
    const cx = width - radius - 10;
    const cy = height - radius - 12;

    ctx.globalAlpha = 0.72;
    ctx.fillStyle = palette.sleeveBlack;
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = palette.creamDim;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.arc(cx, cy, radius / 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Sweep line, heading-up.
    if (!reducedMotion) {
      const sweep = (view.nowS * 1.6) % (Math.PI * 2);

      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = palette.gold;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.sin(sweep) * radius, cy - Math.cos(sweep) * radius);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    for (const blip of view.radar) {
      const range = blip.distance / view.sim.config.radarRange;
      const bx = Math.round(cx + Math.sin(blip.bearing) * range * (radius - 3));
      const by = Math.round(cy - Math.cos(blip.bearing) * range * (radius - 3));

      if (blip.kind === "earth") {
        ctx.fillStyle = palette.coolBlue;
        ctx.fillRect(bx - 1, by - 1, 3, 3);
        ctx.fillStyle = palette.creamBright;
        ctx.fillRect(bx, by, 1, 1);
      } else {
        const pulse = reducedMotion ? 1 : 0.6 + 0.4 * Math.sin(view.nowS * 5 + blip.starIndex);

        ctx.globalAlpha = pulse;
        ctx.fillStyle = palette.gold;
        ctx.fillRect(bx - 1, by - 1, 2, 2);
        ctx.globalAlpha = 1;
      }
    }

    // The ship: a tick at scope center, always pointing up.
    ctx.fillStyle = palette.cream;
    ctx.fillRect(cx, cy - 2, 1, 4);
    ctx.fillRect(cx - 1, cy + 1, 3, 1);
  }

  function drawSignal(view: RenderView): void {
    const x = width - 62;
    const y = height - 8;

    ctx.font = '7px "Oxanium", monospace';
    ctx.textAlign = "left";

    const { sim } = view;
    const locked = sim.orbitIndex >= 0 || sim.atEarth;

    if (locked) {
      ctx.fillStyle = palette.goldBright;
      ctx.fillText("LOCK", x, y);
    } else if (view.carrier && view.carrier.strength > 0) {
      ctx.fillStyle = palette.gold;
      ctx.fillText(`carrier ${Math.round(view.carrier.strength * 100)}%`, x, y);
    } else {
      ctx.fillStyle = palette.creamDim;
      ctx.fillText("scanning", x, y);
    }
  }

  function drawTelemetry(view: RenderView): void {
    ctx.font = '7px "Oxanium", monospace';
    ctx.textAlign = "center";

    for (let index = 0; index < view.telemetry.length; index++) {
      const lineY = height - 88 - (view.telemetry.length - 1 - index) * 9;

      ctx.fillStyle = index === view.telemetry.length - 1 ? palette.creamMuted : palette.creamDim;
      ctx.fillText(view.telemetry[index], width / 2, lineY);
    }

    ctx.textAlign = "left";
  }

  function drawLogCard(view: RenderView): void {
    const card = view.logCard;

    if (!card) {
      return;
    }

    const cardWidth = Math.min(width - 32, 230);
    const x = Math.round((width - cardWidth) / 2);
    const y = 26;
    const entrance = Math.min(1, card.age * 4);

    ctx.globalAlpha = 0.92 * entrance;
    ctx.fillStyle = palette.dustLine;
    ctx.fillRect(x - 1, y - 1, cardWidth + 2, 44);
    ctx.fillStyle = palette.tapeBlack;
    ctx.fillRect(x, y, cardWidth, 42);

    ctx.fillStyle = palette.gold;
    ctx.font = '8px "Oxanium", monospace';
    ctx.textAlign = "left";
    ctx.fillText(`fluncle://${card.logId}`, x + 7, y + 6);

    ctx.fillStyle = palette.cream;
    ctx.font = "800 9px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(clip(card.title, cardWidth - 14), x + 7, y + 17);

    ctx.fillStyle = palette.creamMuted;
    ctx.font = "8px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(clip(card.artistLine, cardWidth - 14), x + 7, y + 28);

    ctx.fillStyle = card.refuelling ? palette.goldDim : palette.creamDim;
    ctx.font = '7px "Oxanium", monospace';
    ctx.fillText(card.refuelling ? "Banger logged · refuelling" : "Banger logged", x + 7, y + 37);
    ctx.globalAlpha = 1;
  }

  function clip(text: string, maxWidth: number): string {
    if (ctx.measureText(text).width <= maxWidth) {
      return text;
    }

    let clipped = text;

    while (clipped.length > 3 && ctx.measureText(`${clipped}…`).width > maxWidth) {
      clipped = clipped.slice(0, -1);
    }

    return `${clipped}…`;
  }

  function drawTouchHints(): void {
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = palette.cream;
    ctx.font = '10px "Oxanium", monospace';
    ctx.textAlign = "left";
    ctx.fillText("◂", 7, height / 2);
    ctx.textAlign = "right";
    ctx.fillText("▸", width - 7, height / 2);
    ctx.textAlign = "center";
    ctx.font = '6px "Oxanium", monospace';
    ctx.fillText("hold to boost", width / 2, height - 6);
    ctx.globalAlpha = 1;
    ctx.textAlign = "left";
  }

  function drawGate(view: RenderView): void {
    // A quiet starfield behind the plate, drifting just enough to feel alive.
    drawDistantStars(reducedMotion ? 0 : view.nowS * 0.02, Math.round(height * 0.4), view.nowS);

    const cx = width / 2;
    const orbY = Math.round(height * 0.26);
    const pulse = reducedMotion ? 0 : Math.sin(view.nowS * 2) * 1.5;

    drawStarBody(cx, orbY, 26 + pulse, view.nowS, false, false);

    ctx.textAlign = "center";
    ctx.fillStyle = palette.gold;
    ctx.font = '800 21px "Oxanium", monospace';
    ctx.fillText("FLUNCLE'S GALAXY", cx, orbY + 32);

    ctx.fillStyle = palette.cream;
    ctx.font = "9px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText("Every banger out there is a star.", cx, orbY + 58);

    ctx.fillStyle = palette.creamMuted;
    ctx.font = '8px "Oxanium", monospace';
    ctx.fillText(
      view.touch
        ? "Touch sides to steer · hold centre to boost"
        : "Steer with arrows · hold space to boost",
      cx,
      orbY + 80,
    );
    ctx.fillText("Fly to a star to log it and refuel. Dry tank, towed home.", cx, orbY + 92);

    const blink = reducedMotion ? 1 : 0.5 + 0.5 * Math.sin(view.nowS * 3);

    ctx.globalAlpha = blink;
    ctx.fillStyle = palette.goldBright;
    ctx.fillText(view.touch ? "Tap to launch" : "Press any key to launch", cx, orbY + 112);
    ctx.globalAlpha = 1;

    // Status line while the catalogue loads (or when the sector is quiet).
    const status = view.telemetry.at(-1);

    if (status) {
      ctx.fillStyle = palette.creamDim;
      ctx.font = '7px "Oxanium", monospace';
      ctx.fillText(status, cx, height - 12);
    }

    ctx.textAlign = "left";
  }

  function drawBoot(view: RenderView, horizon: number): void {
    const t = view.bootT;
    const cx = width / 2;

    // Earth falls away below as the ship climbs out.
    const earthSize = Math.max(10, 150 - t * 170);
    const earthY = height - 30 + t * 190;

    if (earthSize > 10 && earthY - earthSize / 2 < height) {
      const sprite = earthSprite(earthSize);

      ctx.drawImage(
        sprite,
        Math.round(cx - sprite.width / 2),
        Math.round(earthY - sprite.height / 2),
      );
    }

    // The ship climbs into frame with a long burn.
    const shipY = height - 20 - t * 26;
    const shake = reducedMotion || t > 0.7 ? 0 : Math.round(Math.random() * 2 - 1);

    ctx.save();
    ctx.translate(Math.round(cx + shake), Math.round(shipY));

    for (const anchor of SHIP_FLAME_ANCHORS) {
      const fx = Math.round((anchor - SHIP_SIZE / 2) * 2);
      const length = 10 + (reducedMotion ? 0 : Math.random() * 5);

      ctx.fillStyle = palette.goldBright;
      ctx.fillRect(fx - 1, 16, 2, Math.round(length));
      ctx.fillStyle = palette.red;
      ctx.fillRect(fx - 1, 16 + Math.round(length), 2, 3);
    }

    ctx.drawImage(shipSprite, -SHIP_SIZE, -15, SHIP_SIZE * 2, 15 * 2);
    ctx.restore();

    if (t < 0.5) {
      ctx.globalAlpha = 1 - t * 2;
      ctx.textAlign = "center";
      ctx.fillStyle = palette.creamMuted;
      ctx.font = '7px "Oxanium", monospace';
      ctx.fillText("leaving home", cx, horizon - 30);
      ctx.globalAlpha = 1;
      ctx.textAlign = "left";
    }
  }

  function drawTowed(view: RenderView): void {
    // In, hold, out: a full fade with the tow line on the black.
    const t = view.towedT / TOWED_SECONDS;
    const alpha = t < 0.3 ? t / 0.3 : t > 0.75 ? (1 - t) / 0.25 : 1;

    ctx.globalAlpha = Math.min(1, alpha);
    ctx.fillStyle = palette.deepField;
    ctx.fillRect(0, 0, width, height);

    if (alpha > 0.8) {
      ctx.textAlign = "center";
      ctx.fillStyle = palette.creamMuted;
      ctx.font = '8px "Oxanium", monospace';
      ctx.fillText("Recovered adrift. Towed home.", width / 2, height / 2 - 4);
      ctx.fillStyle = palette.creamDim;
      ctx.fillText("The log starts over.", width / 2, height / 2 + 8);
      ctx.textAlign = "left";
    }

    ctx.globalAlpha = 1;
  }

  function drawEnd(view: RenderView): void {
    const { sim } = view;
    const cx = width / 2;

    ctx.globalAlpha = 0.82;
    ctx.fillStyle = palette.deepField;
    ctx.fillRect(0, 0, width, height);
    ctx.globalAlpha = 1;

    ctx.textAlign = "center";
    ctx.fillStyle = palette.gold;
    ctx.font = '800 16px "Oxanium", monospace';
    ctx.fillText("Galaxy logged.", cx, 22);

    ctx.fillStyle = palette.cream;
    ctx.font = '10px "Oxanium", monospace';
    ctx.fillText(`${sim.collectedCount}/${sim.stars.length} bangers`, cx, 42);

    // The full log rolls like credits, oldest coordinate first.
    const rollTop = 60;
    const rollBottom = height - 22;
    const lineHeight = 11;
    const ordered = [...sim.stars].sort((a, b) => a.logId.localeCompare(b.logId));
    const rollHeight = ordered.length * lineHeight;
    const overflow = Math.max(0, rollHeight - (rollBottom - rollTop));
    const scroll = Math.min(overflow, Math.max(0, (view.endT - 1.2) * 9));

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, rollTop, width, rollBottom - rollTop);
    ctx.clip();

    for (let index = 0; index < ordered.length; index++) {
      const star = ordered[index];
      const y = rollTop + index * lineHeight - scroll;

      if (y < rollTop - lineHeight || y > rollBottom) {
        continue;
      }

      ctx.fillStyle = palette.goldDim;
      ctx.font = '7px "Oxanium", monospace';
      ctx.textAlign = "right";
      ctx.fillText(star.logId, cx - 6, y);

      ctx.fillStyle = palette.creamMuted;
      ctx.font = "7px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(clip(`${star.artistLine} — ${star.title}`, cx - 16), cx + 2, y);
    }

    ctx.restore();

    const blink = reducedMotion ? 1 : 0.5 + 0.5 * Math.sin(view.nowS * 3);

    ctx.globalAlpha = blink;
    ctx.textAlign = "center";
    ctx.fillStyle = palette.goldBright;
    ctx.font = '8px "Oxanium", monospace';
    ctx.fillText(view.touch ? "Tap to fly again" : "Press enter to fly again", cx, height - 8);
    ctx.globalAlpha = 1;
    ctx.textAlign = "left";
  }

  // Scanlines, vignette, grain — the cost of light-years, on every frame.
  function drawFilmTexture(nowS: number): void {
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = "#000000";

    for (let y = 0; y < height; y += 2) {
      ctx.fillRect(0, y, width, 1);
    }

    ctx.globalAlpha = 1;

    const vignette = ctx.createRadialGradient(
      width / 2,
      height / 2,
      height * 0.45,
      width / 2,
      height / 2,
      height * 0.95,
    );

    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(1, "rgba(0,0,0,0.5)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);

    if (!reducedMotion) {
      ctx.globalAlpha = 0.05;
      ctx.fillStyle = palette.cream;

      for (let grain = 0; grain < 50; grain++) {
        const hash = fnv1a(`g:${grain}:${Math.floor(nowS * 24)}`);

        ctx.fillRect(hash % width, (hash >>> 11) % height, 1, 1);
      }

      ctx.globalAlpha = 1;
    }
  }

  resize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);

  return {
    canvas,
    destroy: () => {
      canvas.remove();
    },
    draw,
    resize,
  };
}

export const BOOT_DURATION = BOOT_SECONDS;
export const TOWED_DURATION = TOWED_SECONDS;
