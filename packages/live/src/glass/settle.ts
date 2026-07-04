// The arrival settle guard — a PURE, isomorphic input-gain envelope (no DOM, no GL,
// no timers), imported by BOTH the glass client and bun:test.
//
// WHY: on a scene change the world must WAKE UP, not spawn mid-sprint. Several
// audio-reactive signals arrive hot on the first frames of an arrival — the drop
// envelope pins high while the slow swell baseline lags seconds behind it, and any
// per-arrival re-seed/re-arm briefly un-normalizes the bands — so a fresh world's
// motion/velocity "races" for a few seconds before the followers catch up. This
// envelope eases every audio-reactive INPUT gain from a floor up to unity over a
// short window, so the reactivity fades in smoothly.
//
// LAW: this scales audio-reactive INPUTS only (bands, transients, swell, drop — the
// signals that drive material/velocity). It is NEVER applied to u_time, the drift
// clock, u_progress, seed, or the palette: the constant clock never pauses, so the
// world keeps breathing and travelling while its reactivity comes up.

/** The settle window: audio reactivity eases in over this long after an arrival. */
export const SETTLE_MS = 1500;
/** The floor the reactive input gain starts at on the first frame of an arrival. */
export const SETTLE_FLOOR = 0.25;

/**
 * The eased audio-reactive input gain `dwellMs` after an arrival: SETTLE_FLOOR at
 * dwell 0, unity at/after SETTLE_MS, smoothstep between. Multiply the reactive
 * inputs (bass/mid/treble/energy/kick/swell/drop and their fast siblings) by this.
 */
export function settleGain(dwellMs: number): number {
  if (dwellMs <= 0) {
    return SETTLE_FLOOR;
  }
  if (dwellMs >= SETTLE_MS) {
    return 1;
  }
  const x = dwellMs / SETTLE_MS;
  const s = x * x * (3 - 2 * x); // smoothstep — eased, never stepped
  return SETTLE_FLOOR + (1 - SETTLE_FLOOR) * s;
}
