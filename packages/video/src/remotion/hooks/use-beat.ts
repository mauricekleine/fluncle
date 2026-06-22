import { useCurrentFrame, useVideoConfig } from "remotion";

export type BeatState = {
  /** Index of the most recent beat at or before the current frame, -1 before the first. */
  beatIndex: number;
  /** 0..1 progress through the current beat interval (linear). */
  beatProgress: number;
  /** 0..1 pulse that snaps to 1 on each beat and decays toward 0 before the next. */
  pulse: number;
};

export type UseBeatOptions = {
  /**
   * How sharply the pulse decays after a beat hit. Higher = snappier (decays
   * faster). The pulse reaches ~e^-decay of its peak at the next beat.
   */
  decay?: number;
};

/**
 * Turns a beat grid (ms offsets relative to clip start) into a beat-synced
 * pulse. Pure: derived only from useCurrentFrame()/fps and the grid array.
 *
 * - beatIndex / beatProgress let callers stage things on the bar.
 * - pulse is the workhorse: snap-to-1-on-beat, exponential decay between beats,
 *   ideal for driving the Eclipse rim flare or a scale kick.
 */
export const useBeat = (beatGrid: number[], options: UseBeatOptions = {}): BeatState => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const decay = options.decay ?? 3.2;

  const nowMs = (frame / fps) * 1000;

  if (beatGrid.length === 0) {
    return { beatIndex: -1, beatProgress: 0, pulse: 0 };
  }

  // Find the most recent beat at or before now.
  let beatIndex = -1;
  for (let i = 0; i < beatGrid.length; i++) {
    if (beatGrid[i] <= nowMs) {
      beatIndex = i;
    } else {
      break;
    }
  }

  if (beatIndex < 0) {
    return { beatIndex: -1, beatProgress: 0, pulse: 0 };
  }

  const beatMs = beatGrid[beatIndex];
  const nextMs =
    beatIndex + 1 < beatGrid.length
      ? beatGrid[beatIndex + 1]
      : beatMs + (beatGrid[beatIndex] - (beatGrid[beatIndex - 1] ?? beatMs - 500));

  const interval = Math.max(1, nextMs - beatMs);
  const beatProgress = Math.min(1, Math.max(0, (nowMs - beatMs) / interval));
  const pulse = Math.exp(-decay * beatProgress);

  return { beatIndex, beatProgress, pulse };
};
