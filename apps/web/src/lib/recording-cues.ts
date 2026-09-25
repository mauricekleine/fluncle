import { type RecordingTracklistItem } from "@fluncle/contracts/orpc";

export type NewCue = {
  artists: string[];
  findingId?: string;
  title: string;
};

export type RecordingCueProgress = {
  marked: number;
  total: number;
};

export function parseArtists(value: string): string[] {
  return value
    .split(",")
    .map((artist) => artist.trim())
    .filter((artist) => artist.length > 0);
}

export function addCue(
  tracklist: RecordingTracklistItem[],
  cue: NewCue,
  makeId: () => string = () => crypto.randomUUID(),
): RecordingTracklistItem[] {
  const title = cue.title.trim();

  if (!title) {
    return tracklist;
  }

  const next: RecordingTracklistItem = { artists: cue.artists, id: makeId(), title };

  if (cue.findingId) {
    next.findingId = cue.findingId;
  }

  return [...tracklist, next];
}

export function markCue(
  tracklist: RecordingTracklistItem[],
  id: string,
  startMs: number,
): RecordingTracklistItem[] {
  const at = Math.max(0, Math.round(startMs));

  return tracklist.map((cue) => (cue.id === id ? { ...cue, startMs: at } : cue));
}

export function clearCue(
  tracklist: RecordingTracklistItem[],
  id: string,
): RecordingTracklistItem[] {
  return tracklist.map((cue) => {
    if (cue.id !== id) {
      return cue;
    }

    const { startMs: _dropped, ...rest } = cue;

    return rest;
  });
}

export function editCue(
  tracklist: RecordingTracklistItem[],
  id: string,
  patch: Partial<NewCue>,
): RecordingTracklistItem[] {
  return tracklist.map((cue) => {
    if (cue.id !== id) {
      return cue;
    }

    const title = patch.title !== undefined ? patch.title.trim() : cue.title;
    const next: RecordingTracklistItem = {
      ...cue,
      artists: patch.artists ?? cue.artists,
      title: title || cue.title,
    };

    if (patch.findingId !== undefined) {
      if (patch.findingId) {
        next.findingId = patch.findingId;
      } else {
        delete next.findingId;
      }
    }

    return next;
  });
}

export function removeCue(
  tracklist: RecordingTracklistItem[],
  id: string,
): RecordingTracklistItem[] {
  return tracklist.filter((cue) => cue.id !== id);
}

export function recordingCueProgress(tracklist: RecordingTracklistItem[]): RecordingCueProgress {
  return {
    marked: tracklist.filter((cue) => cue.startMs != null).length,
    total: tracklist.length,
  };
}
