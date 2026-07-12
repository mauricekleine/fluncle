// The feed card's action-rail labels as pure state → string maps, so the Chrome Rule
// (voice.md §4: one stable literal label per control; the icon + the gold tint carry
// the state, never the word) is pinned by a test and not just by the JSX. A label that
// flips per press — "Sound"→"Muted" — is exactly the bug this guards (ratified
// 2026-07-11). The screen-reader hint DOES name the action, since a11y wants the verb;
// the visible chrome stays put.

export type RailControl = {
  /** Whether the control reads as "on" — drives the gold tint + accessibilityState. */
  active: boolean;
  /** Screen-reader hint that names the action the next press performs (may flip). */
  accessibilityLabel: string;
  /** The visible chrome label. STABLE across state — never flips. */
  label: string;
};

/**
 * The card's global sound toggle. The gold tint + accessibilityState follow `soundOn`;
 * the visible label is the one stable literal (the Chrome Rule).
 */
export function soundRail(soundOn: boolean): RailControl {
  return {
    accessibilityLabel: soundOn ? "Turn sound off" : "Turn sound on",
    active: soundOn,
    label: "Sound",
  };
}
