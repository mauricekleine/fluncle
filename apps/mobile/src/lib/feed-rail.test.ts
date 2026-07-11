// Self-running checks for the feed rail's stable labels — no framework, mirroring
// submit-fault.test.ts's node:assert-free style (the Expo tsconfig has no @types/node).
// Run via `bun test` (reports "0 pass" — no describe/it blocks — but throws and fails
// the process on any failed assertion) or `bun src/lib/feed-rail.test.ts`.
//
// This pins the Chrome Rule (voice.md §4, ratified 2026-07-11): a control's visible
// label is ONE stable literal across state; the icon + the gold tint carry the state,
// never the word. It guards the exact regression that motivated the rule — a rail
// label that flipped per press ("Note"→"Playing", "Sound"→"Muted").

import { observationRail, soundRail } from "@/lib/feed-rail";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

// 1. The observation label is the same literal whether or not it is playing.
assertEqual(observationRail(false).label, "Observation", "observation idle label");
assertEqual(observationRail(true).label, "Observation", "observation playing label");
assertEqual(
  observationRail(false).label,
  observationRail(true).label,
  "observation label is stable across state",
);

// 2. The sound label is the same literal whether on or muted (no "Muted" flip).
assertEqual(soundRail(false).label, "Sound", "sound off label");
assertEqual(soundRail(true).label, "Sound", "sound on label");
assertEqual(soundRail(false).label, soundRail(true).label, "sound label is stable across state");

// 3. `active` reflects the state (it drives the gold tint + accessibilityState).
assertEqual(observationRail(true).active, true, "observation active when playing");
assertEqual(observationRail(false).active, false, "observation inactive when stopped");
assertEqual(soundRail(true).active, true, "sound active when on");
assertEqual(soundRail(false).active, false, "sound inactive when muted");

// 4. The screen-reader hint DOES name the action and flips with state (a11y wants the
//    verb even though the visible chrome stays put).
assertEqual(
  observationRail(false).accessibilityLabel,
  "Play Fluncle's observation",
  "observation a11y idle",
);
assertEqual(
  observationRail(true).accessibilityLabel,
  "Stop the observation",
  "observation a11y playing",
);
assertEqual(soundRail(false).accessibilityLabel, "Turn sound on", "sound a11y off");
assertEqual(soundRail(true).accessibilityLabel, "Turn sound off", "sound a11y on");

// 5. Observation and Sound are mutually exclusive (the operator's ruling: the
//    observation note wins). While an observation plays, the Sound control reads muted —
//    never gold — regardless of the underlying `soundOn` preference.
assertEqual(soundRail(true, true).active, false, "sound suppressed while observing");
assertEqual(soundRail(false, true).active, false, "sound stays muted while observing");
assertEqual(soundRail(true, false).active, true, "sound active when not observing");
// The label stays the one stable literal (the Chrome Rule) through the suppression.
assertEqual(soundRail(true, true).label, "Sound", "sound label stable while observing");
// The a11y verb keeps describing the persistent toggle, not the momentary suppression:
// pressing it sets the preference that takes effect once the observation ends.
assertEqual(
  soundRail(true, true).accessibilityLabel,
  "Turn sound off",
  "sound a11y verb follows the preference, not the observation",
);
