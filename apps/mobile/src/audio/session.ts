// The audio-session coordinator (RFC Unit 2, extended for radio). One session for the
// whole app, and one FLOOR that never sounds twice at once. Two rules live here:
//
// 1. The session config. The feed is a feed, not a music app: it interrupts other
//    apps while a visible card sounds and never plays in the background. The radio is
//    the lean-back exception — it keeps playing past a lock/background, so it takes a
//    different mode (and drives the lock-screen now-playing controls in the screen).
//
// 2. The single audio floor across surfaces (tabs). The visible-card-only invariant is
//    enforced WITHIN the feed (only the active card calls play); this bus extends it
//    ACROSS the tabs so the radio and the feed never sound together. Every surface that
//    makes sound registers a pause handler here (the feed cards already do, via
//    `useBackgroundPause`); when one surface TAKES the floor — the radio starting a run
//    — it calls `claimAudioFocus()` and every other registered surface is paused. The
//    reverse (returning to the feed) is covered by the radio pausing itself on blur, so
//    the two directions together guarantee: starting radio stops feed audio, and leaving
//    radio (or the app) stops radio. No surface reaches into another's players.
import { useEffect } from "react";
import { AppState } from "react-native";
import { setAudioModeAsync } from "expo-audio";

// Every registered surface's pause handler (the feed cards, the log-detail observation
// — anything that calls `useBackgroundPause`). A module-level set so a claim can reach
// them without any cross-screen wiring.
const pausers = new Set<() => void>();

/**
 * Take the single audio floor: pause every OTHER registered surface. The radio calls
 * this the instant it starts a run, so a feed card left sounding (an enabled preview,
 * a playing observation) goes quiet before the run's first word. The radio manages its
 * own player directly and is NOT a registered pauser, so this never silences the radio.
 */
export function claimAudioFocus(): void {
  for (const pause of pausers) {
    pause();
  }
}

/** The app's default session: duck others, silent-switch audible, never background. */
export function configureAudioSession() {
  setAudioModeAsync({
    interruptionMode: "duckOthers",
    playsInSilentMode: true,
    shouldPlayInBackground: false,
  }).catch(() => {});
}

/**
 * The radio's session: exclusive focus + keep playing past a lock / backgrounding.
 * `interruptionMode: "doNotMix"` is required for the lock-screen controls to bind to
 * the observation player (expo-audio's `setActiveForLockScreen` docs), and it also
 * grabs exclusive focus so other apps pause under the run. Restored to the app default
 * by `configureAudioSession()` when the radio blurs.
 */
export function configureRadioAudioSession() {
  setAudioModeAsync({
    interruptionMode: "doNotMix",
    playsInSilentMode: true,
    shouldPlayInBackground: true,
  }).catch(() => {});
}

/**
 * Pause when the app leaves the foreground (covers calls / route changes), AND register
 * `pause` on the shared floor so another surface taking the floor (the radio starting)
 * silences this one too. The feed cards already call this, so extending it here is what
 * makes the cross-tab exclusion work without touching the feed.
 */
export function useBackgroundPause(pause: () => void) {
  useEffect(() => {
    pausers.add(pause);

    const sub = AppState.addEventListener("change", (next) => {
      if (next !== "active") {
        pause();
      }
    });

    return () => {
      pausers.delete(pause);
      sub.remove();
    };
  }, [pause]);
}
