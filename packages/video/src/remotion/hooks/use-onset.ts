import { useCurrentFrame, useVideoConfig } from "remotion";

export const useOnset = (onsets: number[], windowMs = 180): number => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  if (onsets.length === 0 || windowMs <= 0) {
    return 0;
  }

  const nowMs = (frame / fps) * 1000;
  let flash = 0;

  for (let i = 0; i < onsets.length; i++) {
    const delta = nowMs - onsets[i];
    if (delta < 0) {
      break;
    }
    if (delta <= windowMs) {
      const v = 1 - delta / windowMs;
      if (v > flash) {
        flash = v;
      }
    }
  }

  return flash;
};
