export type ReplicaEngineState = "unprobed" | "supported" | "unsupported";

export type EngineProbeOutcome = { kind: "ok" } | { kind: "error"; error: unknown };

const ENGINE_UNSUPPORTED_MARKERS = [
  "not supported in the current environment",
  "not supported in libsql mode",
];

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

export function engineAllowsAttempt(state: ReplicaEngineState): boolean {
  return state !== "unsupported";
}
