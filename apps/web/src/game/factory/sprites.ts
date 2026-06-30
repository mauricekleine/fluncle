import { factoryPalette as P } from "./palette";

// The factory's machines — built programmatically, not hand-gridded, so all eight
// share ONE steel cabinet with the same upper-left key light and dark outline and
// read as one family (the sprite-system rails, restated for the works). Each
// machine is the shared cabinet plus a distinct "face" primitive that says what it
// does at a squint. Gold is NOT baked in — a station only glows while it is
// actively working a finding (game.ts draws that light), so the One Sun budget
// stays sparse and meaningful. The launch gantry is the one exception: its beacon
// is the sun on the horizon, the way up.
//
// PNG-or-procedural contract: a curated /factory/<id>.png
// overrides any of these on load, so the Gemini pass can polish a machine later
// with zero code change. The look is the upscaling, not the detail.

function makeCanvas(
  w: number,
  h: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | undefined {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return undefined;
  }
  ctx.imageSmoothingEnabled = false;
  return { canvas, ctx };
}

function rect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

// A warm-steel cabinet: dark outline, body fill, a lit top + left edge (the one
// upper-left key light) and a shadowed bottom + right edge. The body of every
// machine, so the floor reads as one workshop under one light.
function cabinet(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  rect(ctx, x, y, w, h, P.sleeveBlack); // outline pass (1px all round)
  rect(ctx, x + 1, y + 1, w - 2, h - 2, P.steel);
  rect(ctx, x + 1, y + 1, w - 2, 1, P.steelLit); // lit top
  rect(ctx, x + 1, y + 1, 1, h - 2, P.steelLit); // lit left
  rect(ctx, x + 1, y + h - 2, w - 2, 1, P.steelDim); // shadow bottom
  rect(ctx, x + w - 2, y + 1, 1, h - 2, P.steelDim); // shadow right
}

// Two short legs so a machine stands over the belt rather than floating.
function legs(ctx: CanvasRenderingContext2D, x: number, w: number, baseY: number): void {
  rect(ctx, x + 3, baseY, 3, 3, P.steelDim);
  rect(ctx, x + w - 6, baseY, 3, 3, P.steelDim);
}

// A recessed instrument screen with a faint teal phosphor ghost (a sparing
// counter-accent, never a field — the Retint Rule). `bars` draws a spectrum.
function screen(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  bars: boolean,
): void {
  rect(ctx, x, y, w, h, P.sleeveBlack);
  rect(ctx, x + 1, y + 1, w - 2, h - 2, P.tapeBlack);
  if (bars) {
    const heights = [2, 4, 3, 5, 2, 4, 3];
    for (let i = 0; i < Math.min(heights.length, Math.floor((w - 2) / 2)); i++) {
      const bh = heights[i] ?? 2;
      rect(ctx, x + 1 + i * 2, y + h - 1 - bh, 1, bh, P.coolTeal);
    }
  } else {
    // cream static — the render preview
    for (let i = 0; i < w * h * 0.18; i++) {
      const sx = x + 1 + ((i * 7) % (w - 2));
      const sy = y + 1 + ((i * 13) % (h - 2));
      rect(ctx, sx, sy, 1, 1, i % 3 === 0 ? P.creamMuted : P.creamDim);
    }
  }
}

type Machine = { canvas: HTMLCanvasElement; w: number; h: number };

// ── intake hopper ── a wide funnel narrowing to a chute over a short body.
function makeIntake(): Machine | undefined {
  const w = 30;
  const h = 30;
  const made = makeCanvas(w, h);
  if (!made) {
    return undefined;
  }
  const { canvas, ctx } = made;
  cabinet(ctx, 4, 18, w - 8, 9); // body
  legs(ctx, 4, w - 8, 27);
  // funnel: trapezoid, wide rim → narrow throat
  for (let row = 0; row < 14; row++) {
    const inset = Math.floor(row * 0.9);
    const fx = 2 + inset;
    const fw = w - 4 - inset * 2;
    rect(ctx, fx, row + 2, fw, 1, row === 0 ? P.creamMuted : row % 2 === 0 ? P.steel : P.steelDim);
    rect(ctx, fx, row + 2, 1, 1, P.steelLit);
    rect(ctx, fx + fw - 1, row + 2, 1, 1, P.sleeveBlack);
  }
  return { canvas, h, w };
}

