import { earthPalette } from "./palette";

// The Light-Years pass — recovered-footage grain + CRT scanlines applied over
// the WHOLE frame every tick, never baked into a sprite (DESIGN.md's Light-Years
// Rule, restated for the game in docs/galaxy-sprites.md). Drawn at the internal
// (logical) resolution so it upscales chunky with everything else. A few
// precomputed noise frames cycle so the grain BOILS; reduced-motion freezes it
// to a single still frame (the texture stays; the crawl stops).

const NOISE_FRAMES = 4;

function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2654435761) >>> 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function makeNoiseFrame(w: number, h: number, seed: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return canvas;
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n = hash(x, y, seed);
      // sparse warm specks — cream highlights, soil-dark wells; never a wash
      if (n > 0.93) {
        ctx.fillStyle = earthPalette.creamMuted;
        ctx.fillRect(x, y, 1, 1);
      } else if (n < 0.07) {
        ctx.fillStyle = earthPalette.deepField;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  return canvas;
}

export type Grain = {
  draw: (ctx: CanvasRenderingContext2D, frame: number, reducedMotion: boolean) => void;
};

export function createGrain(viewW: number, viewH: number): Grain {
  const frames: HTMLCanvasElement[] = [];
  for (let i = 0; i < NOISE_FRAMES; i++) {
    frames.push(makeNoiseFrame(viewW, viewH, 101 + i * 37));
  }

  return {
    draw(ctx, frame, reducedMotion) {
      // grain — boiling, low weight; frozen to frame 0 under reduced-motion
      const which = reducedMotion ? 0 : frame % NOISE_FRAMES;
      const noise = frames[which];
      if (noise) {
        ctx.save();
        ctx.globalAlpha = 0.06;
        ctx.drawImage(noise, 0, 0);
        ctx.restore();
      }

      // scanlines — a dark line every 3rd row, faint
      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = earthPalette.deepField;
      for (let y = 0; y < viewH; y += 3) {
        ctx.fillRect(0, y, viewW, 1);
      }
      ctx.restore();
    },
  };
}
