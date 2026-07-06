// Keyboard + touch input. Keyboard: arrows or A/D steer, space (or up/W)
// boosts. Touch: left/right halves steer, a bottom-center zone boosts. Any
// key or tap doubles as the menu action (launch / skip / fly again); M
// toggles mute, C toggles the atlas (the game says "Charting the galaxy…" —
// C is the chart key), Escape pauses.

const STEER_LEFT_KEYS = new Set(["a", "arrowleft"]);
const STEER_RIGHT_KEYS = new Set(["d", "arrowright"]);
const BOOST_KEYS = new Set([" ", "arrowup", "w"]);
// Optional manual fire (Unit D). The laser auto-clears the path; F is a desktop
// blip on demand. No touch fire verb — auto-fire covers glass.
const FIRE_KEYS = new Set(["f"]);

type InputState = {
  boost: boolean;
  fire: boolean;
  steer: number;
};

export type InputManager = {
  /** True once if an action (any key / tap) fired since the last call. */
  consumeAction: () => boolean;
  /** True once if C (the atlas) was pressed since the last call. */
  consumeAtlasToggle: () => boolean;
  /** True once if M was pressed since the last call. */
  consumeMuteToggle: () => boolean;
  /** True once if Escape was pressed since the last call. */
  consumePauseToggle: () => boolean;
  destroy: () => void;
  state: () => InputState;
  /** Whether the player has touched the screen at all this session. */
  touchSeen: () => boolean;
};

export function createInput(
  target: HTMLElement,
  /** Returns true when a press hit an on-canvas control and is consumed. */
  isUiTap?: (clientX: number, clientY: number) => boolean,
): InputManager {
  const keysDown = new Set<string>();
  const pointers = new Map<number, "boost" | "left" | "right">();

  let actionPending = false;
  let atlasPending = false;
  let mutePending = false;
  let pausePending = false;
  let sawTouch = false;

  function zoneFor(event: PointerEvent): "boost" | "left" | "right" {
    const rect = target.getBoundingClientRect();
    const x = (event.clientX - rect.left) / Math.max(1, rect.width);
    const y = (event.clientY - rect.top) / Math.max(1, rect.height);

    if (y > 0.55 && x > 0.33 && x < 0.67) {
      return "boost";
    }

    return x < 0.5 ? "left" : "right";
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    const key = event.key.toLowerCase();

    if (key === "m") {
      mutePending = true;

      return;
    }

    // C is the chart key: it only ever toggles the atlas, never steers or
    // fires the menu action (same contract as M).
    if (key === "c") {
      atlasPending = true;

      return;
    }

    // Escape is the pause key, never a menu action.
    if (key === "escape") {
      pausePending = true;

      return;
    }

    if (BOOST_KEYS.has(key) || STEER_LEFT_KEYS.has(key) || STEER_RIGHT_KEYS.has(key)) {
      // Steering and boosting shouldn't scroll the page.
      event.preventDefault();
    }

    keysDown.add(key);
    actionPending = true;
  }

  function onKeyUp(event: KeyboardEvent): void {
    keysDown.delete(event.key.toLowerCase());
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.pointerType === "touch") {
      sawTouch = true;
    }

    event.preventDefault();

    // On-canvas controls (the card's Spotify link) eat the press whole:
    // no steer, no menu action, no orbit departure.
    if (isUiTap?.(event.clientX, event.clientY)) {
      return;
    }

    target.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, zoneFor(event));
    actionPending = true;
  }

  function onPointerMove(event: PointerEvent): void {
    if (pointers.has(event.pointerId)) {
      pointers.set(event.pointerId, zoneFor(event));
    }
  }

  function onPointerEnd(event: PointerEvent): void {
    pointers.delete(event.pointerId);
  }

  function onBlur(): void {
    keysDown.clear();
    pointers.clear();
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  target.addEventListener("pointerdown", onPointerDown);
  target.addEventListener("pointermove", onPointerMove);
  target.addEventListener("pointerup", onPointerEnd);
  target.addEventListener("pointercancel", onPointerEnd);
  target.style.touchAction = "none";

  return {
    consumeAction: () => {
      const pending = actionPending;

      actionPending = false;

      return pending;
    },
    consumeAtlasToggle: () => {
      const pending = atlasPending;

      atlasPending = false;

      return pending;
    },
    consumeMuteToggle: () => {
      const pending = mutePending;

      mutePending = false;

      return pending;
    },
    consumePauseToggle: () => {
      const pending = pausePending;

      pausePending = false;

      return pending;
    },
    destroy: () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      target.removeEventListener("pointerdown", onPointerDown);
      target.removeEventListener("pointermove", onPointerMove);
      target.removeEventListener("pointerup", onPointerEnd);
      target.removeEventListener("pointercancel", onPointerEnd);
    },
    state: () => {
      let steer = 0;

      for (const key of keysDown) {
        if (STEER_LEFT_KEYS.has(key)) {
          steer -= 1;
        }

        if (STEER_RIGHT_KEYS.has(key)) {
          steer += 1;
        }
      }

      let boost = [...keysDown].some((key) => BOOST_KEYS.has(key));
      const fire = [...keysDown].some((key) => FIRE_KEYS.has(key));

      for (const zone of pointers.values()) {
        if (zone === "left") {
          steer -= 1;
        } else if (zone === "right") {
          steer += 1;
        } else {
          boost = true;
        }
      }

      return { boost, fire, steer: Math.max(-1, Math.min(1, steer)) };
    },
    touchSeen: () => sawTouch,
  };
}
