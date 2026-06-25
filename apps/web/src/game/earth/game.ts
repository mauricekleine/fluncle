import { earthPalette } from "./palette";
import { DEVICES, type Device, isWalkable, MAP, MAP_H, MAP_W, SPAWN } from "./room";
import {
  type DeviceSprite,
  makeDeviceSprites,
  makeGroundTile,
  makePlayerSprites,
  makeVoidTile,
  PLAYER_H,
  type PlayerFacing,
  PLAYER_W,
  TILE,
} from "./sprites";
import { type Surface } from "./room";

const LOGICAL_W = MAP_W * TILE;
const LOGICAL_H = MAP_H * TILE;
const SPEED = 58; // logical px/sec
const REACH = 22; // interaction radius from feet to a device anchor

type Options = {
  onEnterSurface: (surface: Surface) => void;
};

type Player = {
  facing: PlayerFacing;
  /** Distance walked, for the step bob. */
  stride: number;
  x: number;
  y: number;
};

export function createEarth(
  container: HTMLElement,
  options: Options,
): { destroy: () => void; resume: () => void } {
  const canvas = document.createElement("canvas");
  canvas.width = LOGICAL_W;
  canvas.height = LOGICAL_H;
  canvas.style.imageRendering = "pixelated";
  canvas.style.display = "block";
  container.appendChild(canvas);

  const context = canvas.getContext("2d");

  if (!context) {
    return { destroy: () => canvas.remove(), resume: () => {} };
  }

  // A non-null const so the render closures below keep the narrowed type
  // (control-flow narrowing doesn't persist into nested function bodies).
  const ctx = context;
  ctx.imageSmoothingEnabled = false;

  // Tiles, drawn once.
  const ground = [makeGroundTile(1), makeGroundTile(2), makeGroundTile(3)];
  const voids = [makeVoidTile(11), makeVoidTile(12)];
  const players = makePlayerSprites();
  const devices = makeDeviceSprites();

  // Curated PNGs override the procedural device sprites when present
  // (docs/galaxy-sprites.md contract); until then the fallbacks draw.
  const pngs: Partial<Record<string, HTMLImageElement>> = {};
  for (const sprite of Object.values(devices) as DeviceSprite[]) {
    const img = new Image();
    img.onload = () => {
      pngs[sprite.png] = img;
    };
    img.src = `/earth/${sprite.png}.png`;
  }

  const player: Player = { facing: "down", stride: 0, x: SPAWN.x, y: SPAWN.y };
  const held = new Set<string>();
  let paused = false;
  let nearest: Device | undefined;
  let raf = 0;
  let last = 0;

  // ── input ────────────────────────────────────────────────────────────
  const MOVE_KEYS: Record<string, [number, number]> = {
    ArrowDown: [0, 1],
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    a: [-1, 0],
    d: [1, 0],
    s: [0, 1],
    w: [0, -1],
  };

  function onKeyDown(event: KeyboardEvent) {
    const key = event.key;

    if (key in MOVE_KEYS || key === "ArrowUp" || key === "ArrowDown") {
      event.preventDefault();
    }

    if (key === "Enter" || key === " " || key === "e" || key === "E") {
      event.preventDefault();

      if (!paused && nearest) {
        paused = true;
        options.onEnterSurface(nearest.surface);
      }

      return;
    }

    const lower = key.length === 1 ? key.toLowerCase() : key;
    held.add(lower);
  }

  function onKeyUp(event: KeyboardEvent) {
    const key = event.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;
    held.delete(lower);
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  // ── fit (crisp, integer-scaled, letterboxed by CSS) ───────────────────
  function fit() {
    const rect = container.getBoundingClientRect();
    const scale = Math.max(1, Math.min(rect.width / LOGICAL_W, rect.height / LOGICAL_H));
    canvas.style.width = `${LOGICAL_W * scale}px`;
    canvas.style.height = `${LOGICAL_H * scale}px`;
  }

  fit();
  const onResize = () => fit();
  window.addEventListener("resize", onResize);

  // ── collision (feet box vs tiles) ─────────────────────────────────────
  function solid(px: number, py: number): boolean {
    return !isWalkable(Math.floor(px / TILE), Math.floor(py / TILE));
  }

  function feetBlocked(fx: number, fy: number): boolean {
    const hw = 4;
    return (
      solid(fx - hw, fy) || solid(fx + hw, fy) || solid(fx - hw, fy - 5) || solid(fx + hw, fy - 5)
    );
  }

  // ── update ────────────────────────────────────────────────────────────
  function update(dt: number) {
    if (paused) {
      return;
    }

    let vx = 0;
    let vy = 0;
    for (const key of held) {
      const move = MOVE_KEYS[key];
      if (move) {
        vx += move[0];
        vy += move[1];
      }
    }

    if (vx !== 0 || vy !== 0) {
      const len = Math.hypot(vx, vy);
      const step = (SPEED * dt) / len;
      const nx = player.x + vx * step;
      const ny = player.y + vy * step;

      if (!feetBlocked(nx, player.y)) {
        player.x = nx;
      }
      if (!feetBlocked(player.x, ny)) {
        player.y = ny;
      }

      player.facing =
        Math.abs(vx) > Math.abs(vy) ? (vx < 0 ? "left" : "right") : vy < 0 ? "up" : "down";
      player.stride += SPEED * dt;
    } else {
      player.stride = 0;
    }

    // nearest device within reach (the one the prompt offers)
    nearest = undefined;
    let best = REACH;
    for (const device of DEVICES) {
      const ax = device.tx * TILE + TILE / 2;
      const ay = device.ty * TILE + TILE;
      const d = Math.hypot(player.x - ax, player.y - ay);
      if (d < best) {
        best = d;
        nearest = device;
      }
    }
  }

  // ── render ──────────────────────────────────────────────────────────────
  function drawTiles() {
    for (let ty = 0; ty < MAP_H; ty++) {
      for (let tx = 0; tx < MAP_W; tx++) {
        const cell = MAP[ty]?.[tx] ?? "~";
        const seed = tx * 7 + ty * 13;
        const tile = cell === "." ? ground[seed % ground.length] : voids[seed % voids.length];
        if (tile) {
          ctx.drawImage(tile, tx * TILE, ty * TILE);
        }
      }
    }
  }

  function drawPlayer() {
    const sprite = players[player.facing];
    const bob = Math.floor(player.stride / 7) % 2 === 0 ? 0 : -1;
    ctx.drawImage(
      sprite,
      Math.round(player.x - PLAYER_W / 2),
      Math.round(player.y - PLAYER_H + bob),
    );
  }

  function drawDevice(device: Device) {
    const sprite = devices[device.kind];
    const img = pngs[sprite.png] ?? sprite.canvas;
    const ax = device.tx * TILE + TILE / 2;
    const ay = device.ty * TILE + TILE;
    ctx.drawImage(img, Math.round(ax - img.width / 2), Math.round(ay - img.height));
  }

  function drawPrompt(device: Device) {
    const sprite = devices[device.kind];
    const img = pngs[sprite.png] ?? sprite.canvas;
    const cx = device.tx * TILE + TILE / 2;
    const top = device.ty * TILE + TILE - img.height;

    // a small gold caret bobbing over the active door
    const bob = Math.sin(performance.now() / 200) * 1.2;
    ctx.fillStyle = earthPalette.goldBright;
    const y = top - 5 + bob;
    ctx.beginPath();
    ctx.moveTo(cx - 3, y);
    ctx.lineTo(cx + 3, y);
    ctx.lineTo(cx, y + 3);
    ctx.closePath();
    ctx.fill();
  }

  function render() {
    ctx.clearRect(0, 0, LOGICAL_W, LOGICAL_H);
    drawTiles();

    // y-sort the player against the devices so they pass behind the upper body
    const order: Array<{ y: number; draw: () => void }> = [
      { draw: drawPlayer, y: player.y },
      ...DEVICES.map((device) => ({ draw: () => drawDevice(device), y: device.ty * TILE + TILE })),
    ];
    order.sort((a, b) => a.y - b.y);
    for (const item of order) {
      item.draw();
    }

    if (nearest) {
      drawPrompt(nearest);
    }
  }

  // ── loop ────────────────────────────────────────────────────────────────
  function frame(now: number) {
    const dt = last === 0 ? 0 : Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt);
    render();
    raf = requestAnimationFrame(frame);
  }

  raf = requestAnimationFrame(frame);

  return {
    destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("resize", onResize);
      canvas.remove();
    },
    resume() {
      paused = false;
      held.clear();
      last = 0;
    },
  };
}
