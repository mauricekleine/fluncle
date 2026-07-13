// Self-running checks pinning the mobile Camelot port to the web's conversions (the
// canonical tables in apps/web/src/lib/key-camelot.ts) — the two surfaces must never
// disagree on what "1A" means. Same framework-free harness as mix-set.test.ts.

import { keyToCamelotCode } from "@/lib/key-camelot";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

// The wheel's minor (inner "A") ring — including the pair that motivated the toggle:
// G# minor (1A) → D# minor (2A) is one step over, i.e. "Next key over" up a fifth.
assertEqual(keyToCamelotCode("G# minor"), "1A", "G# minor is 1A");
assertEqual(keyToCamelotCode("D# minor"), "2A", "D# minor is 2A — G#m's next key over");
assertEqual(keyToCamelotCode("A minor"), "8A", "A minor is 8A");

// The major (outer "B") ring.
assertEqual(keyToCamelotCode("C major"), "8B", "C major is 8B");
assertEqual(keyToCamelotCode("D# major"), "5B", "D# major is 5B");

// Tolerance: flats fold to their sharp enharmonic; shorthand, a lowercase note, and stray
// whitespace resolve (the mode word stays lowercase — the web parser's exact contract).
assertEqual(keyToCamelotCode("Bb min"), "3A", "Bb min folds to A# minor, 3A");
assertEqual(keyToCamelotCode("  f# maj "), "2B", "shorthand + lowercase note + whitespace");

// Anything unparseable is null, never a guess.
assertEqual(keyToCamelotCode("F# dorian"), null, "a modal quality is null");
assertEqual(keyToCamelotCode(""), null, "empty is null");
assertEqual(keyToCamelotCode(undefined), null, "undefined is null");
