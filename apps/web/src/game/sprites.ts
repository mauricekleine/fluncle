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

// Earth's own shade ramp, derived from the two sanctioned cool counter-accents
// (the Retint Rule's one cold surface in the whole game).
const EARTH_SHADES = {
  landDark: "#26352f",
  landLit: "#55806d",
  landNight: "#141a17",
  seaDark: "#2e3854",
  seaLit: "#5d6c9e",
  seaNight: "#171b29",
} as const;

function noiseAt(seed: string, x: number, y: number, cell: number): number {
  return (fnv1a(`${seed}:${Math.floor(x / cell)},${Math.floor(y / cell)}`) % 1000) / 1000;
}

// Earth, procedurally pixeled: the one place the Retint Rule's cool blue gets
// to be a surface. Two-octave value-noise continents, a dithered terminator
// instead of a hard shadow line, polar caps, and a thin lit limb toward the
// sun out there.
export function makeEarthSprite(diameter: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");

  canvas.width = diameter;
  canvas.height = diameter;

  const ctx = canvas.getContext("2d");

  if (!ctx) {
    return canvas;
  }

  const radius = diameter / 2;
  const coarse = Math.max(3, Math.round(diameter / 10));
  const fine = Math.max(2, Math.round(diameter / 24));

  for (let y = 0; y < diameter; y++) {
    for (let x = 0; x < diameter; x++) {
      const dx = x + 0.5 - radius;
      const dy = y + 0.5 - radius;
      const distance = Math.hypot(dx, dy);

      if (distance > radius) {
        continue;
      }

      const elevation =
        0.62 * noiseAt("earth1", x, y, coarse) + 0.38 * noiseAt("earth2", x, y, fine);
      const land = elevation > 0.58;
      const polar = Math.abs(dy) / radius > 0.82 && distance < radius - 1;

      // Lit limb toward the top-right; the terminator dithers instead of
      // cutting (checkerboard pixels across the twilight band).
      const lit = (dx - dy) / (radius * 1.1);
      const dither = (x + y) % 2 === 0;

      let ink: string;

      if (polar) {
        ink = lit < -0.3 ? palette.creamDim : lit > 0.35 ? palette.creamBright : palette.cream;
      } else if (lit > 0.4) {
        ink = land ? EARTH_SHADES.landLit : EARTH_SHADES.seaLit;
      } else if (lit > 0.05) {
        ink = land ? palette.coolTeal : palette.coolBlue;
      } else if (lit > -0.22) {
        ink = dither
          ? land
            ? palette.coolTeal
            : palette.coolBlue
          : land
            ? EARTH_SHADES.landDark
            : EARTH_SHADES.seaDark;
      } else if (lit > -0.45) {
        ink = dither
          ? land
            ? EARTH_SHADES.landDark
            : EARTH_SHADES.seaDark
          : land
            ? EARTH_SHADES.landNight
            : EARTH_SHADES.seaNight;
      } else {
        ink = land ? EARTH_SHADES.landNight : EARTH_SHADES.seaNight;
      }

      if (distance > radius - 1.4 && lit > 0.25) {
        ink = palette.creamBright;
      }

      ctx.fillStyle = ink;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  return canvas;
}
