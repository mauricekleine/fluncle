// The factory's geometry — shared by the sim (which moves findings to these
// coordinates) and the renderer (which draws the machines and belt at them), so
// the two can never drift. All in logical pixels; the canvas integer-upscales the
// whole scene to fit the viewport.

import { LAUNCH_INDEX } from "./stations";

/** The logical canvas — a wide side-on view; the camera pans across a wider world. */
export const VIEW_W = 320;
export const VIEW_H = 180;

/** The belt surface line — a finding's base and a machine's base both sit here. */
export const BELT_Y = 120;

/** The first machine's centre x, and the gap between machines. */
export const FIRST_STATION_X = 76;
export const STATION_GAP = 150;

/** Gap between findings queued in front of a machine (the pile). */
export const SLOT_GAP = 22;

/** Where a fresh finding slides in from, off the left edge. */
export const ENTRY_X = -30;

/** A finding token's footprint (the cover thumbnail in its frame). */
export const TOKEN_W = 22;
export const TOKEN_H = 26;

/** A machine's centre x on the floor. */
export function stationX(index: number): number {
  return FIRST_STATION_X + index * STATION_GAP;
}

/** The whole world's width — past the launch pad, with headroom for liftoff. */
export const WORLD_W = stationX(LAUNCH_INDEX) + 130;

/** Where the `slot`-th finding queued at a machine sits (slot 0 = at the machine). */
export function slotX(index: number, slot: number): number {
  return stationX(index) - slot * SLOT_GAP;
}
