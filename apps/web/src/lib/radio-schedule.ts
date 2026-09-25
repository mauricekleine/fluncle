import { SEGMENT_FLOOR_MS } from "@fluncle/contracts/util/radio-clock";

export {
  BOUNDARY_COMMIT_MS,
  type RadioBoundaryDecision,
  radioBoundaryDecision,
  SEGMENT_FLOOR_MS,
  SEGMENT_STALE_AFTER_MS,
} from "@fluncle/contracts/util/radio-clock";

export type RadioScheduleEntry = {
  logId: string;
  observationDurationMs: number;
  trackId: string;
};

export const OFFSET_SNAP_GRID_MS = 10_000;

export function segmentDurationMs(entry: RadioScheduleEntry): number {
  const raw = entry.observationDurationMs;

  if (!Number.isFinite(raw) || raw < SEGMENT_FLOOR_MS) {
    return SEGMENT_FLOOR_MS;
  }

  return Math.round(raw);
}

export function totalLoopDurationMs(entries: readonly RadioScheduleEntry[]): number {
  let total = 0;

  for (const entry of entries) {
    total += segmentDurationMs(entry);
  }

  return total;
}

export type RadioSlot = {
  currentDurationMs: number;
  currentIndex: number;
  current: RadioScheduleEntry;

  next: RadioScheduleEntry;
  nextIndex: number;
  offsetMs: number;
};

export function resolveRadioSlot(
  entries: readonly RadioScheduleEntry[],
  epochMs: number,
  nowMs: number,
): RadioSlot | undefined {
  if (entries.length === 0) {
    return undefined;
  }

  const total = totalLoopDurationMs(entries);

  const elapsed = nowMs - epochMs;
  const p = ((elapsed % total) + total) % total;

  let cumulative = 0;
  let index = entries.length - 1;
  let offsetMs = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    if (!entry) {
      continue;
    }

    const duration = segmentDurationMs(entry);

    if (p < cumulative + duration) {
      index = i;
      offsetMs = p - cumulative;
      break;
    }

    cumulative += duration;
  }

  const nextIndex = (index + 1) % entries.length;
  const current = entries[index];
  const next = entries[nextIndex];

  if (!current || !next) {
    return undefined;
  }

  return {
    current,
    currentDurationMs: segmentDurationMs(current),
    currentIndex: index,
    next,
    nextIndex,
    offsetMs,
  };
}

export function nextBoundaryEpochMs(
  currentEpochMs: number,
  oldLoopDurationMs: number,
  nowMs: number,
): number {
  if (oldLoopDurationMs <= 0) {
    return nowMs;
  }

  const elapsed = nowMs - currentEpochMs;

  if (elapsed <= 0) {
    return currentEpochMs;
  }

  const loopsToBoundary = Math.ceil(elapsed / oldLoopDurationMs);

  return currentEpochMs + loopsToBoundary * oldLoopDurationMs;
}

export const BREATHER_FADE_OUT_MS = 900;
export const BREATHER_FADE_IN_MS = 900;

export function breatherDimAt(offsetMs: number, segmentDurationMs: number): number {
  if (offsetMs < BREATHER_FADE_IN_MS) {
    return clamp01(1 - offsetMs / BREATHER_FADE_IN_MS);
  }

  const untilEnd = segmentDurationMs - offsetMs;

  if (untilEnd < BREATHER_FADE_OUT_MS) {
    return clamp01(1 - Math.max(0, untilEnd) / BREATHER_FADE_OUT_MS);
  }

  return 0;
}

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }

  return value > 1 ? 1 : value;
}

export function snapOffsetMs(offsetMs: number, gridMs: number = OFFSET_SNAP_GRID_MS): number {
  if (gridMs <= 0) {
    return Math.max(0, Math.floor(offsetMs));
  }

  return Math.max(0, Math.floor(offsetMs / gridMs) * gridMs);
}
