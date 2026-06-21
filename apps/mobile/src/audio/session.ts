// The audio-session coordinator (RFC Unit 2). One session for the whole app:
// interrupt other apps when a card has sound, never play in the background
// (a feed, not a music app). The visible-card-only invariant is enforced by the
// feed (only the active card calls play); this owns the session config + the
// foreground rule that handles interruptions (calls, route changes, backgrounding).
import { useEffect } from "react";
import { AppState } from "react-native";
import { setAudioModeAsync } from "expo-audio";

export function configureAudioSession() {
  setAudioModeAsync({
    interruptionMode: "duckOthers",
    playsInSilentMode: true,
    shouldPlayInBackground: false,
  }).catch(() => {});
}

/** Pause when the app leaves the foreground (no background audio; covers calls). */
export function useBackgroundPause(pause: () => void) {
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next !== "active") {
        pause();
      }
    });
    return () => sub.remove();
  }, [pause]);
}
