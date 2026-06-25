import { TILE } from "./sprites";

// The overworld terrain — one contiguous, camera-followed world (RFC decision
// D3). A hub-and-spokes shape carved from rectangles: the Landing Site at center
// (spawn), the four regions on the arms, corridors between. Ground (`isGround`)
// is walkable; everything else is the cosmos showing through at the world's edge
// (the spike's ground-island-in-starfield, scaled up). PURE + testable — door
// occupancy lives in the game (it reads the registry), so this module never
// imports the registry and unit-tests cleanly.

export const WORLD_W = 56;
export const WORLD_H = 48;
export const WORLD_PX_W = WORLD_W * TILE;
export const WORLD_PX_H = WORLD_H * TILE;

export type Box = { x0: number; y0: number; x1: number; y1: number };

// The tile box each region owns; a region module places its doors inside its
// box (the brief hands each fan-out agent these numbers). Center the props,
// leave a 1-tile margin so a door is never flush against the cosmos edge.
export const REGION_BOXES = {
  comms: { x0: 38, x1: 52, y0: 15, y1: 32 },
  edge: { x0: 20, x1: 35, y0: 34, y1: 45 },
  landing: { x0: 22, x1: 33, y0: 18, y1: 29 },
  launch: { x0: 20, x1: 35, y0: 2, y1: 13 },
  workshop: { x0: 3, x1: 17, y0: 15, y1: 32 },
} satisfies Record<string, Box>;

export type RegionId = keyof typeof REGION_BOXES;

// The corridors that join the Landing Site to each arm (3 tiles wide).
const CORRIDORS: Box[] = [
  { x0: 16, x1: 23, y0: 22, y1: 25 }, // ← workshop
  { x0: 32, x1: 39, y0: 22, y1: 25 }, // → comms
  { x0: 26, x1: 29, y0: 12, y1: 19 }, // ↑ launch
  { x0: 26, x1: 29, y0: 28, y1: 35 }, // ↓ edge
];

const WALKABLE: Box[] = [...Object.values(REGION_BOXES), ...CORRIDORS];

function inBox(box: Box, tx: number, ty: number): boolean {
  return tx >= box.x0 && tx <= box.x1 && ty >= box.y0 && ty <= box.y1;
}

/** Terrain only: is this tile carved ground (vs the cosmos)? */
export function isGround(tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= WORLD_W || ty >= WORLD_H) {
    return false;
  }
  return WALKABLE.some((box) => inBox(box, tx, ty));
}

/** Player spawn, in logical pixels (feet point — bottom-center of the sprite). */
export const SPAWN = {
  x: 27.5 * TILE,
  y: 24 * TILE + 14,
};
