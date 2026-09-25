export type FeedState = "loading" | "offline" | "error" | "empty" | "ready";

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

  offline: {
    body: "I can't reach the archive from here. Soon as you're back online, I'll pull the findings straight through.",
    title: "Off the map",
  },
} as const;
