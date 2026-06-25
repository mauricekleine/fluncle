import { type Camera, followCamera } from "./camera";
import { createGrain } from "./grain";
import { createInput } from "./input";
import { DOORS, type PlacedDoor, buildPropSprites } from "./registry";
import {
  makeGroundTile,
  makePlayerSprites,
  makeVoidTile,
  PLAYER_H,
  type PlayerFacing,
  PLAYER_W,
  TILE,
} from "./sprites";
import { isGround, SPAWN, WORLD_H, WORLD_PX_H, WORLD_PX_W, WORLD_W } from "./world";

// The overworld engine. A client-only Canvas walker: a fixed viewport onto a
// larger world, a follow-camera, free-walk with feet-box collision, y-sorted
// doors, the Light-Years grain pass over the whole frame, reduced-motion gating.
// Doors are auto-registered from regions/*; the prop sprites are auto-built (PNG
// overrides on load). A door's payload (a registry surface / a custom card / a
// route) is resolved by the React route via onEnterDoor — the engine only emits.

const VIEW_TILES_W = 15;
const VIEW_TILES_H = 13;
const VIEW_W = VIEW_TILES_W * TILE; // 240
const VIEW_H = VIEW_TILES_H * TILE; // 208
const SPEED = 58; // logical px/sec
const REACH = 28; // interaction radius from feet to a door anchor
const CAMERA_EASE = 0.16;

type Options = {
  onEnterDoor: (door: PlacedDoor) => void;
};

type Player = {
  facing: PlayerFacing;
  stride: number;
  x: number;
  y: number;
};

