import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";

/**
 * The three narrative phases of a journey clip. Every vehicle reads the same
 * arc: it departs (lifts off / approaches), travels (crosses the frame), and
 * arrives (settles into the close). The cover art's astronaut floating up out
 * of the towers is the canonical departure; the close card is the arrival.
 */
export type JourneyPhase = "depart" | "travel" | "arrive";

export type UseJourneyOptions = {
  /**
   * Fractional split points (0..1 of total clip progress) between the three
   * phases. `[departEnd, travelEnd]`: depart runs [0, departEnd], travel runs
   * [departEnd, travelEnd], arrive runs [travelEnd, 1]. Default [0.15, 0.85]:
   * a quick lift-off, a long travel, a settled arrival.
   */
  split?: [number, number];
  /**
   * Easing strength for `arc`, the slow-in/slow-out smoothstep. 1 is a single
   * smoothstep (gentle); higher values push more time into the slow ends
   * (more dramatic ease). Default 1. Stays a pure polynomial so it is cheap
   * and deterministic (no Remotion spring, no wall clock).
   */
  ease?: number;
};

export type JourneyState = {
  /** Linear clip progress 0..1 (frame / (durationInFrames - 1)). */
  progress: number;
  /** Which narrative phase the current frame sits in. */
  phase: JourneyPhase;
  /** 0..1 progress within the current phase (re-normalized per phase). */
  phaseProgress: number;
  /**
   * Eased 0..1 over the whole clip with slow-in/slow-out (smoothstep). This is
   * the value vehicles travel along: position, scale, displacement scroll. Use
   * `arc` for spatial motion and `progress` for raw timing.
   */
  arc: number;
};

/** Smoothstep-based slow-in/slow-out easing, raised to `ease` for more drama. */
const easeArc = (t: number, ease: number): number => {
  const clamped = Math.min(1, Math.max(0, t));
  // Classic smoothstep: 3t^2 - 2t^3, symmetric slow-in/slow-out.
  const smooth = clamped * clamped * (3 - 2 * clamped);
  if (ease === 1) {
    return smooth;
  }
  // Re-apply smoothstep `ease` times for a stronger hold at both ends.
  let out = smooth;
  for (let i = 1; i < ease; i++) {
    out = out * out * (3 - 2 * out);
  }
  return out;
};

/**
 * The shared narrative clock every Journey vehicle consumes. Maps a clip's
 * frame position to a journey arc: linear `progress`, the current `phase` and
 * its local `phaseProgress`, and the eased `arc` used for spatial travel.
 *
 * Pure and deterministic: derived only from useCurrentFrame()/durationInFrames.
 * No randomness, no wall clock; safe for headless renders.
 *
 * @example
 * const { arc, phase } = useJourney();
 * // feed `arc` into JourneyOrb's path, or JourneyLines' travel field.
 */
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
