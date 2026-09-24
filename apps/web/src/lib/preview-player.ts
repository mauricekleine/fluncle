// One shared <audio> element for the app's in-place previews, so starting a
// preview anywhere stops the one already playing. Playback goes through the
// /api/preview proxy (official Deezer/iTunes previews only): the stored Deezer
// URLs carry expiring tokens, so the server re-resolves them on demand.
//
// useSyncExternalStore over module state keeps this a plain singleton instead
// of a context provider threaded through the feed. Four independent stores share
// the one element, split by how often they change and who reads them:
//
//   - STATUS (which track, playing/paused/loading) — every play control reads it,
//     each through a per-row selector that returns a primitive, so a row
//     re-renders only when ITS state changes;
//   - QUEUE (the list being played, the position in it, whether it ran out) —
//     only the player bar reads it;
//   - PROGRESS (elapsed/total) — only the bars read it, so the ~4Hz timeupdate
//     never re-renders a previewable row;
//   - MISSES (tracks whose preview came back empty) — a row reads its own bit to
//     dim its play glyph.
//
// THE LIST IS THE QUEUE. Play on any row of a list hands the whole list to
// `playQueue` from that row; the element's `ended` advances to the next track,
// and the end of the list stops and offers one way on ("keep going": the last
// track's sonic neighbours, or the next page of a paginated list). Nothing plays
// that the listener did not start. A track whose preview is missing is skipped
// and remembered, so its row can dim.
//
// ONE SOUND AT A TIME. Any other audible media element on the page (Stories, the
// radio, a video someone unmutes) pauses the preview the moment it starts, and
// the chrome pauses it on the way into a surface that never shows the bar.
//
// SOUND STARTS ONLY ON A LIVE INTENT. There are exactly three ways a preview starts: a press
// (a row's cover, the bar, a key, the lock screen while the preview holds the session); the list
// the listener started running on (a clip ending, a missing clip skipped), which moves on only
// while the intent that started the current clip is still the latest; and a continuation ("keep
// going": a sonic search or a next-page hand-off) honoured only under the intent that asked for
// it. A pause (the page's, the OS's, a headset's), a close and any competing sound supersede that
// intent, so an `ended` or `error` event that arrives after one of them moves nothing. The player
// lives across pages, so moving to another page is not a new intent: a sonic "keep going" still
// waiting plays where the listener is, like a clip that keeps playing. A next-page hand-off plays
// only on the page it asked for.

import { useCallback, useSyncExternalStore } from "react";
import {
  emitDiscoveryEvent,
  shouldEmitDiscoveryPreview,
  type StartPreviewOptions,
} from "./discovery-emit";

export type { StartPreviewOptions };

function previewProxyUrl(idOrLogId: string): string {
  return `/api/preview/${encodeURIComponent(idOrLogId)}`;
}

export type PreviewStatus = "idle" | "loading" | "paused" | "playing";

type PreviewState = {
  status: PreviewStatus;
  trackId?: string;
};

const idleState: PreviewState = { status: "idle" };

type PreviewProgress = {
  currentTime: number;
  duration: number;
};

const idleProgress: PreviewProgress = { currentTime: 0, duration: 0 };

/**
 * Exactly what the player bar needs to show and act on one queued track. `id` is the preview
 * relay key (a trackId, or a logId for a finding-only caller); everything else is display and
 * the playing track's actions. Built by each list from its own row type, so the store never
 * learns a surface's DTO.
 */
export type QueueTrack = {
  artists: string[];
  coverUrl?: string;
  /** The track's own page on fluncle.com: `/log/<id>` for a finding, `/track/<id>` otherwise. */
  href?: string;
  id: string;
  /** A finding (lit) or a catalogue track (unlit): the bar spends no gold on an unlit one. */
  lit?: boolean;
  spotifyUrl?: string;
  title: string;
};

/**
 * The one way on when a list runs out. `similar` asks the archive for the last track's sonic
 * neighbours; `page` walks to the next page of a paginated list and plays it from the top.
 */
export type QueueContinuation = { href: string; kind: "page" } | { kind: "similar" };

export type QueueState = {
  continuation?: QueueContinuation;
  /** The list ran out: the bar offers "keep going" instead of next. */
  ended: boolean;
  index: number;
  tracks: QueueTrack[];
};

