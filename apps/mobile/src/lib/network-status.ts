// Reading a device's network state as ONE boolean, kept pure (no expo-network import, no
// RN tree) so the whole truth table is pinned by a test. app/_layout.tsx feeds the result
// to TanStack Query's `onlineManager`, which otherwise starts `online: true` and only ever
// flips on an event nobody wired: without this seed the app believes it is online forever,
// so a request made in a tunnel fails instead of parking as a paused mutation.
//
// The structural shape below is expo-network's `NetworkState` / `NetworkStateEvent` (both
// fields optional; iOS reports `isInternetReachable` identical to `isConnected`, Android
// answers it independently).

/** What expo-network reports, narrowed to the two fields the decision reads. */
export type NetworkSnapshot = {
  isConnected?: boolean | null;
  isInternetReachable?: boolean | null;
};

/**
 * Is the device online enough to let a request leave?
 *
 * The load-bearing asymmetry: UNKNOWN IS NOT OFFLINE. Only an affirmative "no" turns this
 * false. A platform that has not answered yet, a field the OS left undefined, or a failed
 * read all resolve to `true`, because the cost of the two mistakes is not symmetric — a
 * false "offline" pauses every query at launch and the app never recovers on its own,
 * while a false "online" costs one request that fails and retries.
 *
 * Reachability wins when it has an opinion (a captive-portal wifi is connected and useless);
 * with no opinion the decision falls back to the link itself.
 */
export function isOnline(state: NetworkSnapshot | null | undefined): boolean {
  if (!state) {
    return true;
  }
  if (state.isInternetReachable === false) {
    return false;
  }
  if (state.isInternetReachable === true) {
    return true;
  }
  // Reachability unknown: trust the link unless it says outright there is none.
  return state.isConnected !== false;
}