// ── spectrograph ── a screen of spectrum bars under a stub antenna.
function makeSpectrograph(): Machine | undefined {
  const w = 30;
  const h = 30;
  const made = makeCanvas(w, h);
  if (!made) {
    return undefined;
  }
  const { canvas, ctx } = made;
  cabinet(ctx, 3, 8, w - 6, 19);
  legs(ctx, 3, w - 6, 27);
  screen(ctx, 7, 12, w - 14, 11, true);
  rect(ctx, w / 2 - 1, 3, 2, 6, P.steelDim); // antenna mast
  rect(ctx, w / 2 - 2, 2, 4, 2, P.creamMuted); // antenna head
  return { canvas, h, w };
}

// ── press ── a heavy anvil block with a piston arm above it.
function makePress(): Machine | undefined {
  const w = 28;
  const h = 30;
  const made = makeCanvas(w, h);
  if (!made) {
    return undefined;
  }
  const { canvas, ctx } = made;
  cabinet(ctx, 3, 16, w - 6, 11); // anvil base
  legs(ctx, 3, w - 6, 27);
  // frame uprights + a piston head poised to stamp
  rect(ctx, 4, 3, 2, 14, P.steelDim);
  rect(ctx, w - 6, 3, 2, 14, P.steelDim);
  rect(ctx, 4, 3, w - 8, 2, P.steelLit); // top beam
  rect(ctx, w / 2 - 5, 6, 10, 6, P.steel); // piston head
  rect(ctx, w / 2 - 5, 6, 10, 1, P.steelLit);
  rect(ctx, w / 2 - 5, 11, 10, 1, P.sleeveBlack);
  rect(ctx, w / 2 - 1, 12, 2, 4, P.creamMuted); // ram
  return { canvas, h, w };
}

// ── recording booth ── a cabinet with a round mic and a small window.
function makeBooth(): Machine | undefined {
  const w = 28;
  const h = 30;
  const made = makeCanvas(w, h);
  if (!made) {
    return undefined;
  }
  const { canvas, ctx } = made;
  cabinet(ctx, 4, 6, w - 8, 21);
  legs(ctx, 4, w - 8, 27);
  // a soft window
  screen(ctx, 7, 9, 7, 7, false);
  // the mic: a head on a thin stem
  const mx = w - 11;
  rect(ctx, mx, 17, 2, 5, P.steelDim); // stem
  rect(ctx, mx - 2, 10, 6, 7, P.creamMuted); // head
  rect(ctx, mx - 1, 11, 4, 5, P.creamDim); // grille shade
  rect(ctx, mx - 2, 10, 6, 1, P.creamBright);
  return { canvas, h, w };
}

// ── render bay ── the biggest, slowest machine: a vented rack with a preview
// screen and a faint heat glow. The pile builds in front of THIS one.
function makeRender(): Machine | undefined {
  const w = 40;
  const h = 34;
  const made = makeCanvas(w, h);
  if (!made) {
    return undefined;
  }
  const { canvas, ctx } = made;
  cabinet(ctx, 3, 4, w - 6, 27);
  legs(ctx, 3, w - 6, 31);
  screen(ctx, 6, 8, 16, 12, false); // a frame of footage rendering
  // cooling vents (horizontal slats) on the right
  for (let i = 0; i < 5; i++) {
    rect(ctx, 25, 9 + i * 3, 11, 1, P.sleeveBlack);
    rect(ctx, 25, 10 + i * 3, 11, 1, P.steelDim);
  }
  rect(ctx, 26, 24, 9, 2, P.redDeep); // a low heat glow (sparing red)
  rect(ctx, 6, 23, 16, 1, P.steelLit);
  return { canvas, h, w };
}

// ── dispatch dock ── a hatch with a small dish and a down-chute.
function makeDispatch(): Machine | undefined {
  const w = 32;
  const h = 30;
  const made = makeCanvas(w, h);
  if (!made) {
    return undefined;
  }
  const { canvas, ctx } = made;
  cabinet(ctx, 3, 10, w - 6, 17);
  legs(ctx, 3, w - 6, 27);
  // a small satellite dish on a mast
  rect(ctx, 8, 5, 2, 6, P.steelDim);
  rect(ctx, 5, 3, 8, 4, P.creamMuted);
  rect(ctx, 6, 4, 6, 2, P.steelDim);
  // a hatch with an outbound arrow
  screen(ctx, w - 16, 14, 11, 9, false);
  rect(ctx, w - 12, 18, 5, 1, P.creamMuted);
  rect(ctx, w - 9, 16, 1, 5, P.creamMuted);
  rect(ctx, w - 8, 17, 1, 3, P.creamMuted);
  return { canvas, h, w };
}

