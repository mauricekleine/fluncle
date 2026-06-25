// The follow-camera — the one genuinely new thing the overworld adds over the
// spike (which drew canvas coords == world coords with no camera). Pure + small
// so it unit-tests cleanly. The world is larger than the viewport; the camera is
// a window that centers the player and clamps so it never shows past the edge.

export type Camera = { x: number; y: number };

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** Where the camera *wants* to be: centered on the target, clamped to the world. */
export function clampCamera(
  targetX: number,
  targetY: number,
  viewW: number,
  viewH: number,
  worldW: number,
  worldH: number,
): Camera {
  // If the world is smaller than the viewport on an axis, center it instead.
  const x = worldW <= viewW ? (worldW - viewW) / 2 : clamp(targetX - viewW / 2, 0, worldW - viewW);
  const y = worldH <= viewH ? (worldH - viewH) / 2 : clamp(targetY - viewH / 2, 0, worldH - viewH);
  return { x, y };
}

/** Ease the camera toward its goal; `ease` of 1 snaps, lower trails. */
export function followCamera(
  camera: Camera,
  targetX: number,
  targetY: number,
  viewW: number,
  viewH: number,
  worldW: number,
  worldH: number,
  ease: number,
): Camera {
  const goal = clampCamera(targetX, targetY, viewW, viewH, worldW, worldH);
  return {
    x: lerp(camera.x, goal.x, ease),
    y: lerp(camera.y, goal.y, ease),
  };
}
