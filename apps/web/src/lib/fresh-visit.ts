// `/fresh`'s "new since your last visit": held in THIS browser, never on a server.
//
// Anonymous is first-class (PRODUCT.md, "The discovery funnel"): no account, no cookie, no beacon.
// The browser keeps the keys of the releases it was shown last time, and a release is NEW when its
// key was not among them. Keys, not dates: the crawl finds a release days after it came out, so a
// release can land in an older week and still be new to this listener — a date line would miss it.
//
// A VISIT is a sitting, not a page load. A reload, or a trip to a track and back, less than
// `FRESH_VISIT_SITTING_MS` after the last view keeps the same baseline, so the markers survive the
// listener actually using them; after a longer gap the next sitting compares against everything
// the last one showed.

import { useEffect, useState } from "react";

export const FRESH_VISIT_STORAGE_KEY = "fluncle:fresh-visit";

/** How long one sitting lasts: inside it, the baseline holds still. */
export const FRESH_VISIT_SITTING_MS = 30 * 60 * 1000;

/** A generous ceiling on the keys kept, so a corrupted entry can never grow without bound. */
const FRESH_VISIT_KEY_CEILING = 2000;

/** What this browser stores. `baseline` is the previous sitting's keys, while a sitting lasts. */
export type FreshVisitRecord = { at: number; baseline?: string[]; first?: boolean; seen: string[] };

/** What the page shows: nothing on a first visit, else which releases are new. */
export type FreshVisitState =
  | { kind: "first" }
  | { kind: "returning"; newKeys: ReadonlySet<string> };

function keyList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((key) => typeof key === "string")
    ? value.slice(0, FRESH_VISIT_KEY_CEILING)
    : undefined;
}

/** Read a stored record defensively: anything malformed is a first visit, never a crash. */
export function parseFreshVisit(raw: string | null): FreshVisitRecord | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    const value: unknown = JSON.parse(raw);

    if (typeof value !== "object" || value === null) {
      return undefined;
    }

    const record = value as Record<string, unknown>;
    const seen = keyList(record.seen);

    if (typeof record.at !== "number" || !seen) {
      return undefined;
    }

    return {
      at: record.at,
      baseline: keyList(record.baseline),
      first: record.first === true ? true : undefined,
      seen,
    };
  } catch {
    return undefined;
  }
}

/**
 * One page view's transition: what to show, and what to store. Inside a sitting the previous
 * baseline holds; a new sitting takes the last sitting's keys as its baseline. The keys stored are
 * the releases on the page now, so a release that aged out of the window is forgotten with it.
 */
export function nextFreshVisit(
  stored: FreshVisitRecord | undefined,
  currentKeys: string[],
  now: number,
): { record: FreshVisitRecord; state: FreshVisitState } {
  // A stored time in the future (a clock set back, a hand-edited entry) proves nothing about a
  // sitting: it is never "the same sitting", so it can neither hold a baseline nor a first visit.
  const inSitting =
    stored !== undefined && stored.at <= now && now - stored.at < FRESH_VISIT_SITTING_MS;

  // A first visit stays a first visit for its whole sitting: a reload a minute in has no "last
  // visit" to compare against.
  if (!stored || (inSitting && stored.first)) {
    return {
      record: { at: now, first: true, seen: currentKeys.slice(0, FRESH_VISIT_KEY_CEILING) },
      state: { kind: "first" },
    };
  }

  const sameSitting = inSitting && stored.baseline !== undefined;
  const baseline = sameSitting ? (stored.baseline ?? []) : stored.seen;
  const known = new Set(baseline);

  return {
    record: {
      at: now,
      baseline: baseline.slice(0, FRESH_VISIT_KEY_CEILING),
      seen: currentKeys.slice(0, FRESH_VISIT_KEY_CEILING),
    },
    state: {
      kind: "returning",
      newKeys: new Set(currentKeys.filter((key) => !known.has(key))),
    },
  };
}

/**
 * The page's hook: undefined through SSR and the first paint (the server cannot know this browser),
 * then the visit state once mounted. Storage that throws (a private window, a full quota) reads as
 * a first visit and stores nothing.
 */
export function useFreshVisit(currentKeys: string[]): FreshVisitState | undefined {
  const [state, setState] = useState<FreshVisitState>();
  const signature = currentKeys.join("\n");

  useEffect(() => {
    let stored: FreshVisitRecord | undefined;

    try {
      stored = parseFreshVisit(window.localStorage.getItem(FRESH_VISIT_STORAGE_KEY));
    } catch {
      setState({ kind: "first" });

      return;
    }

    const next = nextFreshVisit(stored, currentKeys, Date.now());

    try {
      window.localStorage.setItem(FRESH_VISIT_STORAGE_KEY, JSON.stringify(next.record));
    } catch {
      // Nothing to keep: this browser will read as a first visit next time too.
    }

    setState(next.state);
    // The key list is the input; `signature` is its stable identity across renders.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return state;
}
