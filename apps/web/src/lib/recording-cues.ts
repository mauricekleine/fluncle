// The recording cue-authoring logic (RFC recording-primitive, Design B — Wave 3). A
// RECORDING starts with an EMPTY tracklist: unlike a mixtape (whose cue rail only MARKS a
// pre-existing catalogue tracklist), the operator AUTHORS a recording's cues from scratch
// — type a track (artist(s) + title), mark it at the playhead, edit or remove it. Each
// cue is a `RecordingTracklistItem` (`{ id, artists, title, startMs? }`) keyed by its
// stable `id`; the whole array persists via `update_recording`. These pure, DOM-free
// helpers own every array transform so the editor stays a thin view and the logic is
// unit-tested without React or a `<video>`. This tracklist drives the changing on-screen
// Track-ID overlay on the clip cut (`resolveClipTracks` reads it) and seeds the mixtape
// on `promote`.

import { type RecordingTracklistItem } from "@fluncle/contracts/orpc";

/** A fresh cue's authored text — what the add-a-track form collects. */
export type NewCue = {
  artists: string[];
  title: string;
};

/** Progress across a recording's cues: how many carry a `startMs` out of the total. */
export type RecordingCueProgress = {
  marked: number;
  total: number;
};

/**
 * Split a free-text artist field into the `artists` array — comma-separated, trimmed,
 * blanks dropped. `"Alix Perez, Monty"` → `["Alix Perez", "Monty"]`; `""` → `[]`.
 */
export function parseArtists(value: string): string[] {
  return value
    .split(",")
    .map((artist) => artist.trim())
    .filter((artist) => artist.length > 0);
}

/**
 * Append a new cue (a fresh `id`, no `startMs` yet) to the tracklist. The title is
 * trimmed; the artists are already parsed. Returns a new array (never mutates). The
 * caller marks it at the playhead afterward. A blank title yields the list unchanged —
 * the view guards this, but the helper is defensive too.
 */
export function addCue(
  tracklist: RecordingTracklistItem[],
  cue: NewCue,
  makeId: () => string = () => crypto.randomUUID(),
): RecordingTracklistItem[] {
  const title = cue.title.trim();

  if (!title) {
    return tracklist;
  }

  return [...tracklist, { artists: cue.artists, id: makeId(), title }];
}

/** Set one cue's `startMs` (the playhead), keyed by `id`. Returns a new array. */
export function markCue(
  tracklist: RecordingTracklistItem[],
  id: string,
  startMs: number,
): RecordingTracklistItem[] {
  const at = Math.max(0, Math.round(startMs));

  return tracklist.map((cue) => (cue.id === id ? { ...cue, startMs: at } : cue));
}

/** Clear one cue's `startMs` (back to unmarked), keyed by `id`. Returns a new array. */
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

/**
 * Edit a cue's authored text (artist(s) and/or title), keyed by `id`. A title given as
 * blank is ignored (a cue must keep a title); the `startMs` is untouched. Returns a new
 * array.
 */
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

    return {
      ...cue,
      artists: patch.artists ?? cue.artists,
      title: title || cue.title,
    };
  });
}

/** Remove a cue entirely, keyed by `id`. Returns a new array. */
export function removeCue(
  tracklist: RecordingTracklistItem[],
  id: string,
): RecordingTracklistItem[] {
  return tracklist.filter((cue) => cue.id !== id);
}

/** How many cues carry a `startMs`, out of the total (drives the rail's header). */
export function recordingCueProgress(tracklist: RecordingTracklistItem[]): RecordingCueProgress {
  return {
    marked: tracklist.filter((cue) => cue.startMs != null).length,
    total: tracklist.length,
  };
}
