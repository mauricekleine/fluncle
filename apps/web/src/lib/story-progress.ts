import { isVideoPlayable } from "@/lib/use-video-recovery";

export const FALLBACK_DURATION_MS = 8_000;

export type StoryProgressSnapshot = {
  hasClip: boolean;

  readyState: number;

  duration: number;

  currentTime: number;

  fallbackElapsedMs: number;
};

export type StoryProgressVerdict = {
  progress: number;

  finished: boolean;

  loading: boolean;
};

function clipVerdict(snapshot: StoryProgressSnapshot): StoryProgressVerdict {
  if (!isVideoPlayable({ readyState: snapshot.readyState })) {
    return { finished: false, loading: true, progress: 0 };
  }

  if (!(Number.isFinite(snapshot.duration) && snapshot.duration > 0)) {
    return { finished: false, loading: false, progress: 0 };
  }

  const progress = Math.min(1, snapshot.currentTime / snapshot.duration);

  return { finished: progress >= 0.999, loading: false, progress };
}

function fallbackVerdict(snapshot: StoryProgressSnapshot): StoryProgressVerdict {
  const progress = Math.min(1, snapshot.fallbackElapsedMs / FALLBACK_DURATION_MS);

  return { finished: progress >= 1, loading: false, progress };
}

export function storyProgress(snapshot: StoryProgressSnapshot): StoryProgressVerdict {
  return snapshot.hasClip ? clipVerdict(snapshot) : fallbackVerdict(snapshot);
}
