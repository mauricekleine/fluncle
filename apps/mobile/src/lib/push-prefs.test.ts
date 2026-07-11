// Self-running checks for the push category prefs — no framework, mirroring the
// repo's node:assert-free style (submit-fault.test.ts). Run via `bun test` (reports
// "0 pass" — no describe/it blocks — but throws and fails the process on any failed
// assertion) or `bun src/lib/push-prefs.test.ts`.
//
// These pin the INVERSE mapping the wire depends on (a toggle that is ON must be a
// category ABSENT from `mutedCategories`) and the tolerant deserialize (a corrupt
// store must degrade to "deliver everything", never silently mute the crew).

import { DEFAULT_PUSH_PREFS, deserialize, mutedCategories, serialize } from "@/lib/push-prefs";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

// 1. The default is everything on, nothing muted.
assertEqual(DEFAULT_PUSH_PREFS.findings, true, "findings default on");
assertEqual(DEFAULT_PUSH_PREFS.mixtapes, true, "mixtapes default on");
assertEqual(mutedCategories(DEFAULT_PUSH_PREFS).length, 0, "both on → nothing muted");

// 2. The INVERSE: an OFF toggle is a MUTED category on the wire.
assertEqual(
  mutedCategories({ findings: false, mixtapes: true }).join(","),
  "findings",
  "findings off → findings muted",
);
assertEqual(
  mutedCategories({ findings: true, mixtapes: false }).join(","),
  "mixtapes",
  "mixtapes off → mixtapes muted",
);
assertEqual(
  mutedCategories({ findings: false, mixtapes: false }).join(","),
  "findings,mixtapes",
  "both off → both muted, in stable order",
);

// 3. Round-trip preserves the prefs.
const prefs = { findings: false, mixtapes: true };
const back = deserialize(serialize(prefs));
assertEqual(back.findings, false, "findings survives the round trip");
assertEqual(back.mixtapes, true, "mixtapes survives the round trip");

// 4. Tolerant deserialize: null, garbage, and missing keys all degrade to ON.
assertEqual(deserialize(null).findings, true, "null → default on");
assertEqual(deserialize("not json {{{").mixtapes, true, "invalid JSON → default on");
assertEqual(
  deserialize(JSON.stringify({ findings: false })).mixtapes,
  true,
  "missing key → that category defaults on",
);
assertEqual(
  deserialize(JSON.stringify({ findings: false })).findings,
  false,
  "present key is honoured",
);
assertEqual(
  deserialize(JSON.stringify({ findings: "nope" })).findings,
  true,
  "non-boolean key → default on",
);