/** A consecutive-miss ceiling, so a list of dead previews stops instead of skipping forever. */
const MAX_CONSECUTIVE_MISSES = 5;

let audio: HTMLAudioElement | undefined;
let pendingPublicPreview = false;
let state: PreviewState = idleState;
let progress: PreviewProgress = idleProgress;
let queue: QueueState | undefined;
let misses: ReadonlySet<string> = new Set();
let consecutiveMisses = 0;
// Every start bumps the token, so a late error or play() rejection from a clip that has since
// been replaced never acts on the one that replaced it.
let loadToken = 0;
// Every play() attempt gets its own number, and a pause cancels the attempt in flight: the
// browser rejects an interrupted play() with an AbortError, and that rejection is a cancellation,
// never a missing preview.
let playAttempt = 0;
// THE LISTENER'S INTENT. Every playback action (a start, a pause, a resume, a close, a "keep
// going") and every competing sound (Stories, the radio, a surface that never shows the player)
// bumps the generation, WHETHER OR NOT anything is playing at that moment. A continuation (a "keep
// going" search awaiting the archive, a next-page hand-off awaiting its page) carries the
// generation it was asked under and acts only if nothing has happened since: nothing ever starts
// sound on an intent the listener has already moved past.
let playbackGeneration = 0;

/** The most a next-page hand-off waits for its page before it lapses. */
const PAGE_HANDOFF_TTL_MS = 30_000;

type PageHandoff = { at: number; generation: number; href: string };

let pendingPageContinuation: PageHandoff | undefined;

// The generation the current clip was asked to sound under (a start or a resume). The list moves
// on by itself (`ended`, a missing clip skipped) only while it is still the latest one.
let soundingGeneration = -1;

function soundStillWanted(): boolean {
  return soundingGeneration === playbackGeneration;
}

/** A new intent: every continuation asked under an older one lapses, idle or not. */
function supersedeIntent(): void {
  playbackGeneration += 1;
  pendingPageContinuation = undefined;
}
const listeners = new Set<() => void>();
const progressListeners = new Set<() => void>();
const queueListeners = new Set<() => void>();
const missListeners = new Set<() => void>();

function notify(set: Set<() => void>): void {
  for (const listener of set) {
    listener();
  }
}

function emit(next: PreviewState): void {
  state = next;
  notify(listeners);
  syncMediaSessionState();
}

function emitProgress(next: PreviewProgress): void {
  progress = next;
  notify(progressListeners);
}

function emitQueue(next: QueueState | undefined): void {
  queue = next;
  notify(queueListeners);
  syncMediaSessionMetadata();
  syncMediaSessionState();
}

