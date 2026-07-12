// Self-running checks for the feed rail's stable labels — no framework, mirroring
// submit-fault.test.ts's node:assert-free style (the Expo tsconfig has no @types/node).
// Run via `bun test` (reports "0 pass" — no describe/it blocks — but throws and fails
// the process on any failed assertion) or `bun src/lib/feed-rail.test.ts`.
//
// This pins the Chrome Rule (voice.md §4, ratified 2026-07-11): a control's visible
// label is ONE stable literal across state; the icon + the gold tint carry the state,
// never the word. It guards the exact regression that motivated the rule — a rail
// label that flipped per press ("Sound"→"Muted").

import { soundRail } from "@/lib/feed-rail";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

// 1. The sound label is the same literal whether on or muted (no "Muted" flip).
assertEqual(soundRail(false).label, "Sound", "sound off label");
assertEqual(soundRail(true).label, "Sound", "sound on label");
assertEqual(soundRail(false).label, soundRail(true).label, "sound label is stable across state");

// 2. `active` reflects the state (it drives the gold tint + accessibilityState).
assertEqual(soundRail(true).active, true, "sound active when on");
assertEqual(soundRail(false).active, false, "sound inactive when muted");

// 3. The screen-reader hint DOES name the action and flips with state (a11y wants the
//    verb even though the visible chrome stays put).
assertEqual(soundRail(false).accessibilityLabel, "Turn sound on", "sound a11y off");
assertEqual(soundRail(true).accessibilityLabel, "Turn sound off", "sound a11y on");
