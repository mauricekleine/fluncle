import { useEffect } from "react";
import { AppState } from "react-native";
import { setAudioModeAsync } from "expo-audio";

const pausers = new Set<() => void>();

export function claimAudioFocus(): void {
  for (const pause of pausers) {
    pause();
  }
}

export function configureAudioSession() {
  setAudioModeAsync({
    interruptionMode: "duckOthers",
    playsInSilentMode: true,
    shouldPlayInBackground: false,
  }).catch(() => {});
}

export function configureRadioAudioSession() {
  setAudioModeAsync({
    interruptionMode: "doNotMix",
    playsInSilentMode: true,
    shouldPlayInBackground: true,
  }).catch(() => {});
}

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
