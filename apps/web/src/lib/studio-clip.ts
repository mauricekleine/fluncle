// The Fluncle Studio editor's pure geometry.
// Two coordinate spaces meet here, kept DOM-free so they are unit-testable on
// synthetic inputs (no ffmpeg, no `<video>`, no React):
//
//   1. The CROP space — a draggable 9:16 portrait window over the LANDSCAPE set
//      rendition (the VibeMap pointer model lives in the component; the maths
//      live here). The window keeps the source's full height and crops its width
//      to 9:16; the operator slides it left↔right. The committed value is an
//      integer `xOffset` in SOURCE PIXELS — exactly what Unit C's ffmpeg cut
//      (`crop=ih*9/16:ih:<xOffset>:0`) and the merged `create_clip` validator
//      (a non-negative integer) consume.
//   2. The TIMELINE space — a suggestion window or a hand-picked in/out band, as
//      fractions of the set duration (what the energy lane draws) ⇄ millisecond
//      `inMs`/`outMs` (what `create_clip` stores).
//
// `StudioEnvelope` (+ its peak/suggestion shapes) is MIRRORED here, not imported
// from `@fluncle/video`: that package is a Node/ffmpeg/Remotion pipeline and is
// not (and should not become) a dependency of the Worker-targeted `apps/web`. The
// mirror is the wire contract of `<log-id>/studio-envelope.json`; if the producer
// shape ever changes, keep this in step (the field set is small and stable).

/** A loudness-rise candidate ("drop") — a guess the operator vets, not a certainty. */
export type StudioPeak = {
  atMs: number;
  score: number;
  kind: "drop";
};

/** A vettable clip window: the drop lands at `anchorMs`, just inside `startMs`. */
export type StudioSuggestion = {
  startMs: number;
  durationMs: number;
  anchorMs: number;
  score: number;
};

/**
 * The set-analysis artifact the editor reads from R2. Mirror of the producer type
 * in `@fluncle/video` (`analyze-set.ts`). `bpm` is null on a multi-tempo set; the
 * curves are decimated to `hopMs` (~100ms). Absent on R2 until the box stages it.
 */
export type StudioEnvelope = {
  durationMs: number;
  hopMs: number;
  bpm: number | null;
  energy: number[];
  bass: number[];
  flux: number[];
  peaks: StudioPeak[];
  suggestions: StudioSuggestion[];
};

/** A timeline region as fractions of the set duration (what the energy lane draws). */
export type TimelineRegion = {
  leftFraction: number;
  widthFraction: number;
};

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

// ── Crop space (9:16 window over the landscape rendition) ─────────────────────

/**
 * The width (source px) of a 9:16 portrait window cropped from a landscape source
 * of `videoHeight`. The window keeps the full height, so its width is `H·9/16`
 * (matching Unit C's `crop=ih*9/16:ih`). Rounded to a whole pixel.
 */
export function cropWindowWidthPx(videoHeight: number): number {
  return Math.round((Math.max(0, videoHeight) * 9) / 16);
}

/**
 * The largest valid `xOffset` (source px) — the window's left edge cannot push its
 * right edge past the source width. Clamps to 0 when the source is already as
 * narrow as (or narrower than) a 9:16 window (nothing to slide).
 */
export function maxXOffset(videoWidth: number, videoHeight: number): number {
  return Math.max(0, Math.round(videoWidth) - cropWindowWidthPx(videoHeight));
}

/**
 * The crop window's width as a FRACTION of the displayed preview width — the width
 * of the draggable rect. 0 for a zero-width source (nothing to frame).
 */
export function cropWidthFraction(videoWidth: number, videoHeight: number): number {
  if (videoWidth <= 0) {
    return 0;
  }

  return clamp01(cropWindowWidthPx(videoHeight) / videoWidth);
}

/**
 * Map a dragged rect LEFT-edge fraction (0..1 of the preview width) to the integer
 * `xOffset` (source px) that `create_clip` stores. Clamped to `[0, maxXOffset]` so
 * the baked crop always stays inside the frame.
 */
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

/**
 * The inverse: a stored `xOffset` (source px) → the rect's left-edge fraction, for
 * drawing an existing clip's framing over the preview. 0 for a zero-width source.
 */
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

/**
 * The left-edge fraction that CENTRES the 9:16 window in the frame — the natural
 * default + "reset framing" target for a centred top-down set. 0 when there's no
 * travel (the window already fills the frame).
 */
export function centredCropLeftFraction(videoWidth: number, videoHeight: number): number {
  if (videoWidth <= 0) {
    return 0;
  }

  return maxXOffset(videoWidth, videoHeight) / 2 / videoWidth;
}

/**
 * Clamp a rect left-edge fraction so the whole 9:16 window stays inside the frame
 * (its right edge never crosses 1). Used while dragging, so the rect can't escape.
 */
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

// ── Timeline space (suggestions / in-out bands ⇄ ms) ──────────────────────────

/** A millisecond position → a 0..1 fraction of the set duration. */
export function msToFraction(ms: number, durationMs: number): number {
  if (durationMs <= 0) {
    return 0;
  }

  return clamp01(ms / durationMs);
}

/** A 0..1 fraction of the set duration → a whole-millisecond position. */
export function fractionToMs(fraction: number, durationMs: number): number {
  return Math.round(clamp01(fraction) * Math.max(0, durationMs));
}

/**
 * A suggestion window (start + duration, in ms) → a timeline region (fractions of
 * the set duration) the energy lane draws as a dashed ghost band.
 */
export function suggestionToRegion(
  suggestion: Pick<StudioSuggestion, "durationMs" | "startMs">,
  totalDurationMs: number,
): TimelineRegion {
  const leftFraction = msToFraction(suggestion.startMs, totalDurationMs);
  const endFraction = msToFraction(suggestion.startMs + suggestion.durationMs, totalDurationMs);

  return { leftFraction, widthFraction: Math.max(0, endFraction - leftFraction) };
}

/**
 * A clip's stored window (in/out, in ms) → a timeline region (the committed,
 * Gold-Veil band the lane draws for an existing clip).
 */
export function clipToRegion(
  clip: { inMs: number; outMs: number },
  totalDurationMs: number,
): TimelineRegion {
  const leftFraction = msToFraction(clip.inMs, totalDurationMs);
  const endFraction = msToFraction(clip.outMs, totalDurationMs);

  return { leftFraction, widthFraction: Math.max(0, endFraction - leftFraction) };
}

/**
 * A hand-picked band (two edge fractions, in any order) → an ordered, whole-ms
 * `{ inMs, outMs }` window. The edges are sorted so a right-to-left drag still
 * yields in < out; `create_clip` rejects a non-positive window, so the caller
 * gates a zero-length band before posting.
 */
export function bandToWindow(
  edgeFractionA: number,
  edgeFractionB: number,
  totalDurationMs: number,
): { inMs: number; outMs: number } {
  const a = fractionToMs(edgeFractionA, totalDurationMs);
  const b = fractionToMs(edgeFractionB, totalDurationMs);

  return { inMs: Math.min(a, b), outMs: Math.max(a, b) };
}

/**
 * Drop a default in/out band of `clipLengthMs`, centred-forward from the playhead:
 * it starts at `playheadMs` and runs `clipLengthMs`, clamped so it never runs past
 * the set end (sliding the start back if needed). The keyboard `M` mark and the
 * "accept suggestion" both land here so every minted clip has a sane window.
 */
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
