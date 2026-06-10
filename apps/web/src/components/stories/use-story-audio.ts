// The Stories sound engine: one <audio> element for the official preview,
// routed through a Web Audio gain node so story changes fade instead of cut.
//
// Browsers block autoplay-with-sound, so the graph stays dormant until the
// first user gesture (swipe / tap / key) calls unlock(); from then on sound
// follows the active story without further gestures. Mute keeps the audio
// running at zero gain so the 30s preview stays the story clock either way.

import { useCallback, useRef, useState } from "react";
import { previewProxyUrl } from "@/lib/preview-player";

const fadeInSeconds = 0.4;
const fadeOutSeconds = 0.15;

type StoryAudioEngine = {
  /** Current track's audio element time/duration, as the story clock. */
  getClock: () => { duration: number; elapsed: number } | undefined;
  muted: boolean;
  pause: () => void;
  /** Start (or restart) the preview for a story; no-op until unlocked. */
  play: (idOrLogId: string | undefined, onEnded: () => void) => void;
  resume: () => void;
  stop: () => void;
  toggleMuted: () => void;
  /** Call from the first user gesture; idempotent. */
  unlock: () => void;
  unlocked: boolean;
};

export function useStoryAudio(): StoryAudioEngine {
  const audioRef = useRef<HTMLAudioElement | undefined>(undefined);
  const contextRef = useRef<AudioContext | undefined>(undefined);
  const gainRef = useRef<GainNode | undefined>(undefined);
  const onEndedRef = useRef<() => void>(() => {});
  const mutedRef = useRef(false);
  const [muted, setMuted] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const unlockedRef = useRef(false);

  const ensureGraph = useCallback((): HTMLAudioElement => {
    if (!audioRef.current) {
      const audio = new Audio();
      audio.preload = "auto";
      const context = new AudioContext();
      const gain = context.createGain();
      context.createMediaElementSource(audio).connect(gain);
      gain.connect(context.destination);
      audio.addEventListener("ended", () => onEndedRef.current());
      audioRef.current = audio;
      contextRef.current = context;
      gainRef.current = gain;
    }

    return audioRef.current;
  }, []);

  const fadeTo = useCallback((value: number, seconds: number) => {
    const context = contextRef.current;
    const gain = gainRef.current;

    if (!context || !gain) {
      return;
    }

    gain.gain.cancelScheduledValues(context.currentTime);
    gain.gain.setValueAtTime(gain.gain.value, context.currentTime);
    gain.gain.linearRampToValueAtTime(value, context.currentTime + seconds);
  }, []);

  const unlock = useCallback(() => {
    if (unlockedRef.current) {
      return;
    }

    unlockedRef.current = true;
    ensureGraph();
    void contextRef.current?.resume();
    setUnlocked(true);
  }, [ensureGraph]);

  const play = useCallback(
    (idOrLogId: string | undefined, onEnded: () => void) => {
      if (!unlockedRef.current) {
        return;
      }

      const audio = ensureGraph();
      onEndedRef.current = onEnded;

      if (!idOrLogId) {
        // No preview: fade out and idle; the story falls back to the timer clock.
        fadeTo(0, fadeOutSeconds);
        audio.pause();
        audio.removeAttribute("src");
        return;
      }

      fadeTo(0, 0);
      audio.src = previewProxyUrl(idOrLogId);
      audio.currentTime = 0;
      // A dead preview degrades to silence; playback errors just leave the
      // timer clock in charge.
      audio.play().catch(() => {});
      fadeTo(mutedRef.current ? 0 : 1, fadeInSeconds);
    },
    [ensureGraph, fadeTo],
  );

  const pause = useCallback(() => {
    audioRef.current?.pause();
  }, []);

  const resume = useCallback(() => {
    if (audioRef.current?.src) {
      audioRef.current.play().catch(() => {});
    }
  }, []);

  const stop = useCallback(() => {
    fadeTo(0, fadeOutSeconds);
    audioRef.current?.pause();
    audioRef.current?.removeAttribute("src");
  }, [fadeTo]);

  const toggleMuted = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    fadeTo(next ? 0 : 1, fadeInSeconds);
  }, [fadeTo]);

  const getClock = useCallback(() => {
    const audio = audioRef.current;

    if (!audio || !audio.src || audio.ended || !Number.isFinite(audio.duration)) {
      return undefined;
    }

    if (audio.duration <= 0 || (audio.paused && audio.currentTime === 0)) {
      return undefined;
    }

    return { duration: audio.duration, elapsed: audio.currentTime };
  }, []);

  return { getClock, muted, pause, play, resume, stop, toggleMuted, unlock, unlocked };
}
