// Self-running checks for the network-state → online boolean mapper — no framework,
// mirroring feed-state.test.ts's style. Run via `bun test` (reports "0 pass" — no
// describe/it blocks — but throws and fails the process on any failed assertion) or
// `bun src/lib/network-status.test.ts`.
//
// The whole point of this file is the ASYMMETRY: a false "offline" pauses every query at
// launch and the app never recovers on its own, so unknown must resolve to online. Every
// shape expo-network can hand us is pinned here, including the ones it only produces on
// one platform.

import { isOnline } from "@/lib/network-status";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

// 1. The affirmative answers.
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

// 2. Reachability wins when it has an opinion: a captive-portal wifi is CONNECTED and
//    useless, and a link the OS hasn't classified can still carry traffic.
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

// 3. UNKNOWN IS NOT OFFLINE — the case that decides whether a cold start begins paused.
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

// 4. Nulls behave exactly like undefined — an OS bridge may hand back either.
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

// 5. Only an outright "no link" turns it false when reachability is silent.
assertEqual(
  isOnline({ isConnected: false, isInternetReachable: undefined }),
  false,
  "reachability unknown but the link says no → offline",
);
assertEqual(isOnline({ isConnected: false }), false, "link says no, reachability absent → offline");
