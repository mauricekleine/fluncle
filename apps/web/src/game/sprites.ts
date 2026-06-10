import { palette } from "./palette";
import { fnv1a } from "./placement";

// Placeholder pixel art, hand-mapped in canon colors. The hero sprites (ship,
// Earth) get a proper image-gen pass later (docs/galaxy-game.md, "Look &
// sound"); everything here draws once to an offscreen canvas at boot.

const INK: Record<string, string> = {
  D: palette.creamDim,
  G: palette.goldBright,
  R: palette.redDim,
  c: palette.cream,
  d: palette.creamMuted,
  g: palette.gold,
  k: palette.tapeBlack,
  o: palette.sleeveBlack,
  r: palette.red,
};

// The ship, seen from behind: cream hull, gold canopy, red wingtips, twin
// engine pods. 15x15 so the fuselage owns a true center column.
const SHIP_MAP = [
  ".......o.......",
  "......oGo......",
  "......ogo......",
  ".....ocgco.....",
  ".....ocgco.....",
  "....occgcco....",
  "....ocGGGco....",
  "...occgggcco...",
  "...ocddcddco...",
  "..occdcccdcco..",
  ".orccdcccdccro.",
  "orrcdDcccDdcrro",
  ".oocdDcccDdcoo.",
  "...okkDoDkko...",
  "...oko...oko...",
];

/** Engine nozzle x-positions in sprite pixels; flames render below these. */
export const SHIP_FLAME_ANCHORS = [5, 10];
export const SHIP_SIZE = 15;

export function makeShipSprite(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");

  canvas.width = SHIP_SIZE;
  canvas.height = SHIP_MAP.length;

  const ctx = canvas.getContext("2d");

  if (!ctx) {
    return canvas;
  }

  for (let y = 0; y < SHIP_MAP.length; y++) {
    for (let x = 0; x < SHIP_SIZE; x++) {
      const ink = INK[SHIP_MAP[y][x]];

      if (ink) {
        ctx.fillStyle = ink;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  return canvas;
}

// Earth, procedurally pixeled: the one place the Retint Rule's cool blue gets
// to be a surface. Blocky value-noise continents, a warm lit rim toward the
// sun, the night side falling into the deep field.
export function makeEarthSprite(diameter: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");

  canvas.width = diameter;
  canvas.height = diameter;

  const ctx = canvas.getContext("2d");

  if (!ctx) {
    return canvas;
  }

  const radius = diameter / 2;
  const cell = Math.max(2, Math.round(diameter / 14));

  for (let y = 0; y < diameter; y++) {
    for (let x = 0; x < diameter; x++) {
      const dx = x + 0.5 - radius;
      const dy = y + 0.5 - radius;
      const distance = Math.hypot(dx, dy);

      if (distance > radius) {
        continue;
      }

      const land = fnv1a(`earth:${Math.floor(x / cell)},${Math.floor(y / cell)}`) % 100 < 38;
      let ink: string = land ? palette.coolTeal : palette.coolBlue;

      // Lit limb toward the top-right (the sun is out there); night side
      // falling away bottom-left.
      const lit = (dx - dy) / radius;

      if (distance > radius - 1.6 && lit > 0.2) {
        ink = palette.creamBright;
      } else if (lit > 0.55 && !land) {
        ink = palette.creamMuted;
      } else if (lit < -0.5) {
        ink = land ? palette.sleeveBlack : palette.tapeBlack;
      }

      ctx.fillStyle = ink;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  return canvas;
}
