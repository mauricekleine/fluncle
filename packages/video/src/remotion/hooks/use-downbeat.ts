import { type BeatState, type UseBeatOptions, useBeat } from "./use-beat";

/**
 * Turns the bar downbeats (ms offsets relative to clip start, every 4th beat at
 * the analyzer's kick-scored bar phase) into a bar-synced decay-envelope pulse,
 * exactly like useBeat but paced to the BAR: `pulse` snaps to 1 on each
 * downbeat and decays across the bar. The default decay (2.2) is gentler than
 * useBeat's 3.2 because the interval is 4× longer — the pulse breathes across
 * the bar instead of vanishing in its first beat. A MATERIAL/staging signal
 * (bar-level swells, section emphasis); motion still only rides smoothed
 * envelopes (Motion law, doctrine 7). Pure and deterministic.
 */
export const useDownbeat = (downbeats: number[], options: UseBeatOptions = {}): BeatState =>
  useBeat(downbeats, { decay: options.decay ?? 2.2 });
