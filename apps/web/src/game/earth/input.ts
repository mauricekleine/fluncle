// Earth input — extracted from the spike's inlined handlers into a small module
// that mirrors the galaxy game's `input.ts` shape: continuous movement via
// `state()`, consume-once edges for the action (open a door) and back (close an
// overlay). Keyboard is the floor; pointer/touch is a later polish slice.

const MOVE: Record<string, [number, number]> = {
  a: [-1, 0],
  arrowdown: [0, 1],
  arrowleft: [-1, 0],
  arrowright: [1, 0],
  arrowup: [0, -1],
  d: [1, 0],
  s: [0, 1],
  w: [0, -1],
};

const ACTION = new Set(["e", "enter", " ", "spacebar"]);

export type EarthInput = {
  /** Held movement intent, summed across keys (unnormalized). */
  state: () => { dx: number; dy: number };
  /** True once per action press (open the door under the prompt). */
  consumeAction: () => boolean;
  /** True once per back press (Escape — close an overlay). */
  consumeBack: () => boolean;
  destroy: () => void;
};

export function createInput(): EarthInput {
  const held = new Set<string>();
  let action = false;
  let back = false;

  function norm(key: string): string {
    return key.length === 1 ? key.toLowerCase() : key.toLowerCase();
  }

  function onKeyDown(event: KeyboardEvent) {
    const key = norm(event.key);

    if (key === "escape") {
      back = true;
      return;
    }

    if (ACTION.has(key)) {
      event.preventDefault();
      action = true;
      return;
    }

    if (key in MOVE) {
      event.preventDefault();
      held.add(key);
    }
  }

  function onKeyUp(event: KeyboardEvent) {
    held.delete(norm(event.key));
  }

  function onBlur() {
    held.clear();
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  return {
    consumeAction() {
      const value = action;
      action = false;
      return value;
    },
    consumeBack() {
      const value = back;
      back = false;
      return value;
    },
    destroy() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    },
    state() {
      let dx = 0;
      let dy = 0;
      for (const key of held) {
        const move = MOVE[key];
        if (move) {
          dx += move[0];
          dy += move[1];
        }
      }
      return { dx, dy };
    },
  };
}