export function createEarth(
  container: HTMLElement,
  options: Options,
): { destroy: () => void; resume: () => void } {
  const canvas = document.createElement("canvas");
  canvas.width = VIEW_W;
  canvas.height = VIEW_H;
  canvas.style.imageRendering = "pixelated";
  canvas.style.display = "block";
  container.appendChild(canvas);

  const context = canvas.getContext("2d");
  if (!context) {
    return { destroy: () => canvas.remove(), resume: () => {} };
  }
  const ctx = context;
  ctx.imageSmoothingEnabled = false;

  // assets
  const ground = [makeGroundTile(1), makeGroundTile(2), makeGroundTile(3)];
  const voids = [makeVoidTile(11), makeVoidTile(12)];
  const players = makePlayerSprites();
  const props = buildPropSprites();
  const grain = createGrain(VIEW_W, VIEW_H);

  // PNG overrides for any prop (docs/galaxy-sprites.md contract).
  const pngs: Record<string, HTMLImageElement> = {};
  for (const propId of Object.keys(props)) {
    const img = new Image();
    img.onload = () => {
      pngs[propId] = img;
    };
    img.src = `/earth/${propId}.png`;
  }

  // door footprints are solid; a door's anchor tile blocks the player.
  const doorTiles = new Set<string>();
  for (const door of DOORS) {
    doorTiles.add(`${door.tx},${door.ty}`);
  }

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reducedMotion = reduced.matches;
  const onReduced = (event: MediaQueryListEvent) => {
    reducedMotion = event.matches;
  };
  reduced.addEventListener("change", onReduced);

  const input = createInput();
  const player: Player = { facing: "down", stride: 0, x: SPAWN.x, y: SPAWN.y };
  let camera: Camera = followCamera(
    player,
    player.x,
    player.y,
    VIEW_W,
    VIEW_H,
    WORLD_PX_W,
    WORLD_PX_H,
    1,
  );
  let nearest: PlacedDoor | undefined;
  let paused = false;
  let frame = 0;
  let raf = 0;
  let last = 0;

  function fit() {
    const rect = container.getBoundingClientRect();
    const scale = Math.max(1, Math.floor(Math.min(rect.width / VIEW_W, rect.height / VIEW_H)));
    canvas.style.width = `${VIEW_W * scale}px`;
    canvas.style.height = `${VIEW_H * scale}px`;
  }
  fit();
  const onResize = () => fit();
  window.addEventListener("resize", onResize);

  function solid(px: number, py: number): boolean {
    const tx = Math.floor(px / TILE);
    const ty = Math.floor(py / TILE);
    return !isGround(tx, ty) || doorTiles.has(`${tx},${ty}`);
  }

  function feetBlocked(fx: number, fy: number): boolean {
    const hw = 4;
    return (
      solid(fx - hw, fy) || solid(fx + hw, fy) || solid(fx - hw, fy - 5) || solid(fx + hw, fy - 5)
    );
  }

  function update(dt: number) {
    if (paused) {
      return;
    }

    const { dx, dy } = input.state();
    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy);
      const step = (SPEED * dt) / len;
      const nx = player.x + dx * step;
      const ny = player.y + dy * step;
      if (!feetBlocked(nx, player.y)) {
        player.x = nx;
      }
      if (!feetBlocked(player.x, ny)) {
        player.y = ny;
      }
      player.facing =
        Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : dy < 0 ? "up" : "down";
      player.stride += SPEED * dt;
    } else {
      player.stride = 0;
    }

    camera = followCamera(
      camera,
      player.x,
      player.y,
      VIEW_W,
      VIEW_H,
      WORLD_PX_W,
      WORLD_PX_H,
      CAMERA_EASE,
    );

    // nearest door within reach
    nearest = undefined;
    let best = REACH;
    for (const door of DOORS) {
      const ax = door.tx * TILE + TILE / 2;
      const ay = door.ty * TILE + TILE;
      const d = Math.hypot(player.x - ax, player.y - ay);
      if (d < best) {
        best = d;
        nearest = door;
      }
    }

    if (input.consumeAction() && nearest) {
      paused = true;
      options.onEnterDoor(nearest);
    }
  }

  function drawTiles(camX: number, camY: number) {
    const x0 = Math.floor(camX / TILE);
    const y0 = Math.floor(camY / TILE);
    const x1 = Math.ceil((camX + VIEW_W) / TILE);
    const y1 = Math.ceil((camY + VIEW_H) / TILE);
    for (let ty = y0; ty < y1; ty++) {
      for (let tx = x0; tx < x1; tx++) {
        if (tx < 0 || ty < 0 || tx >= WORLD_W || ty >= WORLD_H) {
          continue;
        }
        const seed = tx * 7 + ty * 13;
        const tile = isGround(tx, ty) ? ground[seed % ground.length] : voids[seed % voids.length];
        if (tile) {
          ctx.drawImage(tile, tx * TILE, ty * TILE);
        }
      }
    }
  }

  function drawPlayer() {
    const sprite = players[player.facing];
    const bob = !reducedMotion && Math.floor(player.stride / 7) % 2 !== 0 ? -1 : 0;
    ctx.drawImage(
      sprite,
      Math.round(player.x - PLAYER_W / 2),
      Math.round(player.y - PLAYER_H + bob),
    );
  }

  function drawProp(door: PlacedDoor) {
    const sprite = pngs[door.prop] ?? props[door.prop];
    if (!sprite) {
      return;
    }
    const ax = door.tx * TILE + TILE / 2;
    const ay = door.ty * TILE + TILE;
    ctx.drawImage(sprite, Math.round(ax - sprite.width / 2), Math.round(ay - sprite.height));
  }

  function drawPrompt(door: PlacedDoor) {
    const sprite = pngs[door.prop] ?? props[door.prop];
    if (!sprite) {
      return;
    }
    const cx = door.tx * TILE + TILE / 2;
    const top = door.ty * TILE + TILE - sprite.height;
    const bob = reducedMotion ? 0 : Math.sin(frame / 8) * 1.2;
    ctx.fillStyle = "#ffd057"; // goldBright — gold marks the doors (One Sun Rule)
    const y = top - 5 + bob;
    ctx.beginPath();
    ctx.moveTo(cx - 3, y);
    ctx.lineTo(cx + 3, y);
    ctx.lineTo(cx, y + 3);
    ctx.closePath();
    ctx.fill();
  }

  function render() {
    ctx.clearRect(0, 0, VIEW_W, VIEW_H);
    const camX = Math.round(camera.x);
    const camY = Math.round(camera.y);

    ctx.save();
    ctx.translate(-camX, -camY);
    drawTiles(camX, camY);

    const order: Array<{ draw: () => void; y: number }> = [
      { draw: drawPlayer, y: player.y },
      ...DOORS.map((door) => ({ draw: () => drawProp(door), y: door.ty * TILE + TILE })),
    ];
    order.sort((a, b) => a.y - b.y);
    for (const item of order) {
      item.draw();
    }
    if (nearest) {
      drawPrompt(nearest);
    }
    ctx.restore();

    // the Light-Years pass — over the whole frame, in screen space
    grain.draw(ctx, frame, reducedMotion);
  }

  function loop(now: number) {
    const dt = last === 0 ? 0 : Math.min(0.05, (now - last) / 1000);
    last = now;
    frame++;
    update(dt);
    render();
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  return {
    destroy() {
      cancelAnimationFrame(raf);
      input.destroy();
      reduced.removeEventListener("change", onReduced);
      window.removeEventListener("resize", onResize);
      canvas.remove();
    },
    resume() {
      paused = false;
      last = 0;
    },
  };
}
