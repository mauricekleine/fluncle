import { useCurrentFrame, useVideoConfig } from "remotion";

export type BeatState = {
  beatIndex: number;

  beatProgress: number;

  pulse: number;
};

export type UseBeatOptions = {
  decay?: number;
};

export const useBeat = (beatGrid: number[], options: UseBeatOptions = {}): BeatState => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const decay = options.decay ?? 3.2;

  const nowMs = (frame / fps) * 1000;

  if (beatGrid.length === 0) {
    return { beatIndex: -1, beatProgress: 0, pulse: 0 };
  }

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
