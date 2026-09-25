import { isOnline } from "@/lib/network-status";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

assertEqual(
  isOnline({ isConnected: true, isInternetReachable: true }),
  true,
  "connected and reachable → online",
);
assertEqual(
  isOnline({ isConnected: false, isInternetReachable: false }),
  false,
  "disconnected and unreachable → offline",
);

assertEqual(
  isOnline({ isConnected: true, isInternetReachable: false }),
  false,
  "connected but explicitly unreachable (captive portal) → offline",
);
assertEqual(
  isOnline({ isConnected: false, isInternetReachable: true }),
  true,
  "explicitly reachable outranks a false link flag → online",
);

assertEqual(
  isOnline({ isConnected: true, isInternetReachable: undefined }),
  true,
  "reachability undefined, link up → online",
);
assertEqual(
  isOnline({ isConnected: undefined, isInternetReachable: undefined }),
  true,
  "nothing known at all → online, never paused",
);
assertEqual(isOnline({}), true, "an empty state object → online");
assertEqual(isOnline(undefined), true, "no state (a failed read) → online");
assertEqual(isOnline(null), true, "a null state → online");

assertEqual(
  isOnline({ isConnected: true, isInternetReachable: null }),
  true,
  "null reachability, link up → online",
);
assertEqual(
  isOnline({ isConnected: null, isInternetReachable: null }),
  true,
  "null across the board → online",
);

assertEqual(
  isOnline({ isConnected: false, isInternetReachable: undefined }),
  false,
  "reachability unknown but the link says no → offline",
);
assertEqual(isOnline({ isConnected: false }), false, "link says no, reachability absent → offline");