function markMissing(trackId: string): void {
  if (misses.has(trackId)) {
    return;
  }

  misses = new Set([...misses, trackId]);
  notify(missListeners);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

function subscribeProgress(listener: () => void): () => void {
  progressListeners.add(listener);

  return () => progressListeners.delete(listener);
}

function subscribeQueue(listener: () => void): () => void {
  queueListeners.add(listener);

  return () => queueListeners.delete(listener);
}

function subscribeMisses(listener: () => void): () => void {
  missListeners.add(listener);

  return () => missListeners.delete(listener);
}

/** The DOMException name of a rejected play(), whatever realm or prototype it arrived with. */
function errorName(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "name" in error
    ? String((error as { name: unknown }).name)
    : undefined;
}

/**
 * One play() attempt on the shared element. An interrupted attempt (a pause, a new source)
 * rejects with an AbortError: a cancellation the caller already handled, so it does nothing.
 * Autoplay refusal leaves the clip waiting, paused, for a tap. Anything else is a clip that
 * cannot play.
 */
function attemptPlay(element: HTMLAudioElement, trackId: string | undefined): void {
  playAttempt += 1;

  const attempt = playAttempt;
  const token = loadToken;

  claimMediaSession();
  silenceOtherMedia();
  element.play().catch((error: unknown) => {
    const name = errorName(error);

    if (attempt !== playAttempt || token !== loadToken || name === "AbortError") {
      return;
    }

    if (name === "NotAllowedError") {
      pendingPublicPreview = false;
      emit({ status: "paused", trackId });

      return;
    }

    failCurrent(token);
  });
}

function readTime(): PreviewProgress {
  if (!audio) {
    return idleProgress;
  }

  return {
    currentTime: audio.currentTime,
    duration: Number.isFinite(audio.duration) ? audio.duration : 0,
  };
}

function stop(): void {
  pendingPublicPreview = false;
  loadToken += 1;
  playAttempt += 1;
  supersedeIntent();
  audio?.pause();
  audio?.removeAttribute("src");
  emit(idleState);
  emitProgress(idleProgress);
}

// The current clip finished. Inside a queue the next track starts; at the end of the list the
// bar keeps its place and offers the way on. Outside a queue the preview simply stops.
function onEnded(): void {
  // An end the listener has already moved past (they paused, closed the player, pressed for more,
  // or another sound started before this event ran): the list does not move. The clip did stop,
  // so a store that still says it is sounding learns it is paused at its end.
  if (!soundStillWanted()) {
    if (state.status === "playing" || state.status === "loading") {
      emit({ status: "paused", trackId: state.trackId });
    }

    return;
  }

  if (!queue) {
    stop();

    return;
  }

  consecutiveMisses = 0;
  advance();
}

function advance(): void {
  if (!queue) {
    return;
  }

  const next = queue.index + 1;

  if (next < queue.tracks.length) {
    playAt(next);

    return;
  }

  stop();
  emitQueue({ ...queue, ended: true });
}

// A clip that cannot play. A queued track is remembered as missing and the queue moves on;
// anything else returns to idle. Never a thrown error up the chain.
function failCurrent(token: number): void {
  if (token !== loadToken) {
    return;
  }

  pendingPublicPreview = false;

  const trackId = state.trackId;

  if (trackId) {
    markMissing(trackId);
  }

  // The listener paused this clip while it was still arriving, closed the player, or another sound
  // started: it is remembered as missing, but the queue never moves on without them.
  if (state.status === "paused" || !soundStillWanted()) {
    return;
  }

  if (queue && queue.tracks[queue.index]?.id === trackId) {
    consecutiveMisses += 1;

    if (consecutiveMisses < MAX_CONSECUTIVE_MISSES) {
      advance();

      return;
    }
  }

  consecutiveMisses = 0;

  if (state.status !== "idle") {
    emit(idleState);
    emitProgress(idleProgress);
  }
}

/**
 * A pause the player did not ask for: the OS, a headset, the browser. The element says paused
 * while the store still thinks the preview is sounding or arriving, which no request of the
 * player's own ever leaves behind (its pauses and closes settle the store before any event runs).
 * That pause is the listener's newest intent in EVERY status, a clip still arriving included: the
 * attempt in flight is cancelled and nothing queued behind it (an `ended`, an `error`, a waiting
 * "keep going") moves the player again.
 *
 * A pause reported once the clip has reached its end is the end's own pause (the browser pauses a
 * finished clip in the same task that fires `ended`), so it is left to `ended`. An element-level
 * pause landing in the instant between the clip reaching its end and that task cannot be told
 * apart from it; the lock screen and headset buttons reach the player through the Media Session
 * handlers instead, which pause through `pausePreview` and win outright.
 */
function noticeUnrequestedPause(element: HTMLAudioElement): void {
  if (!element.paused || element.ended) {
    return;
  }

  if (state.status === "playing" || state.status === "loading") {
    supersedeIntent();
    playAttempt += 1;
    emit({ status: "paused", trackId: state.trackId });
  }
}

/**
 * A continuation is about to act: first settle a pause the element already shows but whose
 * notification has not run yet, so an answer that lands in between never starts over it.
 */
function noticeLivePause(): void {
  if (audio) {
    noticeUnrequestedPause(audio);
  }
}

function ensureAudio(): HTMLAudioElement {
  if (audio) {
    return audio;
  }

  const element = new Audio();
  element.preload = "none";
  // Every media notification is a queued task, delivered after whatever the listener did in
  // between. So each handler first reads the element's LIVE state: it settles a pause the player
  // never asked for, then acts only when the element still says what the notification claims.
  // (Tasks from a replaced source never arrive: a new `src` drops them.)
  element.addEventListener("ended", () => {
    noticeUnrequestedPause(element);

    // The clip was restarted or replaced since it ended: this end is obsolete.
    if (!element.ended) {
      return;
    }

    onEnded();
  });
  element.addEventListener("error", () => {
    noticeUnrequestedPause(element);

    // A newer load has cleared the failure this notification reports.
    if (element.error === null) {
      return;
    }

    // A dead preview degrades to silence (or to the next track in a queue).
    failCurrent(loadToken);
  });
  element.addEventListener("playing", () => {
    noticeUnrequestedPause(element);

    // A late `playing` from an attempt that has since been paused, closed or finished reports
    // nothing: the element itself says it is not sounding, or the intent behind it has lapsed.
    if (element.paused || element.ended || !soundStillWanted()) {
      return;
    }

    emit({ status: "playing", trackId: state.trackId });
    consecutiveMisses = 0;

    if (pendingPublicPreview) {
      pendingPublicPreview = false;
      emitDiscoveryEvent("discovery_preview");
    }
  });
  element.addEventListener("pause", () => {
    noticeUnrequestedPause(element);
  });
  element.addEventListener("timeupdate", () => emitProgress(readTime()));
  element.addEventListener("loadedmetadata", () => emitProgress(readTime()));
  element.addEventListener("durationchange", () => emitProgress(readTime()));
  audio = element;
  installOneSoundGuard();

  return element;
}

// `src` overrides the default preview proxy: the admin quarantine lens auditions the CAPTURED
// bytes (`/api/v1/admin/tracks/:id/source-audio`) through this same singleton, so starting a
// captured audition stops a preview and vice versa. One element, one thing playing, everywhere.
// Public visitor previews pass `publicPreview: true`. Admin starts omit it, even when they also
// omit `src` and use the public proxy. The event fires only after playback actually starts.
// A bare start leaves any queue behind: the bar belongs to lists and to callers that name their
// track (`playQueue`, or `usePreviewPlayer` with a `track`).
export function startPreview(trackId: string, options?: StartPreviewOptions): void {
  if (queue) {
    emitQueue(undefined);
  }

  load(trackId, options);
}

function load(trackId: string, options?: StartPreviewOptions): void {
  pendingPublicPreview = shouldEmitDiscoveryPreview(options);

  const element = ensureAudio();
  loadToken += 1;
  supersedeIntent();
  soundingGeneration = playbackGeneration;

  element.src = options?.src ?? previewProxyUrl(trackId);
  emit({ status: "loading", trackId });
  emitProgress(idleProgress);
  attemptPlay(element, trackId);
}

function playAt(index: number): void {
  if (!queue) {
    return;
  }

  const track = queue.tracks[index];

  if (!track) {
    return;
  }

  emitQueue({ ...queue, ended: false, index });
  load(track.id, { publicPreview: true });
}

/**
 * Play a list from one of its rows: the list becomes the queue, in its own order, starting at
 * `startIndex`. Always a public preview — the rows that hand over a list are visitor controls.
 */
export function playQueue(
  tracks: QueueTrack[],
  startIndex: number,
  options?: { continuation?: QueueContinuation },
): void {
  if (tracks.length === 0) {
    return;
  }

  const index = Math.min(Math.max(0, startIndex), tracks.length - 1);

  consecutiveMisses = 0;
  emitQueue({ continuation: options?.continuation, ended: false, index, tracks });
  load(tracks[index]?.id ?? "", { publicPreview: true });
}

// The feed toggle: the same track playing → stop; anything else → start.
// Used by the note-dialog preview (admin), which never pauses.
function toggle(trackId: string, options?: StartPreviewOptions): void {
  if (state.trackId === trackId && state.status !== "idle") {
    stop();

    return;
  }

  startPreview(trackId, options);
}

// Pause/resume the CURRENT preview in place (the bars + row overlays): the clip keeps its
// position so a resume picks up where it left off. A clip still arriving is paused too: the
// attempt in flight is cancelled and nothing starts behind the listener's back. A no-op while idle.
function pauseResume(): void {
  if (!audio) {
    return;
  }

  if (state.status === "playing" || state.status === "loading") {
    pausePreview();

    return;
  }

  if (state.status === "paused") {
    supersedeIntent();
    soundingGeneration = playbackGeneration;
    emit({ status: "loading", trackId: state.trackId });
    attemptPlay(audio, state.trackId);
  }
}

/**
 * Pause whatever is playing or still arriving, keeping its place (the one-sound rule, the
 * chromeless surfaces, the player's own Pause). The play() attempt in flight is cancelled, so its
 * AbortError is never read as a missing preview. Even with nothing sounding, a pause is a new
 * intent: a "keep going" still waiting on the archive or on its next page lapses with it.
 */
export function pausePreview(): void {
  supersedeIntent();

  if (audio && (state.status === "playing" || state.status === "loading")) {
    playAttempt += 1;
    audio.pause();
    emit({ status: "paused", trackId: state.trackId });
  }
}

/**
 * The player's play/pause: pause a playing clip, resume a paused one, and from idle restart the
 * queue's current track (a list that ran out plays its last track again).
 */
export function togglePlayback(): void {
  if (state.status === "playing" || state.status === "loading" || state.status === "paused") {
    pauseResume();

    return;
  }

  if (state.status === "idle" && queue) {
    playAt(queue.index);
  }
}

/** Skip to the next track in the queue. At the end of the list it stops and offers the way on. */
export function skipNext(): void {
  if (queue) {
    consecutiveMisses = 0;
    advance();
  }
}

/** Back to the previous track in the queue; on the first track it restarts it. */
export function skipPrevious(): void {
  if (!queue) {
    return;
  }

  // Past the first few seconds, "previous" means "from the top" — the transport convention.
  if (audio && audio.currentTime > 3) {
    audio.currentTime = 0;

    return;
  }

  playAt(Math.max(0, queue.index - 1));
}

/** Stop the current preview (used when its row leaves the set). */
export function stopPreview(): void {
  stop();
}

/** Close the player: the sound stops and the bar goes away until the next play. */
export function dismissPlayer(): void {
  stop();
  emitQueue(undefined);
  releaseMediaSession();
}

/**
 * The listener asked for more at the end of a list. `similar` fetches the last track's sonic
 * neighbours through `loadSimilar` (the caller owns the fetch, so this module stays free of
 * search); `page` leaves the navigation to the caller and arms a one-shot hand-off that the next
 * page's list consumes to start itself from the top.
 */
export type KeepGoingOutcome = "moved" | "none" | "stale";

export async function keepGoing(options: {
  loadSimilar: (last: QueueTrack) => Promise<QueueTrack[]>;
  navigate: (href: string) => void;
}): Promise<KeepGoingOutcome> {
  if (!queue) {
    return "none";
  }

  // The press is itself the newest intent: it supersedes any earlier continuation still waiting.
  supersedeIntent();

  const asked = queue;
  const generation = playbackGeneration;

  const continuation = queue.continuation ?? { kind: "similar" };

  if (continuation.kind === "page") {
    pendingPageContinuation = { at: Date.now(), generation, href: continuation.href };
    options.navigate(continuation.href);

    return "moved";
  }

  const last = asked.tracks[asked.tracks.length - 1];

  if (!last) {
    return "none";
  }

  const heard = new Set(asked.tracks.map((track) => track.id));
  const found = await options.loadSimilar(last);

  noticeLivePause();

  // The listener moved on while the archive answered (closed the player, pressed play elsewhere,
  // paused): the late answer stands down and changes nothing.
  if (queue !== asked || playbackGeneration !== generation) {
    return "stale";
  }

  const next = found.filter((track) => !heard.has(track.id));

  if (next.length === 0) {
    return "none";
  }

  playQueue(next, 0, { continuation: { kind: "similar" } });

  return "moved";
}

/**
 * A list mounting under `href` claims a pending page hand-off: true once, for the page the
 * previous list asked for, so the new page plays from its first row. It is honoured only while
 * the intent that asked for it is still the listener's latest (no close, no newer start, no pause,
 * no competing sound since) and only for a short while: a hand-off never starts sound on a page
 * the listener reached some other way, later. Pure bookkeeping; the list starts itself.
 */
export function claimPageContinuation(href: string): boolean {
  noticeLivePause();

  const handoff = pendingPageContinuation;

  pendingPageContinuation = undefined;

  return (
    handoff !== undefined &&
    handoff.generation === playbackGeneration &&
    Date.now() - handoff.at <= PAGE_HANDOFF_TTL_MS &&
    samePath(handoff.href, href)
  );
}

/**
 * The listener arrived somewhere: a hand-off for any OTHER page lapses (they went elsewhere). The
 * page it was asked for claims it first, from its own list's mount. A sonic "keep going" is not a
 * page hand-off and is untouched: the player lives across pages, so it plays where they are.
 */
export function expirePageContinuation(href: string): void {
  if (pendingPageContinuation !== undefined && !samePath(pendingPageContinuation.href, href)) {
    pendingPageContinuation = undefined;
  }
}

function samePath(a: string, b: string): boolean {
  try {
    const base = "https://fluncle.invalid";
    const left = new URL(a, base);
    const right = new URL(b, base);

    return left.pathname === right.pathname && left.search === right.search;
  } catch {
    return a === b;
  }
}

export function usePreviewPlayer(
  trackId: string,
  options?: StartPreviewOptions & { track?: QueueTrack },
): {
  isActive: boolean;
  isLoading: boolean;
  toggle: () => void;
} {
  const status = usePreviewStatus(trackId);
  const publicPreview = options?.publicPreview === true;
  const src = options?.src;
  const track = options?.track;

  return {
    isActive: status === "playing" || status === "loading",
    isLoading: status === "loading",
    toggle: useCallback(() => {
      // A caller that names its track joins the player: the bar shows it and carries its
      // actions. Pause keeps the place; a second tap resumes.
      if (track && publicPreview) {
        if (state.trackId === trackId && state.status !== "idle") {
          pauseResume();

          return;
        }

        playQueue([track], 0);

        return;
      }

      toggle(trackId, { publicPreview, src });
    }, [publicPreview, src, track, trackId]),
  };
}

/**
 * One row's own status: `idle` unless this track is the current one. Returns a primitive, so a
 * list of fifty rows re-renders only the two whose state changed.
 */
export function usePreviewStatus(trackId: string | undefined): PreviewStatus {
  return useSyncExternalStore(
    subscribe,
    () => (trackId !== undefined && state.trackId === trackId ? state.status : "idle"),
    () => "idle",
  );
}

/** Whether this track's preview has come back empty this visit (its play glyph dims). */
export function usePreviewMissing(trackId: string | undefined): boolean {
  return useSyncExternalStore(
    subscribeMisses,
    () => trackId !== undefined && misses.has(trackId),
    () => false,
  );
}

// For a surface with MANY previewable rows (the /mix chain + candidate rails):
// subscribe once and compare the active id per row, instead of one hook per row.
// `start`/`pauseResume` are the shared singleton, so starting one preview stops any
// other, and pause/resume acts on whatever is current.
export function usePreviewControls(): {
  activeTrackId: string | undefined;
  pauseResume: () => void;
  start: typeof startPreview;
  status: PreviewStatus;
} {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => state,
    () => idleState,
  );

  return {
    activeTrackId: snapshot.status === "idle" ? undefined : snapshot.trackId,
    pauseResume,
    start: startPreview,
    status: snapshot.status,
  };
}

