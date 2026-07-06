// Shared, surface-agnostic helpers behind the `<Video>` compound player: the clock
// readout, the pointer→position mapping, and the seek clamp. Pure functions, no DOM —
// so the pointer→time mapping and the clamp are unit-testable without a video element
// (the same discipline as the stall watchdog's `mediaStallVerdict`).

/** H:MM:SS for an hour-plus set, M:SS below the hour. Tabular-friendly, padded. */
export function formatClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "0:00";
  }

  const whole = Math.floor(totalSeconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export const clampFraction = (n: number) => Math.max(0, Math.min(1, n));

/**
 * The pure pointer→position mapping behind the scrubber (the VibeMap model): a
 * pointer x against the track's left edge + width → a clamped 0..1 fraction.
 * Returns null for a zero-width track (nothing to seek into). Exported so the
 * pointer→time mapping is unit-testable without a DOM.
 */
export function pointerFraction(clientX: number, left: number, width: number): number | null {
  if (width <= 0) {
    return null;
  }

  return clampFraction((clientX - left) / width);
}

/**
 * Clamp a seek target into the element's seekable range. A non-finite `max`
 * (duration not known yet) leaves the requested seconds as the ceiling, so an early
 * seek is at least floored at 0. Pure, so the seek math is testable without a DOM.
 */
export function clampSeconds(seconds: number, max: number): number {
  const ceiling = Number.isFinite(max) ? max : seconds;

  return Math.max(0, Math.min(ceiling, seconds));
}
