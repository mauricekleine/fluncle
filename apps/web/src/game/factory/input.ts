// Factory input — the floor is watched and SCROLLED, not walked, so this is a
// horizontal pan (keys + pointer drag) plus a tap to inspect a finding. It mirrors
// the consume-once edge shape of earth/input.ts (a tap and the back press are read
// once), but owns the canvas pointer so drag-to-pan and click-to-inspect share one
// gesture: a press that barely moves is a tap; a press that travels is a drag.

const PAN_KEYS: Record<string, number> = {
  a: -1,
  arrowleft: -1,
  arrowright: 1,
  d: 1,
};

/** Pointer travel (CSS px) above which a press is a drag, not a tap. */
const DRAG_THRESHOLD = 4;

export type FactoryInput = {
  /** A tap (a press that didn't travel), in CSS px relative to the canvas. Read once. */
  consumeTap: () => { x: number; y: number } | undefined;
  /** True once per Escape press (close an overlay). */
  consumeBack: () => boolean;
  destroy: () => void;
  /** Accumulated pointer-drag dx (CSS px) since the last read; consumed on read. */
  drag: () => number;
  /** Held pan intent from the keyboard: -1, 0, or 1. */
  panKeys: () => number;
};

export function createFactoryInput(canvas: HTMLCanvasElement): FactoryInput {
  const held = new Set<string>();
  let back = false;
  let tap: { x: number; y: number } | undefined;
  let dragAccum = 0;

  let pointerId: number | undefined;
  let downX = 0;
  let downY = 0;
  let lastX = 0;
  let travelled = 0;

  function onKeyDown(event: KeyboardEvent) {
    const key = event.key.toLowerCase();
    if (key === "escape") {
      back = true;
      return;
    }
    if (key in PAN_KEYS) {
      event.preventDefault();
      held.add(key);
    }
  }

  function onKeyUp(event: KeyboardEvent) {
    held.delete(event.key.toLowerCase());
  }

  function onBlur() {
    held.clear();
    pointerId = undefined;
  }

  function onPointerDown(event: PointerEvent) {
    pointerId = event.pointerId;
    downX = event.clientX;
    downY = event.clientY;
    lastX = event.clientX;
    travelled = 0;
    canvas.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event: PointerEvent) {
    if (pointerId !== event.pointerId) {
      return;
    }
    const dx = event.clientX - lastX;
    lastX = event.clientX;
    travelled += Math.abs(dx);
    if (travelled > DRAG_THRESHOLD) {
      dragAccum += dx;
    }
  }

  function onPointerUp(event: PointerEvent) {
    if (pointerId !== event.pointerId) {
      return;
    }
    if (travelled <= DRAG_THRESHOLD) {
      const rect = canvas.getBoundingClientRect();
      tap = { x: downX - rect.left, y: downY - rect.top };
    }
    pointerId = undefined;
    canvas.releasePointerCapture?.(event.pointerId);
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);

  return {
    consumeBack() {
      const value = back;
      back = false;
      return value;
    },
    consumeTap() {
      const value = tap;
      tap = undefined;
      return value;
    },
    destroy() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
    },
    drag() {
      const value = dragAccum;
      dragAccum = 0;
      return value;
    },
    panKeys() {
      let dir = 0;
      for (const key of held) {
        dir += PAN_KEYS[key] ?? 0;
      }
      return dir < 0 ? -1 : dir > 0 ? 1 : 0;
    },
  };
}
