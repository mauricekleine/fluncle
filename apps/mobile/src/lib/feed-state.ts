// The Stories feed's honest view states + their copy, kept pure so the branch logic
// and the literal control strings are pinned by a test. Copy follows the voice canon:
// prose (the empty/error ledes) carries the Fluncle voice; the control ("Try again")
// stays a plain literal (the Chrome Rule). No exclamation marks (the Dry Rule) and no
// em-dashes in the prose. index.tsx renders whichever branch this resolves.

export type FeedState = "loading" | "error" | "empty" | "ready";

/**
 * Which state the feed is in, from the infinite query + the flattened count. Any data
 * already in hand wins (a background refetch failing never blanks a populated feed);
 * only a truly empty query falls through to loading / error / empty.
 */
export function resolveFeedState(q: {
  count: number;
  isError: boolean;
  isPending: boolean;
}): FeedState {
  if (q.count > 0) {
    return "ready";
  }
  if (q.isPending) {
    return "loading";
  }
  if (q.isError) {
    return "error";
  }
  return "empty";
}

export const feedCopy = {
  empty: {
    body: "When Fluncle finds the next banger, it lands here first.",
    title: "Nothing logged yet",
  },
  error: {
    body: "The findings didn't come through. Give it another go.",
    retry: "Try again",
    title: "Lost the signal",
  },
  footer: "Finding more",
  loading: "Tuning in",
} as const;
