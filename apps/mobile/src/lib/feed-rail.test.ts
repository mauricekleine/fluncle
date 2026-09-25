import { soundRail } from "@/lib/feed-rail";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

assertEqual(soundRail(false).label, "Sound", "sound off label");
assertEqual(soundRail(true).label, "Sound", "sound on label");
assertEqual(soundRail(false).label, soundRail(true).label, "sound label is stable across state");

assertEqual(soundRail(true).active, true, "sound active when on");
assertEqual(soundRail(false).active, false, "sound inactive when muted");

assertEqual(soundRail(false).accessibilityLabel, "Turn sound on", "sound a11y off");
assertEqual(soundRail(true).accessibilityLabel, "Turn sound off", "sound a11y on");
