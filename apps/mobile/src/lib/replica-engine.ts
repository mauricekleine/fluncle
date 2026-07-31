// The ENGINE PROBE: does the binary this code is running inside actually carry libSQL?
// Pure (no expo-sqlite import, no RN tree) so the state machine is pinned by a test.
//
// expo-sqlite compiles libSQL as a BUILD-TIME variant — its config plugin's `useLibSQL`
// prop swaps the whole native SQLite module — so whether `db.syncLibSQL()` exists is a
// property of the BUILD, not of the device or the network. Production builds ship on the
// default engine today, where the call throws "syncLibSQL is not supported in the current
// environment". That is not a fault to report, retry, or show anyone: it is the app running
// exactly as it shipped.
//
// Hence the shape below. There is no way to ask the module whether it is the libSQL variant,
// so the FIRST sync attempt IS the probe, and its answer is remembered for the launch:
//
//   unprobed    → nothing has been tried yet, or every attempt so far failed for a reason
//                 that says nothing about the engine (no network, no token, a dead remote).
//                 Worth trying again on the next foreground.
//   supported   → a sync completed. The build carries libSQL; later failures are transient.
//   unsupported → the engine itself refused. TERMINAL for this launch — nothing about the
//                 binary can change while it is running, so every later attempt is skipped
//                 silently. A new build re-probes from `unprobed` on its first launch.
//
// The asymmetry is the point: a network error must never be mistaken for a missing engine
// (that would strand a working build until it is killed), and a missing engine must never be
// retried (that would burn a token fetch and a native throw on every foreground, forever).

/** What this launch knows about the binary's SQLite engine. */
export type ReplicaEngineState = "unprobed" | "supported" | "unsupported";

/** The result of one sync attempt, as the state machine reads it. */
export type EngineProbeOutcome = { kind: "ok" } | { kind: "error"; error: unknown };

// The two native messages that mean "this build has no libSQL variant". Matched on
// substrings because the surrounding text is the native layer's to change.
const ENGINE_UNSUPPORTED_MARKERS = [
  "not supported in the current environment",
  "not supported in libsql mode",
];

/**
 * Is this error the engine saying it cannot do libSQL at all? Deliberately NARROW — the
 * opposite bias to `isAuthShapedSyncFailure`, because a false positive here goes terminal
 * and darkens the replica for the whole launch.
 */
export function isEngineUnsupportedError(error: unknown): boolean {
  const message =
    typeof error === "object" &&
    error !== null &&
    typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : String(error);
  const text = message.toLowerCase();
  return ENGINE_UNSUPPORTED_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Fold one attempt's outcome into the launch's engine verdict. `unsupported` absorbs
 * everything (it cannot be un-learned while the process lives); a success promotes to
 * `supported`; and an error that is not an engine refusal leaves the verdict exactly where it
 * was, so a tunnel never demotes a build that is known to work.
 */
export function nextEngineState(
  current: ReplicaEngineState,
  outcome: EngineProbeOutcome,
): ReplicaEngineState {
  if (current === "unsupported") {
    return "unsupported";
  }
  if (outcome.kind === "ok") {
    return "supported";
  }
  return isEngineUnsupportedError(outcome.error) ? "unsupported" : current;
}

/** May the caller spend a token fetch and a native call on this state? */
export function engineAllowsAttempt(state: ReplicaEngineState): boolean {
  return state !== "unsupported";
}
