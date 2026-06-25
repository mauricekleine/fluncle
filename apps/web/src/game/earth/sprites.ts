import { earthPalette } from "./palette";

// Overworld pixel art, canon-ramp only (earthPalette). The player and the three
// device-landmarks are hand-mapped char grids; the ground/void tiles are drawn
// procedurally with a hashed speckle so they vary without a tile sheet.
//
// Every device sprite follows the galaxy game's load-or-fallback contract: the
// renderer tries a curated PNG (`/earth/<name>.png`) first and draws these
// procedural sprites until it loads (or if it 404s) — so the Gemini sprite
// pipeline (docs/galaxy-sprites.md) can polish any prop later with zero code
// change. The look is the upscaling (image-rendering: pixelated), not detail.

const INK: Record<string, string> = {
  C: earthPalette.creamBright,
  D: earthPalette.creamDim,
  E: earthPalette.redDeep,
  P: earthPalette.phosphorDim,
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
  p: earthPalette.phosphor,
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

// ── The CRT — the SSH terminal door ───────────────────────────────────────
// A chunky monitor on a stand; cream bezel, a green-phosphor screen with
// scanlines and a few cream "text" cells, a gold power LED. 16×17.

const CRT_MAP = [
  "oooooooooooooooo",
  "oddddddddddddddo",
  "odpPpPpPpPpPpPdo",
  "odPpPpccPpPpPpdo",
  "odpPpPpPpPpPpPdo",
  "odPppPpPccpPpPdo",
  "odpPpPpPpPpPpPdo",
  "odPpccPpPpPpPpdo",
  "odpPpPpPpPpPpPdo",
  "oddddddddddddydo",
  "oooooooooooooooo",
  ".....oddddo.....",
  ".....oddddo.....",
  "...oddddddddo...",
  "..oddddddddddo..",
  "..oooooooooooo..",
  "...kkkkkkkkkk...",
];

// ── The boombox — the Spotify door ────────────────────────────────────────
// A wide cassette boombox; two gold speaker cones, a cream cassette window with
// a red tape line, gold dials, a dark carry handle. 20×12.

const BOOMBOX_MAP = [
  ".....okkkkkko.......",
  ".....o......o.......",
  "oooooooooooooooooooo",
  "omyYymddccccddmyYymo",
  "omyYymddcrrcddmyYymo",
  "omyYymddccccddmyYymo",
  "odmyymddddddddmyymdo",
  "oddddddddddddddddddo",
  "oddyydddYYYYdddyyddo",
  "oddddddddddddddddddo",
  "oooooooooooooooooooo",
  ".kkkkkkkkkkkkkkkkkk.",
];

// ── The onion — the Tor onion-site door ───────────────────────────────────
// A papery warm bulb: thin teal shoots up top, cream skin with creamMuted
// vertical seams curving over a round body, a goldDim skin-sheen, tapering to a
// point with a few red-dim root hairs below. Warm-only (no cool glints — those
// read as eyes). 16×20.

const ONION_MAP = [
  "......t.t.......",
  ".......t........",
  "......ttt.......",
  "...occccccco....",
  "..occccccccco...",
  ".occcDcccDccco..",
  ".occDcccccDccco.",
  "occcDcccccDcccco",
  "occmDcccccDcccco",
  "occcDccccDccccco",
  ".occDcccccDccco.",
  ".occcDcccDcccco.",
  "..occDcccDccco..",
  "..occcDcDccco...",
  "...occDcDcco....",
  "....occDcco.....",
  ".....occco......",
  "......oeo.......",
  ".....e.e.e......",
  "......e.e.......",
];

export type DeviceKind = "boombox" | "crt" | "onion";

export type DeviceSprite = {
  canvas: HTMLCanvasElement;
  /** Curated PNG name under /earth/ that overrides the procedural fallback. */
  png: string;
};

export function makeDeviceSprites(): Record<DeviceKind, DeviceSprite> {
  return {
    boombox: { canvas: makeSprite(BOOMBOX_MAP), png: "boombox" },
    crt: { canvas: makeSprite(CRT_MAP), png: "crt" },
    onion: { canvas: makeSprite(ONION_MAP), png: "onion" },
  };
}

// ── Tiles ─────────────────────────────────────────────────────────────────
// Procedural, hashed so they vary without a sheet. TILE px is the logical tile.
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

// Deep field with a rare gold star — the cosmos at the frame's edge.
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
        // a rare gold star — gold stays special (One Sun Rule)
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
