import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";

export type JourneyPhase = "depart" | "travel" | "arrive";

export type UseJourneyOptions = {
  split?: [number, number];

  ease?: number;
};

export type JourneyState = {
  progress: number;

  phase: JourneyPhase;

  phaseProgress: number;

  arc: number;
};

const easeArc = (t: number, ease: number): number => {
  const clamped = Math.min(1, Math.max(0, t));

  const smooth = clamped * clamped * (3 - 2 * clamped);
  if (ease === 1) {
    return smooth;
  }

  let out = smooth;
  for (let i = 1; i < ease; i++) {
    out = out * out * (3 - 2 * out);
  }
  return out;
};

export const useJourney = (options: UseJourneyOptions = {}): JourneyState => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const [departEnd, travelEnd] = options.split ?? [0.15, 0.85];
  const ease = Math.max(1, Math.floor(options.ease ?? 1));

  const span = Math.max(1, durationInFrames - 1);
  const progress = Math.min(1, Math.max(0, frame / span));

  let phase: JourneyPhase;
  let phaseProgress: number;
  if (progress < departEnd) {
    phase = "depart";
    phaseProgress = interpolate(progress, [0, departEnd], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  } else if (progress < travelEnd) {
    phase = "travel";
    phaseProgress = interpolate(progress, [departEnd, travelEnd], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  } else {
    phase = "arrive";
    phaseProgress = interpolate(progress, [travelEnd, 1], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  }

  return {
    arc: easeArc(progress, ease),
    phase,
    phaseProgress,
    progress,
  };
};