/** The whole player state for the bar: the queue and the current status. */
export function usePlayerQueue(): QueueState | undefined {
  return useSyncExternalStore(
    subscribeQueue,
    () => queue,
    () => undefined,
  );
}

/** A plain read of the whole player, outside React (tests and one-off checks). */
export function readPlayer(): {
  missing: ReadonlySet<string>;
  queue: QueueState | undefined;
  status: PreviewStatus;
  trackId: string | undefined;
} {
  return { missing: misses, queue, status: state.status, trackId: state.trackId };
}

/** Drop the shared element so the next start constructs a fresh Audio (tests). */
export function resetPreviewPlayer(): void {
  stop();
  audio = undefined;
  queue = undefined;
  misses = new Set();
  consecutiveMisses = 0;
  pendingPageContinuation = undefined;
  oneSoundGuardInstalled = false;
  mediaSessionOwned = false;
  playAttempt = 0;
  playbackGeneration = 0;
  soundingGeneration = -1;
}

/** Elapsed/total seconds of the current preview — the bars' own clock. */
export function usePreviewProgress(): PreviewProgress {
  return useSyncExternalStore(
    subscribeProgress,
    () => progress,
    () => idleProgress,
  );
}

// ── ONE SOUND AT A TIME ──────────────────────────────────────────────────────────────────────
// Media events do not bubble, but they do run the capture phase, so one document listener hears
// every <video>/<audio> on the page. Only an AUDIBLE start counts: the log page's muted footage
// loop and the radio's muted pre-roll never pause the preview; someone unmuting one does.