// ── address printer ── a box spitting a label/tape strip from a slot.
function makeAddress(): Machine | undefined {
  const w = 30;
  const h = 28;
  const made = makeCanvas(w, h);
  if (!made) {
    return undefined;
  }
  const { canvas, ctx } = made;
  cabinet(ctx, 4, 6, w - 8, 19);
  legs(ctx, 4, w - 8, 25);
  rect(ctx, 8, 10, w - 16, 2, P.steelDim); // top seam
  rect(ctx, 7, 19, w - 14, 2, P.sleeveBlack); // the slot
  // a printed strip curling out, with tiny marks (a coordinate)
  rect(ctx, 9, 21, 12, 5, P.creamMuted);
  rect(ctx, 9, 21, 12, 1, P.creamBright);
  for (let i = 0; i < 4; i++) {
    rect(ctx, 11 + i * 3, 23, 1, 1, P.creamDim);
  }
  return { canvas, h, w };
}

// ── launch gantry ── a tall tower with cross-braces and a gold beacon at the top
// (the one sanctioned gold: the sun on the horizon, the way up).
function makeLaunch(): Machine | undefined {
  const w = 28;
  const h = 44;
  const made = makeCanvas(w, h);
  if (!made) {
    return undefined;
  }
  const { canvas, ctx } = made;
  // two legs splaying out to a base
  rect(ctx, 5, 4, 2, 36, P.steelDim);
  rect(ctx, w - 7, 4, 2, 36, P.steelDim);
  rect(ctx, 5, 4, 2, 1, P.steelLit);
  rect(ctx, w - 7, 4, 2, 1, P.steelLit);
  // cross-braces
  for (let i = 0; i < 6; i++) {
    const y = 8 + i * 6;
    rect(ctx, 7, y, w - 14, 1, P.steelDim);
    rect(ctx, 7, y + 1, w - 14, 1, P.sleeveBlack);
  }
  // base pad
  rect(ctx, 2, 40, w - 4, 3, P.steel);
  rect(ctx, 2, 40, w - 4, 1, P.steelLit);
  rect(ctx, 2, 42, w - 4, 1, P.sleeveBlack);
  // the beacon
  rect(ctx, w / 2 - 1, 1, 2, 3, P.gold);
  rect(ctx, w / 2 - 1, 0, 2, 1, P.goldBright);
  return { canvas, h, w };
}

const BUILDERS: Record<string, () => Machine | undefined> = {
  address: makeAddress,
  booth: makeBooth,
  dispatch: makeDispatch,
  intake: makeIntake,
  launch: makeLaunch,
  press: makePress,
  render: makeRender,
  spectrograph: makeSpectrograph,
};

export type MachineSprite = { canvas: HTMLCanvasElement; h: number; w: number };

/** Build every machine sprite once at boot, keyed by the station's sprite id. */
export function buildMachineSprites(): Record<string, MachineSprite> {
  const out: Record<string, MachineSprite> = {};
  for (const [id, build] of Object.entries(BUILDERS)) {
    const machine = build();
    if (machine) {
      out[id] = machine;
    }
  }
  return out;
}

// ── the launch ship ── a tiny capsule a finished finding rides up to the Galaxy.
export function makeShip(): MachineSprite | undefined {
  const w = 12;
  const h = 16;
  const made = makeCanvas(w, h);
  if (!made) {
    return undefined;
  }
  const { canvas, ctx } = made;
  // nose
  rect(ctx, 4, 0, 4, 2, P.creamMuted);
  rect(ctx, 3, 2, 6, 2, P.cream);
  // body
  rect(ctx, 2, 4, 8, 8, P.steel);
  rect(ctx, 2, 4, 1, 8, P.steelLit);
  rect(ctx, 9, 4, 1, 8, P.steelDim);
  rect(ctx, 3, 6, 6, 3, P.tapeBlack); // a window
  rect(ctx, 4, 7, 4, 1, P.coolTeal);
  // fins
  rect(ctx, 0, 10, 2, 3, P.steelDim);
  rect(ctx, 10, 10, 2, 3, P.steelDim);
  // base
  rect(ctx, 3, 12, 6, 1, P.sleeveBlack);
  return { canvas, h, w };
}
