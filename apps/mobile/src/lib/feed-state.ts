// The Stories feed's honest view states + their copy, kept pure so the branch logic
// and the literal control strings are pinned by a test. Copy follows the voice canon:
// prose (the empty/error ledes) carries the Fluncle voice; the control ("Try again")
// stays a plain literal (the Chrome Rule). No exclamation marks (the Dry Rule), no
// em-dashes in the prose, and no retired identity words (VOICE.md's banned list —
// the error lede reuses the web error boundary's ratified "Rough re-entry" heading
// rather than a radio metaphor). index.tsx renders whichever branch this resolves.

export type FeedState = "loading" | "offline" | "error" | "empty" | "ready";

/**
 * Which state the feed is in, from the infinite query + the flattened count. Any data
 * already in hand wins (a background refetch failing never blanks a populated feed);
 * only a truly empty query falls through to offline / loading / error / empty.
 *
 * `isPaused` is the offline branch, and it must be read BEFORE `isPending`: a query the
 * online manager parked is `status: 'pending'` AND `fetchStatus: 'paused'` at the same
 * time, so a loading state keyed on pending alone spins forever in a tunnel. It also
 * outranks `isError`, because a stale error plus a paused retry is still, honestly, a
 * connection problem, and "Try again" is a control that cannot work until one returns.
 */
export function resolveFeedState(q: {
  count: number;
  isError: boolean;
  isPaused: boolean;
  isPending: boolean;
}): FeedState {
  if (q.count > 0) {
    return "ready";
  }
  if (q.isPaused) {
    return "offline";
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
    title: "Rough re-entry",
  },
  footer: "Finding more",
  loading: "Tuning in",
  // Offline carries no retry control: the query resumes itself the moment the device is
  // back, so a button here would be a second, slower way to do what already happens. The
  // body must not issue an imperative either, for the same reason — there is nothing the
  // reader has to go do. Two words this copy deliberately avoids: "range"/"signal" (the
  // radio metaphor VOICE.md retired — "Lost the signal" shipped on this exact screen once)
  // and "find" (the Found Rule's family verb; spending it on a router one clause from "the
  // findings" makes the reader parse it twice with two meanings).
  offline: {
    body: "I can't reach the archive from here. Soon as you're back online, I'll pull the findings straight through.",
    title: "Off the map",
  },
} as const;