let oneSoundGuardInstalled = false;

function onOtherMedia(event: Event): void {
  const target = event.target;

  if (
    typeof HTMLMediaElement === "undefined" ||
    !(target instanceof HTMLMediaElement) ||
    target === audio
  ) {
    return;
  }

  // Another sound started, audibly: the preview pauses (if it was sounding) and every continuation
  // still waiting lapses, so nothing the listener asked for earlier starts over it.
  if (!target.paused && !target.muted && target.volume > 0) {
    pausePreview();
    // The other sound owns the lock screen and the headset buttons now; a stray Play there must
    // not bring the preview back over it.
    releaseMediaSession();
  }
}

/**
 * The preview is about to sound: any other audible media on the page stops first, so resuming a
 * preview (from the bar, a row, or the keyboard) never plays over Stories or a video.
 */
function silenceOtherMedia(): void {
  if (typeof document === "undefined" || typeof HTMLMediaElement === "undefined") {
    return;
  }

  for (const element of Array.from(document.querySelectorAll("audio, video"))) {
    if (
      element instanceof HTMLMediaElement &&
      element !== audio &&
      !element.paused &&
      !element.muted
    ) {
      element.pause();
    }
  }
}

function installOneSoundGuard(): void {
  if (oneSoundGuardInstalled || typeof document === "undefined") {
    return;
  }

  oneSoundGuardInstalled = true;
  document.addEventListener("play", onOtherMedia, true);
  document.addEventListener("playing", onOtherMedia, true);
  document.addEventListener("volumechange", onOtherMedia, true);
}

