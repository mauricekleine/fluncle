import {
  ATLAS_MARGIN,
  THREAD_STEP,
  atlasCaption,
  atlasMarkState,
  atlasScale,
  atlasThreadEnd,
  atlasWorldRadius,
  frontierTipIndex,
  nearestStarIndex,
} from "./atlas";
import { palette } from "./palette";
import { fnv1a, spiralPoint } from "./placement";
import { type CarrierInfo, type RadarBlip, type SimState, wrapAngle } from "./sim";
import {
  ASTEROID_SIZE,
  ROADSTER_SIZE,
  SHIP_SIZE,
  UFO_SIZE,
  makeAsteroidSprite,
  makeEarthSprite,
  makeRoadsterSprite,
  makeShipSprite,
  makeUfoSprite,
} from "./sprites";
import { type FrontierEntity } from "./types";

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

/** Distance band relative to the instruments: audio range, radar range, past. */
type StarTier = "far" | "mid" | "near";

export type LogCardView = {
  age: number;
  artistLine: string;
  logId: string;
  refuelling: boolean;
  spotifyUrl: string;
  title: string;
};

/** An on-canvas hit zone, in internal canvas pixels. */
type HitRect = {
  h: number;
  w: number;
  x: number;
  y: number;
};

/** The atlas overlay's per-frame inputs (open when present). */
export type AtlasView = {
  /** Latest pointer position in internal canvas px, for the hover label. */
  pointer?: { x: number; y: number };
  /**
   * Sticky hover: the last star the pointer actually hit. A pointer sweeping the
   * gap BETWEEN marks holds this label instead of flashing the keyboard fallback
   * (nearest-to-ship reads as "the first star" from Earth's parking orbit).
   */
  lastHoverIndex?: number;
};

export type RenderView = {
  atlas?: AtlasView;
  bootT: number;
  carrier?: CarrierInfo;
  endT: number;
  logCard?: LogCardView;
  muted: boolean;
  nowS: number;
  paused: boolean;
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
  /** Where the card's Spotify link was drawn this frame, if anywhere. */
  spotifyLinkRect: () => HitRect | undefined;
  /** Where the top-right volume toggle was drawn this frame. */
  volumeRect: () => HitRect | undefined;
};

