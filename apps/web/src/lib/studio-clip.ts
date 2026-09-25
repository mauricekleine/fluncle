import { type StudioEnvelope, type StudioPeak, type StudioSuggestion } from "@fluncle/contracts";

export type { StudioEnvelope, StudioPeak, StudioSuggestion };

export type TimelineRegion = {
  leftFraction: number;
  widthFraction: number;
};

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

export function cropWindowWidthPx(videoHeight: number): number {
  return Math.round((Math.max(0, videoHeight) * 9) / 16);
}

export function maxXOffset(videoWidth: number, videoHeight: number): number {
  return Math.max(0, Math.round(videoWidth) - cropWindowWidthPx(videoHeight));
}

export function cropWidthFraction(videoWidth: number, videoHeight: number): number {
  if (videoWidth <= 0) {
    return 0;
  }

  return clamp01(cropWindowWidthPx(videoHeight) / videoWidth);
}

export function cropRectToXOffset({
  leftFraction,
  videoHeight,
  videoWidth,
}: {
  leftFraction: number;
  videoHeight: number;
  videoWidth: number;
}): number {
  const max = maxXOffset(videoWidth, videoHeight);
  const px = Math.round(clamp01(leftFraction) * Math.max(0, videoWidth));

  return Math.max(0, Math.min(px, max));
}

export function xOffsetToLeftFraction({
  videoWidth,
  xOffset,
}: {
  videoWidth: number;
  xOffset: number;
}): number {
  if (videoWidth <= 0) {
    return 0;
  }

  return clamp01(xOffset / videoWidth);
}

export function centredCropLeftFraction(videoWidth: number, videoHeight: number): number {
  if (videoWidth <= 0) {
    return 0;
  }

  return maxXOffset(videoWidth, videoHeight) / 2 / videoWidth;
}

export function clampCropLeftFraction(
  leftFraction: number,
  videoWidth: number,
  videoHeight: number,
): number {
  if (videoWidth <= 0) {
    return 0;
  }

  const maxLeft = maxXOffset(videoWidth, videoHeight) / videoWidth;

  return Math.max(0, Math.min(clamp01(leftFraction), maxLeft));
}

export function msToFraction(ms: number, durationMs: number): number {
  if (durationMs <= 0) {
    return 0;
  }

  return clamp01(ms / durationMs);
}

export function fractionToMs(fraction: number, durationMs: number): number {
  return Math.round(clamp01(fraction) * Math.max(0, durationMs));
}

export function suggestionToRegion(
  suggestion: Pick<StudioSuggestion, "durationMs" | "startMs">,
  totalDurationMs: number,
): TimelineRegion {
  const leftFraction = msToFraction(suggestion.startMs, totalDurationMs);
  const endFraction = msToFraction(suggestion.startMs + suggestion.durationMs, totalDurationMs);

  return { leftFraction, widthFraction: Math.max(0, endFraction - leftFraction) };
}

export function clipToRegion(
  clip: { inMs: number; outMs: number },
  totalDurationMs: number,
): TimelineRegion {
  const leftFraction = msToFraction(clip.inMs, totalDurationMs);
  const endFraction = msToFraction(clip.outMs, totalDurationMs);

  return { leftFraction, widthFraction: Math.max(0, endFraction - leftFraction) };
}

export function bandToWindow(
  edgeFractionA: number,
  edgeFractionB: number,
  totalDurationMs: number,
): { inMs: number; outMs: number } {
  const a = fractionToMs(edgeFractionA, totalDurationMs);
  const b = fractionToMs(edgeFractionB, totalDurationMs);

  return { inMs: Math.min(a, b), outMs: Math.max(a, b) };
}

export function defaultBandAt(
  playheadMs: number,
  clipLengthMs: number,
  totalDurationMs: number,
): { inMs: number; outMs: number } {
  const length = Math.max(1, Math.round(clipLengthMs));
  const total = Math.max(0, Math.round(totalDurationMs));
  const maxStart = Math.max(0, total - length);
  const inMs = Math.max(0, Math.min(Math.round(playheadMs), maxStart));

  return { inMs, outMs: Math.min(total, inMs + length) };
}

export const CUE_SNAP_WINDOW_MS = 2_000;

export function snapCueToPeak(
  ms: number,
  peaks: Pick<StudioPeak, "atMs">[],
  windowMs: number = CUE_SNAP_WINDOW_MS,
): { ms: number; snapped: boolean } {
  const raw = Math.max(0, Math.round(ms));
  let best: number | null = null;
  let bestDist = Number.POSITIVE_INFINITY;

  for (const peak of peaks) {
    const dist = Math.abs(peak.atMs - raw);

    if (dist <= windowMs && dist < bestDist) {
      best = Math.max(0, Math.round(peak.atMs));
      bestDist = dist;
    }
  }

  return best === null ? { ms: raw, snapped: false } : { ms: best, snapped: true };
}

export type CueMember = { startMs?: number | null; trackId: string };

export type CueProgress = {
  complete: boolean;
  firstNotZero: boolean;
  marked: number;
  outOfOrderTrackIds: string[];
  total: number;
};

export function cueProgress(members: CueMember[]): CueProgress {
  const total = members.length;
  let marked = 0;
  let previousCue: number | null = null;
  let monotonic = true;
  const outOfOrderTrackIds: string[] = [];

  for (const member of members) {
    const cue = member.startMs;

    if (cue == null) {
      continue;
    }

    marked += 1;

    if (previousCue !== null && cue <= previousCue) {
      monotonic = false;
      outOfOrderTrackIds.push(member.trackId);
    }

    previousCue = cue;
  }

  const firstCue = members[0]?.startMs;
  const firstNotZero = marked > 0 && firstCue != null && firstCue !== 0;
  const complete = total > 0 && marked === total && firstCue === 0 && monotonic;

  return { complete, firstNotZero, marked, outOfOrderTrackIds, total };
}
