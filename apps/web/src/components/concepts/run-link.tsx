// Concept C — the Run's URL vocabulary.
//
// A stop lives entirely in the search params, so every stop is shareable and the
// browser's Back button walks back up the trail on its own. This module is the
// one place that turns a `RunStop` into a link, so the route's `validateSearch`
// and every control on the surface agree on the shape by construction.

import { type RunStop } from "@/routes/-concepts-data";

/** All three params are optional so a bare `/concepts/run` link still resolves. */
export type RunSearch = { anchor?: string; entity?: string; step?: number };

/**
 * A stop as search params. An absent key is left out rather than written as an
 * empty value, and step 0 stays implicit — `/concepts/run` and
 * `/concepts/run?step=0` are the same stop, and the shorter one is the one worth
 * sharing.
 */
export function stopSearch(stop: RunStop): RunSearch {
  const search: RunSearch = {};

  if (stop.anchor !== undefined) {
    search.anchor = stop.anchor;
  }

  if (stop.entity !== undefined) {
    search.entity = stop.entity;
  }

  if (stop.step > 0) {
    search.step = stop.step;
  }

  return search;
}

/** Two stops are the same stop when all three params match. */
export function sameStop(left: RunStop, right: RunStop): boolean {
  return left.anchor === right.anchor && left.entity === right.entity && left.step === right.step;
}

/**
 * The key that advances the lane, printed on the control it belongs to so the
 * transport is discoverable rather than hidden. Decoration for the eye — the
 * control carries `aria-keyshortcuts` for everyone else.
 */
export function RunKbd({ hint }: { hint: string }) {
  return (
    <span aria-hidden="true" className="run-kbd concept-display">
      {hint}
    </span>
  );
}