export function createRenderer(container: HTMLElement): Renderer {
  const canvas = document.createElement("canvas");

  canvas.style.display = "block";
  canvas.style.imageRendering = "pixelated";
  container.style.alignItems = "center";
  container.style.display = "flex";
  container.style.justifyContent = "center";
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

  // Hero sprites (image-gen, curated, quantized to the canon ramp) load over
  // the procedural placeholders; until onload fires, the fallbacks draw.
  const heroShip = new Image();
  const heroEarth = new Image();
  let heroShipReady = false;
  let heroEarthReady = false;

  heroShip.onload = () => {
    heroShipReady = true;
  };
  heroEarth.onload = () => {
    heroEarthReady = true;
  };
  heroShip.src = "/galaxy/ship.png";
  heroEarth.src = "/galaxy/earth.png";

  // Frontier set-dressing sprites (Unit B): bespoke Nano-Banana PNGs over the
  // procedural fallbacks, the same hero pattern as ship/earth.
  const roadsterSprite = makeRoadsterSprite();
  const ufoSprite = makeUfoSprite();
  const asteroidSprite = makeAsteroidSprite();
  const heroRoadster = new Image();
  const heroUfo = new Image();
  const heroAsteroid = new Image();
  let heroRoadsterReady = false;
  let heroUfoReady = false;
  let heroAsteroidReady = false;

  heroRoadster.onload = () => {
    heroRoadsterReady = true;
  };
  heroUfo.onload = () => {
    heroUfoReady = true;
  };
  heroAsteroid.onload = () => {
    heroAsteroidReady = true;
  };
  heroRoadster.src = "/galaxy/roadster.png";
  heroUfo.src = "/galaxy/ufo.png";
  heroAsteroid.src = "/galaxy/asteroid.png";

  type ShipSpriteInfo = {
    /** Engine nozzle x-positions in sprite pixels. */
    flameAnchors: [number, number];
    height: number;
    img: CanvasImageSource;
    width: number;
  };

  function shipInfo(): ShipSpriteInfo {
    return heroShipReady
      ? { flameAnchors: [8.5, 16.5], height: 20, img: heroShip, width: 25 }
      : { flameAnchors: [5, 10], height: 15, img: shipSprite, width: SHIP_SIZE };
  }

  /** Earth, centered at (x, y) with the given pixel diameter. */
  function drawEarthAt(x: number, y: number, size: number): void {
    if (heroEarthReady) {
      const drawHeight = Math.round((size * heroEarth.naturalHeight) / heroEarth.naturalWidth);

      ctx.drawImage(
        heroEarth,
        Math.round(x - size / 2),
        Math.round(y - drawHeight / 2),
        Math.round(size),
        drawHeight,
      );

      return;
    }

    const sprite = earthSprite(size);

    ctx.drawImage(sprite, Math.round(x - sprite.width / 2), Math.round(y - sprite.height / 2));
  }

  let width = 480;
  let height = INTERNAL_HEIGHT;
  let lastNow = 0;
  let spotifyRect: HitRect | undefined;
  let volumeRect: HitRect | undefined;

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

  // Strict integer upscaling: the internal grid is blown up by a whole
  // factor and letterboxed by at most scale-1 px. Fractional nearest-
  // neighbour scaling smears pixels unevenly — integer scaling is what
  // keeps the 8-bit text crisp.
  function resize(cssWidth: number, cssHeight: number): void {
    const byHeight = Math.round(Math.max(1, cssHeight) / INTERNAL_HEIGHT);
    const byWidth = Math.floor(Math.max(1, cssWidth) / 160);
    const scale = Math.max(1, Math.min(byHeight, byWidth));

    height = Math.max(180, Math.floor(cssHeight / scale));
    width = Math.max(160, Math.min(768, Math.floor(cssWidth / scale)));
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${width * scale}px`;
    canvas.style.height = `${height * scale}px`;
    ctx.imageSmoothingEnabled = false;
  }

  function draw(view: RenderView): void {
    const dt = Math.min(0.1, Math.max(0, view.nowS - lastNow));

    lastNow = view.nowS;
    spotifyRect = undefined;
    volumeRect = undefined;

    const { sim } = view;
    const horizon = Math.round(height * HORIZON_FRACTION);

    ctx.fillStyle = palette.deepField;
    ctx.fillRect(0, 0, width, height);

    // The film texture lands hard on the world and only whispers over the
    // instruments: the Light-Years Rule wants the lossiness, and its own
    // fine print wants the UI readable (degradation never breaks the HUD).
    if (view.phase === "gate") {
      drawGate(view);
      drawFilmTexture(view.nowS, 0.55);

      return;
    }

    if (view.phase === "play" && sim.phase === "orbiting") {
      drawOrbitScene(view);
      drawFilmTexture(view.nowS, 1);
      drawHud(view);

      if (view.atlas) {
        drawAtlas(view);
      }

      if (view.paused) {
        drawPause(view);
      }

      drawFilmTexture(view.nowS, 0.3);

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

    drawFilmTexture(view.nowS, 1);

    if (view.phase === "play" || view.phase === "boot") {
      drawHud(view);
    }

    if (view.phase === "end") {
      drawEnd(view);
    }

    if (view.towedT > 0) {
      drawTowed(view);
    }

    if (view.atlas) {
      drawAtlas(view);
    }

    if (view.paused) {
      drawPause(view);
    }

    drawFilmTexture(view.nowS, 0.3);
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
      if (streak === undefined) {
        continue;
      }

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

    // Apparent height saturates close-in: far stars scatter well above and
    // below the horizon (depth cue), while an approached star glides toward
    // eye level instead of flying off the screen edge.
    const effectiveVOffset = vOffset * Math.min(1, f / 700);

    return {
      f,
      sx: width / 2 + (lateral / f) * focal,
      sy: horizon - (effectiveVOffset / f) * focal,
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
          draw: () => drawEarthAt(earth.sx, earth.sy, size),
          f: earth.f,
        });
      }
    }

    for (let index = 0; index < sim.stars.length; index++) {
      const star = sim.stars[index];
      if (star === undefined) {
        continue;
      }
      const projected = project(sim, star.x, star.y, star.vOffset);

      if (!projected) {
        continue;
      }

      const collected = star.collected;
      const isCarrier = view.carrier?.starIndex === index;
      const { ship } = sim;
      const distance = Math.hypot(star.x - ship.x, star.y - ship.y);

      // Depth tiers that match the instruments: past radar range a star is a
      // faint speck, on the scope it burns steady gold, inside audio range it
      // pulses and swells fast. "Fat and glowing" means "on your scope."
      const tier: StarTier =
        distance <= sim.config.audioRange
          ? "near"
          : distance <= sim.config.radarRange
            ? "mid"
            : "far";
      const nearBoost = tier === "near" ? 1 + (1 - distance / sim.config.audioRange) * 0.6 : 1;
      const baseSize = ((width * 0.55 * STAR_BODY) / projected.f) * nearBoost;
      const size =
        tier === "far" ? Math.min(3, Math.max(1, baseSize)) : Math.min(36, Math.max(2, baseSize));

      bodies.push({
        draw: () =>
          drawStarWithLifetime(
            star.lifetimeLogged === true,
            Math.round(projected.sx),
            Math.round(projected.sy),
            size,
            view.nowS,
            collected,
            isCarrier,
            tier,
          ),
        f: projected.f,
      });
    }

    // The dynamic frontier (set-dressing, hazards, bolts) shares the depth sort
    // with the stars and Earth. Set-dressing drifts/tumbles cosmetically off
    // nowS so the motion freezes under reduced-motion without touching the sim.
    for (const entity of sim.entities) {
      const sway = reducedMotion ? 0 : Math.sin(view.nowS * 0.05 + (entity.spin ?? 0)) * 18;
      const projected = project(
        sim,
        entity.x + Math.cos(entity.spin ?? 0) * sway,
        entity.y + Math.sin(entity.spin ?? 0) * sway,
        entity.vOffset,
      );

      if (!projected) {
        continue;
      }

      const bodyRadius = entity.bodyRadius ?? 14;
      const size = Math.min(44, Math.max(2, (width * 0.55 * bodyRadius) / projected.f));
      const sx = Math.round(projected.sx);
      const sy = Math.round(projected.sy);

      bodies.push({
        draw: () => drawFrontierEntity(entity, sx, sy, size, view.nowS),
        f: projected.f,
      });
    }

    bodies.sort((a, b) => b.f - a.f);

    for (const body of bodies) {
      body.draw();
    }
  }

  type FrontierSprite = { h: number; img: CanvasImageSource; w: number };

  function frontierSprite(entity: FrontierEntity): FrontierSprite | undefined {
    if (entity.kind === "roadster") {
      return heroRoadsterReady
        ? { h: heroRoadster.naturalHeight, img: heroRoadster, w: heroRoadster.naturalWidth }
        : { h: roadsterSprite.height, img: roadsterSprite, w: ROADSTER_SIZE };
    }

    if (entity.kind === "ufo") {
      return heroUfoReady
        ? { h: heroUfo.naturalHeight, img: heroUfo, w: heroUfo.naturalWidth }
        : { h: ufoSprite.height, img: ufoSprite, w: UFO_SIZE };
    }

    if (entity.kind === "asteroid") {
      return heroAsteroidReady
        ? { h: heroAsteroid.naturalHeight, img: heroAsteroid, w: heroAsteroid.naturalWidth }
        : { h: asteroidSprite.height, img: asteroidSprite, w: ASTEROID_SIZE };
    }

    return undefined;
  }

  // Dispatch by kind. Set-dressing is atmosphere: the Roadster tumbles slowly,
  // the UFO hovers over a dim teal underglow and bobs — placed and alive, never
  // a static decal. Hazards and bolts use their own draw paths.
  function drawFrontierEntity(
    entity: FrontierEntity,
    x: number,
    y: number,
    size: number,
    nowS: number,
  ): void {
    // The black hole: a void that bends the light around it. The cool lensing
    // rim shimmers (frozen under reduced-motion); the gravity is gameplay, not
    // decoration, so it never freezes (it lives in the sim).
    if (entity.kind === "blackhole") {
      const r = Math.max(2, Math.round(size / 2));
      const shimmer =
        reducedMotion || r < 3 ? 0 : Math.round(Math.sin(nowS * 3 + (entity.spin ?? 0)) * 1.5);

      ctx.globalAlpha = 0.5;
      pixelDiamond(x, y, r + 2 + shimmer, palette.coolBlue);
      ctx.globalAlpha = 0.85;
      pixelDiamond(x, y, r + 1, palette.creamDim);
      ctx.globalAlpha = 1;
      pixelDiamond(x, y, r, "#000000");

      return;
    }

    // The laser bolt: a short streak of Re-entry-Red heat along its flight (not
    // gold — gold stays the bangers and the sun, One Sun Rule).
    if (entity.kind === "bolt") {
      const angle = Math.atan2(entity.vy, entity.vx);
      const length = Math.max(4, Math.round(size * 1.6));

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.fillStyle = palette.redBright;
      ctx.fillRect(-Math.round(length / 2), 0, length, 1);
      ctx.fillStyle = palette.red;
      ctx.fillRect(-1, -1, 2, 3);
      ctx.restore();

      return;
    }

    const sprite = frontierSprite(entity);

    if (!sprite) {
      return;
    }

    const phase = entity.spin ?? 0;
    const drawWidth = size;
    const drawHeight = (size * sprite.h) / sprite.w;

    if (entity.kind === "ufo") {
      const bob = reducedMotion ? 0 : Math.sin(nowS * 1.3 + phase) * Math.max(1, size * 0.06);
      const glow = reducedMotion ? 0.5 : 0.4 + 0.2 * Math.sin(nowS * 2 + phase);

      ctx.globalAlpha = glow * 0.5;
      ctx.fillStyle = palette.coolTeal;
      pixelDiamond(
        x,
        Math.round(y + bob + drawHeight * 0.4),
        Math.max(1, Math.round(size * 0.4)),
        palette.coolTeal,
      );
      ctx.globalAlpha = 1;
      drawSpriteScaled(sprite.img, x, Math.round(y + bob), drawWidth, drawHeight, 0);

      return;
    }

    // Roadster: a slow tumble, frozen to a fixed lean under reduced-motion.
    const rotation = reducedMotion ? phase : nowS * 0.4 + phase;

    drawSpriteScaled(sprite.img, x, y, drawWidth, drawHeight, rotation);
  }

  function drawSpriteScaled(
    img: CanvasImageSource,
    x: number,
    y: number,
    w: number,
    h: number,
    rotation: number,
  ): void {
    ctx.save();
    ctx.translate(x, y);

    if (rotation) {
      ctx.rotate(rotation);
    }

    ctx.drawImage(img, Math.round(-w / 2), Math.round(-h / 2), Math.round(w), Math.round(h));
    ctx.restore();
  }

  function drawStarWithLifetime(
    lifetimeLogged: boolean,
    x: number,
    y: number,
    size: number,
    nowS: number,
    collected: boolean,
    isCarrier: boolean,
    tier: StarTier,
  ): void {
    drawStarBody(x, y, size, nowS, collected, isCarrier, tier);

    if (!lifetimeLogged || collected || tier === "far") {
      return;
    }

    ctx.globalAlpha = 0.55;
    pixelDiamond(x, y, Math.max(2, Math.round(size / 2) + 3), palette.creamDim);
    ctx.globalAlpha = 1;
  }

  /** A banger star: a pulsing pixel diamond, gold while uncollected. */
  function drawStarBody(
    x: number,
    y: number,
    size: number,
    nowS: number,
    collected: boolean,
    isCarrier: boolean,
    tier: StarTier = "near",
  ): void {
    // Past the scope's reach: a faint dim speck, no pulse, no halo.
    if (tier === "far") {
      ctx.globalAlpha = collected ? 0.3 : 0.5;
      pixelDiamond(
        x,
        y,
        Math.max(1, Math.round(size / 2)),
        collected ? palette.creamDim : palette.goldDim,
      );
      ctx.globalAlpha = 1;

      return;
    }

    const near = tier === "near";
    const pulse =
      reducedMotion || collected || !near ? 0 : Math.sin(nowS * 4 + x) * Math.max(1, size * 0.12);
    const radius = Math.max(1, Math.round(size / 2 + pulse));
    const core = collected ? palette.creamMuted : near ? palette.goldBright : palette.gold;
    const mid = collected ? palette.creamDim : near ? palette.gold : palette.goldDim;
    const halo = collected ? palette.creamDim : palette.goldDim;

    if (radius > 2 && near) {
      ctx.globalAlpha = collected ? 0.2 : 0.35;
      pixelDiamond(x, y, radius + 2, halo);
    }

    ctx.globalAlpha = collected ? 0.6 : near ? 0.9 : 0.75;
    pixelDiamond(x, y, radius, mid);
    ctx.globalAlpha = collected ? 0.8 : 1;
    pixelDiamond(x, y, Math.max(1, Math.round(radius * 0.55)), core);
    ctx.globalAlpha = 1;

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
    const sprite = shipInfo();
    const bottom = Math.round((sprite.height * scale) / 2);

    if (sim.phase !== "adrift") {
      for (const anchor of sprite.flameAnchors) {
        const flicker = reducedMotion ? 0 : Math.random() * 3;
        const length = Math.round(flameBase + flicker);
        const fx = Math.round((anchor - sprite.width / 2) * scale);

        ctx.fillStyle = boosting ? palette.goldBright : palette.red;
        ctx.fillRect(fx - 1, bottom - 2, 2, length);
        ctx.fillStyle = boosting ? palette.red : palette.redDim;
        ctx.fillRect(fx - 1, bottom - 2 + length, 2, 2);
      }
    }

    ctx.drawImage(
      sprite.img,
      Math.round((-sprite.width / 2) * scale),
      Math.round((-sprite.height / 2) * scale),
      sprite.width * scale,
      sprite.height * scale,
    );
    ctx.restore();
  }

  // The listening moment: a meditative side-on scene. The banger burns big at
  // center, the ship drifts around it in a lazy ellipse, the card hangs above,
  // and the only instruction is the way out. No radar, no signal readout.
  function drawOrbitScene(view: RenderView): void {
    const { sim } = view;
    const star = sim.stars[sim.orbitIndex];

    if (!star) {
      return;
    }

    drawDistantStars(
      sim.ship.heading + (reducedMotion ? 0 : view.nowS * 0.018),
      Math.round(height * HORIZON_FRACTION),
      view.nowS,
    );

    const cx = Math.round(width / 2);
    const cy = Math.round(height * 0.5);
    const theta = reducedMotion ? Math.PI * 0.3 : view.nowS * 0.5;
    const orbitX = Math.min(104, Math.round(width * 0.3));
    const shipX = Math.round(cx + Math.cos(theta) * orbitX);
    const shipY = Math.round(cy + Math.sin(theta) * 24);

    const drawOrbitShip = (): void => {
      const rotation = Math.atan2(Math.cos(theta) * 24, -Math.sin(theta) * orbitX) + Math.PI / 2;
      const sprite = shipInfo();

      ctx.save();
      ctx.translate(shipX, shipY);
      ctx.rotate(rotation);
      ctx.drawImage(sprite.img, -Math.round(sprite.width / 2), -Math.round(sprite.height / 2));
      ctx.restore();
    };
    const drawOrbitStar = (): void => drawStarBody(cx, cy, 58, view.nowS, false, false);

    // Top of the ellipse reads as the far side; the star occludes the ship.
    if (Math.sin(theta) < 0) {
      drawOrbitShip();
      drawOrbitStar();
    } else {
      drawOrbitStar();
      drawOrbitShip();
    }

    const blink = reducedMotion ? 1 : 0.5 + 0.5 * Math.sin(view.nowS * 3);

    ctx.globalAlpha = blink;
    ctx.textAlign = "center";
    ctx.fillStyle = palette.goldBright;
    ctx.font = '8px "Oxanium", monospace';
    ctx.fillText(
      view.touch ? "Tap anywhere to fly on" : "Press any key to fly on",
      cx,
      height - 10,
    );
    ctx.globalAlpha = 1;
    ctx.textAlign = "left";
  }

  function drawHud(view: RenderView): void {
    const { sim } = view;
    const orbiting = sim.phase === "orbiting";

    drawTally(sim);
    drawFuel(sim, view.nowS);

    if (!orbiting) {
      drawRadar(view);
      drawSignal(view);
    }

    drawTelemetry(view);
    drawLogCard(view);
    drawVolumeToggle(view);

    if (view.touch && view.phase === "play" && !orbiting) {
      drawTouchHints();
    }
  }

  // The master volume toggle, top-right: a control, not a light (cream/dim,
  // never gold). A speaker with sound-waves when on, a Re-entry-Red slash when
  // muted. Reports its hit zone so taps/clicks reach handleUiTap; the M key
  // still toggles too. Default ON (the sim starts unmuted).
  function drawVolumeToggle(view: RenderView): void {
    const x0 = width - 14;
    const cy = 8;
    const ink = palette.creamMuted;

    volumeRect = { h: 14, w: 16, x: x0 - 2, y: 1 };

    ctx.fillStyle = ink;
    // The cone: a triangle widening down-right from the back.
    ctx.fillRect(x0, cy - 1, 1, 3);
    ctx.fillRect(x0 + 1, cy - 2, 1, 5);
    ctx.fillRect(x0 + 2, cy - 3, 1, 7);

    if (view.muted) {
      ctx.fillStyle = palette.red;

      for (let step = 0; step < 6; step++) {
        ctx.fillRect(x0 + 4 + step, cy - 3 + step, 1, 1);
      }

      return;
    }

    // Sound waves rolling out.
    ctx.fillRect(x0 + 4, cy - 1, 1, 3);
    ctx.fillRect(x0 + 6, cy - 3, 1, 7);
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
    const x = width - 66;
    const y = height - 9;

    ctx.font = '8px "Oxanium", monospace';
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
    ctx.font = "8px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";

    for (let index = 0; index < view.telemetry.length; index++) {
      const line = view.telemetry[index];
      if (line === undefined) {
        continue;
      }
      const lineY = height - 88 - (view.telemetry.length - 1 - index) * 9;

      ctx.fillStyle = index === view.telemetry.length - 1 ? palette.creamMuted : palette.creamDim;
      ctx.fillText(line, width / 2, lineY);
    }

    ctx.textAlign = "left";
  }

  function drawLogCard(view: RenderView): void {
    const card = view.logCard;

    if (!card) {
      return;
    }

    const cardWidth = Math.min(width - 32, 250);
    // Narrow screens give the Spotify link its own row.
    const linkOnOwnRow = cardWidth < 215;
    const cardHeight = linkOnOwnRow ? 68 : 56;
    const x = Math.round((width - cardWidth) / 2);
    const y = 24;
    const entrance = Math.min(1, card.age * 4);

    ctx.globalAlpha = 0.92 * entrance;
    ctx.fillStyle = palette.dustLine;
    ctx.fillRect(x - 1, y - 1, cardWidth + 2, cardHeight + 2);
    ctx.fillStyle = palette.tapeBlack;
    ctx.fillRect(x, y, cardWidth, cardHeight);

    ctx.fillStyle = palette.gold;
    ctx.font = '9px "Oxanium", monospace';
    ctx.textAlign = "left";
    ctx.fillText(`fluncle://${card.logId}`, x + 8, y + 7);

    ctx.fillStyle = palette.cream;
    ctx.font = "800 11px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(clip(card.title, cardWidth - 16), x + 8, y + 19);

    ctx.fillStyle = palette.creamMuted;
    ctx.font = "9px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(clip(card.artistLine, cardWidth - 16), x + 8, y + 33);

    ctx.fillStyle = card.refuelling ? palette.goldDim : palette.creamDim;
    ctx.font = "8px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(card.refuelling ? "Banger logged · refuelling" : "Banger logged", x + 8, y + 45);

    // The way out to the music itself; pressing it never steers the ship.
    const label = "Open in Spotify";
    const labelWidth = ctx.measureText(label).width;
    const linkX = linkOnOwnRow ? x + 8 : x + cardWidth - 8 - labelWidth;
    const linkY = linkOnOwnRow ? y + 57 : y + 45;

    ctx.fillStyle = palette.goldBright;
    ctx.fillText(label, linkX, linkY);
    spotifyRect = { h: 14, w: labelWidth + 12, x: linkX - 6, y: linkY - 3 };
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

    // Same face and size as the subtitle (the sans renders cleanly at this
    // grid; 8px Oxanium doesn't); the muted ink keeps the hierarchy.
    ctx.fillStyle = palette.creamMuted;
    ctx.font = "9px ui-sans-serif, system-ui, sans-serif";

    const steerLine = view.touch
      ? "Touch sides to steer · hold centre to boost"
      : "Steer with arrows · hold space to boost";
    const restLine = "Fly to a star to log it and refuel. Dry tank, towed home.";
    // The atlas is a keyboard instrument; touch gates skip the line.
    const atlasLines = view.touch ? [] : ["C opens the atlas."];
    const lines =
      width < 330
        ? [
            ...(view.touch
              ? ["Touch sides to steer", "Hold centre to boost"]
              : ["Steer with arrows", "Hold space to boost"]),
            "Fly to a star to log it and refuel.",
            "Dry tank, towed home.",
            ...atlasLines,
          ]
        : [steerLine, restLine, ...atlasLines];

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (line === undefined) {
        continue;
      }
      ctx.fillText(line, cx, orbY + 80 + index * 13);
    }

    const blink = reducedMotion ? 1 : 0.5 + 0.5 * Math.sin(view.nowS * 3);

    ctx.globalAlpha = blink;
    ctx.fillStyle = palette.goldBright;
    ctx.font = '8px "Oxanium", monospace';
    ctx.fillText(
      view.touch ? "Tap to launch" : "Press any key to launch",
      cx,
      orbY + 88 + lines.length * 13 + 8,
    );
    ctx.globalAlpha = 1;

    // Status line while the catalogue loads (or when the sector is quiet).
    const status = view.telemetry.at(-1);

    if (status) {
      ctx.fillStyle = palette.creamDim;
      ctx.font = '7px "Oxanium", monospace';
      ctx.fillText(status, cx, height - 12);
    }

    ctx.textAlign = "left";
    drawVolumeToggle(view);
  }

  function drawBoot(view: RenderView, horizon: number): void {
    const t = view.bootT;
    const cx = width / 2;

    // Earth falls away below as the ship climbs out.
    const earthSize = Math.max(10, 150 - t * 170);
    const earthY = height - 30 + t * 190;

    if (earthSize > 10 && earthY - earthSize / 2 < height) {
      drawEarthAt(cx, earthY, earthSize);
    }

    // The ship climbs into frame with a long burn.
    const shipY = height - 20 - t * 26;
    const shake = reducedMotion || t > 0.7 ? 0 : Math.round(Math.random() * 2 - 1);
    const sprite = shipInfo();
    const bottom = sprite.height;

    ctx.save();
    ctx.translate(Math.round(cx + shake), Math.round(shipY));

    for (const anchor of sprite.flameAnchors) {
      const fx = Math.round((anchor - sprite.width / 2) * 2);
      const length = 10 + (reducedMotion ? 0 : Math.random() * 5);

      ctx.fillStyle = palette.goldBright;
      ctx.fillRect(fx - 1, bottom - 2, 2, Math.round(length));
      ctx.fillStyle = palette.red;
      ctx.fillRect(fx - 1, bottom - 2 + Math.round(length), 2, 3);
    }

    ctx.drawImage(sprite.img, -sprite.width, -sprite.height, sprite.width * 2, sprite.height * 2);
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
      if (star === undefined) {
        continue;
      }
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

  // Scanlines, vignette, grain — the cost of light-years. Full intensity
  // belongs on the world; the light pass over the HUD keeps the screen
  // feeling like one tube without making the instruments hard to read.
  function drawFilmTexture(nowS: number, intensity: number): void {
    ctx.globalAlpha = 0.07 * intensity;
    ctx.fillStyle = "#000000";

    for (let y = 0; y < height; y += 2) {
      ctx.fillRect(0, y, width, 1);
    }

    ctx.globalAlpha = 1;

    if (intensity < 1) {
      return;
    }

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

  /** Esc parks the run: dim the cosmos, hold everything, point the way back. */
  function drawPause(view: RenderView): void {
    ctx.globalAlpha = 0.72;
    ctx.fillStyle = palette.deepField;
    ctx.fillRect(0, 0, width, height);
    ctx.globalAlpha = 1;

    const baseY = Math.round(height * 0.42);

    ctx.textAlign = "center";
    ctx.fillStyle = palette.cream;
    ctx.font = "800 14px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText("Paused", width / 2, baseY);

    ctx.fillStyle = palette.creamMuted;
    ctx.font = "9px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText("The galaxy will wait.", width / 2, baseY + 18);

    let hintY = baseY + 36;

    // Keyboard players get the chart reminder; touch has no atlas key.
    if (!view.touch) {
      ctx.fillStyle = palette.creamDim;
      ctx.font = "8px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText("The atlas is on C.", width / 2, baseY + 32);
      hintY = baseY + 48;
    }

    const blink = reducedMotion ? 1 : 0.5 + 0.5 * Math.sin(view.nowS * 3);

    ctx.globalAlpha = blink;
    ctx.fillStyle = palette.goldBright;
    ctx.font = '8px "Oxanium", monospace';
    ctx.fillText(view.touch ? "Tap to fly on" : "Esc to fly on", width / 2, hintY);
    ctx.globalAlpha = 1;
    ctx.textAlign = "left";
  }

  // The atlas (C): the top-down map of the voyage — the in-game chart and the
  // demo surface in one. The spiral is drawn from placement.ts's own
  // spiralPoint — the exact function that placed the stars — so the thread and
  // its marks share one source of truth and cannot drift apart. Warm Dark
  // canon: the thread is a dim warm line (never neon), logged findings are
  // small filled cream marks, uncharted ones dim hollow gold rings, Earth
  // keeps the radar's blue idiom, and the ship is a cream chevron. The view is
  // a static zoom-to-fit (no pan/zoom easing to gate); the only motion is the
  // close-hint blink, stilled under reduced-motion.
  function drawAtlas(view: RenderView): void {
    const { sim } = view;
    const stars = sim.stars;

    // The chart is its own plate: an opaque Deep Field ground so the bright
    // cockpit (ship sprite, HUD) never ghosts through the map. The film pass
    // that follows keeps it on the same tube as everything else.
    ctx.fillStyle = palette.deepField;
    ctx.fillRect(0, 0, width, height);

    const threadEnd = atlasThreadEnd(stars);
    const scale = atlasScale(atlasWorldRadius(stars, sim.ship), width, height, ATLAS_MARGIN);
    const cx = width / 2;
    const cy = height / 2;
    const toX = (worldX: number): number => cx + worldX * scale;
    const toY = (worldY: number): number => cy + worldY * scale;

    // The voyage thread: one faint warm line from the clear-space edge to just
    // past the frontier tip.
    ctx.strokeStyle = palette.creamDim;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    ctx.beginPath();

    const start = spiralPoint(0);

    ctx.moveTo(toX(start.x), toY(start.y));

    for (let theta = THREAD_STEP; theta < threadEnd; theta += THREAD_STEP) {
      const point = spiralPoint(theta);

      ctx.lineTo(toX(point.x), toY(point.y));
    }

    const end = spiralPoint(threadEnd);

    ctx.lineTo(toX(end.x), toY(end.y));
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Earth at the center — the radar's own idiom, a notch larger.
    const earthX = Math.round(toX(0));
    const earthY = Math.round(toY(0));

    ctx.fillStyle = palette.coolBlue;
    ctx.fillRect(earthX - 2, earthY - 2, 5, 5);
    ctx.fillStyle = palette.creamBright;
    ctx.fillRect(earthX, earthY, 1, 1);

    // The frontier tip, subtly marked: a dim gold diamond around the newest finding.
    const tip = stars[frontierTipIndex(stars)];

    if (tip !== undefined) {
      ctx.save();
      ctx.translate(Math.round(toX(tip.x)), Math.round(toY(tip.y)));
      ctx.rotate(Math.PI / 4);
      ctx.strokeStyle = palette.goldDim;
      ctx.globalAlpha = 0.8;
      ctx.strokeRect(-3.5, -3.5, 7, 7);
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    // Every finding at its true position: logged burns cream, the lifetime log
    // fills quieter (map knowledge carries across deaths), uncharted stays a
    // dim hollow ring.
    for (const star of stars) {
      const starX = Math.round(toX(star.x));
      const starY = Math.round(toY(star.y));
      const state = atlasMarkState(star);

      if (state === "uncharted") {
        ctx.strokeStyle = palette.goldDim;
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.arc(starX, starY, 1.8, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
        continue;
      }

      pixelDiamond(starX, starY, 1, state === "logged" ? palette.creamBright : palette.creamMuted);
    }

    // The ship: a small cream chevron at its position, nose along its heading.
    ctx.save();
    ctx.translate(Math.round(toX(sim.ship.x)), Math.round(toY(sim.ship.y)));
    ctx.rotate(sim.ship.heading);
    ctx.fillStyle = palette.cream;
    ctx.beginPath();
    ctx.moveTo(4, 0);
    ctx.lineTo(-3, -3);
    ctx.lineTo(-1.5, 0);
    ctx.lineTo(-3, 3);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    drawAtlasLabel(view, toX, toY, scale);

    // The frame text: title, the growth caption, the way back.
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = palette.cream;
    ctx.font = '800 12px "Oxanium", monospace';
    ctx.fillText("THE ATLAS", cx, 5);

    ctx.textAlign = "left";
    ctx.font = '7px "Oxanium", monospace';
    ctx.fillStyle = palette.creamMuted;
    ctx.fillText(atlasCaption(stars), 8, height - 12);

    const blink = reducedMotion ? 1 : 0.5 + 0.5 * Math.sin(view.nowS * 3);

    ctx.globalAlpha = blink;
    ctx.textAlign = "right";
    ctx.fillStyle = palette.goldBright;
    ctx.font = '7px "Oxanium", monospace';
    ctx.fillText("C to fly on", width - 8, height - 12);
    ctx.globalAlpha = 1;
    ctx.textAlign = "left";
  }

  // The chart's readout: the star under the pointer (when one is over the map)
  // or the star nearest the ship — its coordinate in the log-card idiom plus
  // the Artist — Title line, on a small tape-black chip clamped on-screen.
  function drawAtlasLabel(
    view: RenderView,
    toX: (worldX: number) => number,
    toY: (worldY: number) => number,
    scale: number,
  ): void {
    const { sim } = view;
    const stars = sim.stars;

    if (stars.length === 0) {
      return;
    }

    const atlas = view.atlas;
    const pointer = atlas?.pointer;
    let index = -1;

    if (pointer) {
      const worldX = (pointer.x - width / 2) / scale;
      const worldY = (pointer.y - height / 2) / scale;

      index = nearestStarIndex(stars, worldX, worldY, 14 / scale);

      if (index >= 0 && atlas) {
        atlas.lastHoverIndex = index;
      } else if (atlas?.lastHoverIndex !== undefined) {
        // The pointer is between marks — hold the last hover instead of flashing
        // the ship fallback.
        index = atlas.lastHoverIndex;
      }
    }

    if (index < 0) {
      // No pointer at all (keyboard-only): the star nearest the ship.
      index = nearestStarIndex(stars, sim.ship.x, sim.ship.y);
    }

    const star = stars[index];

    if (star === undefined) {
      return;
    }

    const markX = Math.round(toX(star.x));
    const markY = Math.round(toY(star.y));

    // A cream ring singles the labelled star out.
    ctx.strokeStyle = palette.cream;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(markX, markY, 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const coordinate = `fluncle://${star.logId}`;
    const detail = `${star.artistLine} — ${star.title}`;

    ctx.font = '9px "Oxanium", monospace';

    const coordinateWidth = ctx.measureText(coordinate).width;

    ctx.font = "8px ui-sans-serif, system-ui, sans-serif";

    const detailWidth = Math.min(ctx.measureText(detail).width, 170);
    const chipWidth = Math.round(Math.max(coordinateWidth, detailWidth)) + 12;
    const chipHeight = 26;
    const chipX = Math.max(4, Math.min(width - 4 - chipWidth, markX + 8));
    const chipY = Math.max(
      18,
      Math.min(height - 18 - chipHeight, markY - Math.round(chipHeight / 2)),
    );

    ctx.globalAlpha = 0.92;
    ctx.fillStyle = palette.dustLine;
    ctx.fillRect(chipX - 1, chipY - 1, chipWidth + 2, chipHeight + 2);
    ctx.fillStyle = palette.tapeBlack;
    ctx.fillRect(chipX, chipY, chipWidth, chipHeight);
    ctx.globalAlpha = 1;

    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = palette.gold;
    ctx.font = '9px "Oxanium", monospace';
    ctx.fillText(coordinate, chipX + 6, chipY + 4);
    ctx.fillStyle = palette.cream;
    ctx.font = "8px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(clip(detail, chipWidth - 12), chipX + 6, chipY + 15);
  }

  resize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);

  return {
    canvas,
    destroy: () => {
      canvas.remove();
    },
    draw,
    resize,
    spotifyLinkRect: () => spotifyRect,
    volumeRect: () => volumeRect,
  };
}

export const BOOT_DURATION = BOOT_SECONDS;
export const TOWED_DURATION = TOWED_SECONDS;
