import { type DeviceKind } from "./sprites";

// The spike room: one screen, no scroll. An organic patch of ground (`.`)
// floating in the cosmos (`~`) — the narrative made literal, the sky we already
// have with ground under it. Devices are placed by tile (below), not in the
// map, so they can anchor at sub-tile precision and y-sort against the player.

export const MAP = [
  "~~~~~~~~~~~~~~",
  "~~~~......~~~~",
  "~~..........~~",
  "~.............",
  "~.............",
  "~.............",
  "~.............",
  "~.............",
  "~~..........~~",
  "~~~~......~~~~",
  "~~~~~~~~~~~~~~",
];

export const MAP_W = 14;
export const MAP_H = 11;

// Each device sits on a tile; its sprite anchors bottom-center at that tile's
// bottom edge and draws upward. The surface it opens is the door's payload.
export type Surface = "onion" | "spotify" | "terminal";

export type Device = {
  /** The surface this door opens. */
  kind: DeviceKind;
  surface: Surface;
  /** Anchor tile (the solid footprint + bottom-center anchor). */
  tx: number;
  ty: number;
};

export const DEVICES: Device[] = [
  { kind: "crt", surface: "terminal", tx: 3, ty: 4 },
  { kind: "boombox", surface: "spotify", tx: 7, ty: 7 },
  { kind: "onion", surface: "onion", tx: 10, ty: 4 },
];

/** Player spawn, in logical pixels (feet point — bottom-center of the sprite). */
export const SPAWN = { x: 6.5 * 16, y: 6 * 16 + 14 };

function tileAt(tx: number, ty: number): string {
  if (ty < 0 || ty >= MAP_H || tx < 0 || tx >= MAP_W) {
    return "~";
  }

  return MAP[ty]?.[tx] ?? "~";
}

/** Ground is walkable; cosmos and device footprints are solid. */
export function isWalkable(tx: number, ty: number): boolean {
  if (tileAt(tx, ty) !== ".") {
    return false;
  }

  return !DEVICES.some((device) => device.tx === tx && device.ty === ty);
}