// ── MEDIA SESSION ────────────────────────────────────────────────────────────────────────────
// The lock screen and the headset buttons: the playing track's metadata and the transport that
// matches the bar (play, pause, next, previous). Feature-detected; a browser without the API
// simply has no lock-screen controls.

// The session belongs to whichever sound is live. The preview claims it each time it starts or
// resumes and gives it up when other audio takes over or the player closes, so the lock screen's
// Play never resumes a preview over the radio or a story.
let mediaSessionOwned = false;

const MEDIA_SESSION_ACTIONS: MediaSessionAction[] = ["play", "pause", "nexttrack", "previoustrack"];

function mediaSession(): MediaSession | undefined {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
    return undefined;
  }

  return navigator.mediaSession;
}

function setMediaSessionHandlers(session: MediaSession, own: boolean): void {
  const handlers: Record<string, () => void> = {
    nexttrack: skipNext,
    pause: pausePreview,
    play: togglePlayback,
    previoustrack: skipPrevious,
  };

  for (const action of MEDIA_SESSION_ACTIONS) {
    try {
      session.setActionHandler(action, own ? (handlers[action] ?? null) : null);
    } catch {
      // An action this browser does not support is simply absent from its controls.
    }
  }
}

function claimMediaSession(): void {
  const session = mediaSession();

  if (!session) {
    return;
  }

  if (!mediaSessionOwned) {
    mediaSessionOwned = true;
    setMediaSessionHandlers(session, true);
  }

  syncMediaSessionMetadata();
}

function releaseMediaSession(): void {
  const session = mediaSession();

  if (!session || !mediaSessionOwned) {
    return;
  }

  mediaSessionOwned = false;
  setMediaSessionHandlers(session, false);
  session.metadata = null;
  session.playbackState = "none";
}

function syncMediaSessionMetadata(): void {
  const session = mediaSession();

  if (!session || !mediaSessionOwned || typeof MediaMetadata === "undefined") {
    return;
  }

  const track = queue?.tracks[queue.index];

  if (!track) {
    session.metadata = null;

    return;
  }

  session.metadata = new MediaMetadata({
    artist: track.artists.join(", "),
    artwork: track.coverUrl ? [{ src: track.coverUrl }] : [],
    title: track.title,
  });
}

function syncMediaSessionState(): void {
  const session = mediaSession();

  if (!session || !mediaSessionOwned) {
    return;
  }

  // A list that ran out still holds its place (the bar keeps the last track and its way on), so
  // the lock screen reads paused rather than empty until the player is closed.
  session.playbackState =
    state.status === "playing" || state.status === "loading"
      ? "playing"
      : state.status === "paused" || queue !== undefined
        ? "paused"
        : "none";
}
