// The feed card's action-rail labels as pure state → string maps, so the Chrome Rule
// (voice.md §4: one stable literal label per control; the icon + the gold tint carry
// the state, never the word) is pinned by a test and not just by the JSX. A label that
// flips per press — "Note"→"Playing", "Sound"→"Muted" — is exactly the bug this guards
// (ratified 2026-07-11). The screen-reader hint DOES name the action, since a11y wants
// the verb; the visible chrome stays put.

export type RailControl = {
  /** Whether the control reads as "on" — drives the gold tint + accessibilityState. */
  active: boolean;
  /** Screen-reader hint that names the action the next press performs (may flip). */
  accessibilityLabel: string;
  /** The visible chrome label. STABLE across state — never flips. */
  label: string;
};

/** Fluncle's recovered observation (his spoken note over the finding). */
export function observationRail(observing: boolean): RailControl {
  return {
    accessibilityLabel: observing ? "Stop the observation" : "Play Fluncle's observation",
    active: observing,
    label: "Observation",
  };
}

/**
 * The card's global sound toggle. While the observation plays it owns the one sound
 * source (the operator's ruling: the observation note wins — the two are never audible
 * at once), so the control reads muted (never gold) for the duration. The toggle still
 * governs the card's own audio PREFERENCE (`soundOn`), which is why the visible state is
 * suppressed but the a11y verb keeps describing the persistent toggle: press it during
 * an observation and your preference is set, it just takes effect once the note ends.
 */
export function soundRail(soundOn: boolean, observing = false): RailControl {
  return {
    accessibilityLabel: soundOn ? "Turn sound off" : "Turn sound on",
    active: soundOn && !observing,
    label: "Sound",
  };
}
