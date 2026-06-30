import { earthPalette } from "./palette";

// Core overworld pixel-art helpers — canon-ramp only. This module owns the
// shared INK table + `makeSprite`, the player sprites, and the procedural
// ground/void tiles. Per-region PROP sprites (the CRT, the boombox, the onion,
// …) are pure char-grid data inside region modules (regions/*.ts) and get built
// through `makeSprite` by the registry — so a new prop is data, never a code
// change here.
//
// PNG-or-procedural contract: the renderer tries a
// curated PNG (`/earth/<prop>.png`) first and falls back to the procedural
// sprite until it loads (or if it 404s) — so the Gemini pipeline can polish any
// prop later with zero code change. The look is the upscaling, not the detail.

// The shared palette letters region char grids may use. Canon-clean: the CRT
// "phosphor" (p/P) is the dim canon coolTeal + a warm-dark scanline, never a
// green field (Retint Rule).
export const INK: Record<string, string> = {
  C: earthPalette.creamBright,
  D: earthPalette.creamDim,
  E: earthPalette.redDeep,
  P: earthPalette.tapeBlack, // CRT-screen scanline dark
  R: earthPalette.redBright,
  Y: earthPalette.goldBright,
  b: earthPalette.coolBlue,
  c: earthPalette.cream,
  d: earthPalette.creamMuted,
  e: earthPalette.redDim,
  k: earthPalette.tapeBlack,
  m: earthPalette.goldDim,
  n: earthPalette.goldDeep,
  o: earthPalette.sleeveBlack,
  p: earthPalette.coolTeal, // dim teal CRT ghost (a sparing accent, never a field)
  r: earthPalette.red,
  t: earthPalette.coolTeal,
  y: earthPalette.gold,
};

// Paint a char-grid sprite onto a fresh canvas; '.' / ' ' is transparent, every
// other char maps through INK. Width is the first row's length (rows share it).
export function makeSprite(map: string[]): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const w = map[0]?.length ?? 1;

  canvas.width = w;
  canvas.height = map.length;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return canvas;
  }

  for (let y = 0; y < map.length; y++) {
    const row = map[y];
    if (row === undefined) {
      continue;
    }

    for (let x = 0; x < w; x++) {
      const cell = row[x];
      const ink = cell === undefined ? undefined : INK[cell];

      if (ink) {
        ctx.fillStyle = ink;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  return canvas;
}

// Mirror a sprite horizontally (right-facing from a left-facing map).
export function flipSprite(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return canvas;
  }

  ctx.translate(source.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(source, 0, 0);

  return canvas;
}

// ── The traveller (the player) ────────────────────────────────────────────
// A small explorer: gold cap, cream face, a Re-entry-Red scarf, cream jacket
// with gold trim, dim legs and dark boots. 14×16; feet anchor near the bottom.

const PLAYER_DOWN = [
  "....oooooo....",
  "...oYYyyYYo...",
  "..oyyyyyyyyo..",
  "..oyyyyyyyyo..",
  "..occcccccco..",
  "..occkcckcco..",
  "..occcccccco..",
  "..orrrrrrrro..",
  "..oddddddddo..",
  ".oddmddddmddo.",
  ".odddmddmdddo.",
  "..oddddddddo..",
  "..oDDDooDDDo..",
  "..oDDDooDDDo..",
  "..okkk..kkko..",
  "...kkk..kkk...",
];

const PLAYER_UP = [
  "....oooooo....",
  "...oYYyyYYo...",
  "..oyyyyyyyyo..",
  "..oyyyyyyyyo..",
  "..oyyyyyyyyo..",
  "..oyyddddyyo..",
  "..occddddcco..",
  "..orrrrrrrro..",
  "..oddddddddo..",
  ".oddmddddmddo.",
  ".odddmddmdddo.",
  "..oddddddddo..",
  "..oDDDooDDDo..",
  "..oDDDooDDDo..",
  "..okkk..kkko..",
  "...kkk..kkk...",
];

// Facing left; the right-facing frame is this one mirrored.
const PLAYER_SIDE = [
  "...oooooo.....",
  "..oYYyyYYo....",
  ".oyyyyyyyyo...",
  ".oyyyyyyyyo...",
  ".occcccccco...",
  ".ockcccccco...",
  ".occcccccco...",
  ".orrrrrrrro...",
  ".oddddddddo...",
  ".oddmdddddo...",
  ".oddddddddo...",
  ".oddddddddo...",
  "..oDDDDDDo....",
  "..oDDDDDDo....",
  "..okkkkkko....",
  "...kkkkkk.....",
];

export const PLAYER_W = 14;
export const PLAYER_H = 16;

export type PlayerFacing = "down" | "left" | "right" | "up";

export function makePlayerSprites(): Record<PlayerFacing, HTMLCanvasElement> {
  const left = makeSprite(PLAYER_SIDE);
  return {
    down: makeSprite(PLAYER_DOWN),
    left,
    right: flipSprite(left),
    up: makeSprite(PLAYER_UP),
  };
}

// ── Tiles ─────────────────────────────────────────────────────────────────
export const TILE = 16;

function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2654435761) >>> 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Warm-dark soil with a sparse lit/dim speckle.
export function makeGroundTile(seed: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = TILE;
  canvas.height = TILE;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return canvas;
  }

  ctx.fillStyle = earthPalette.ground;
  ctx.fillRect(0, 0, TILE, TILE);

  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const n = hash(x, y, seed);
      if (n > 0.94) {
        ctx.fillStyle = earthPalette.groundLit;
        ctx.fillRect(x, y, 1, 1);
      } else if (n < 0.06) {
        ctx.fillStyle = earthPalette.groundDim;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  return canvas;
}

// Deep field with a rare gold star — the cosmos at the world's edge. Gold stays
// rare (One Sun Rule); cream is the dominant star.
export function makeVoidTile(seed: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = TILE;
  canvas.height = TILE;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return canvas;
  }

  ctx.fillStyle = earthPalette.deepField;
  ctx.fillRect(0, 0, TILE, TILE);

  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const n = hash(x, y, seed);
      if (n > 0.993) {
        ctx.fillStyle = earthPalette.goldBright;
        ctx.fillRect(x, y, 1, 1);
      } else if (n > 0.978) {
        ctx.fillStyle = earthPalette.creamMuted;
        ctx.fillRect(x, y, 1, 1);
      } else if (n > 0.955) {
        ctx.fillStyle = earthPalette.creamDim;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  return canvas;
}
