import { useCurrentFrame, useVideoConfig } from "remotion";

/**
 * Returns a 0..1 flash that spikes to 1 at each onset (ms offset relative to
 * clip start) and decays linearly to 0 over `windowMs`. Multiple overlapping
 * onsets take the max. Pure and deterministic.
 *
 * Use for transient sparkle: a grain kick, a DitherField threshold jolt, a
 * star twinkle on a snare hit.
 */
export const useOnset = (onsets: number[], windowMs = 180): number => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  if (onsets.length === 0 || windowMs <= 0) {
    return 0;
  }

  const nowMs = (frame / fps) * 1000;
  let flash = 0;

  for (let i = 0; i < onsets.length; i++) {
    const delta = nowMs - onsets[i]!;
    if (delta < 0) {
      // Onsets are sorted ascending; the rest are in the future.
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
