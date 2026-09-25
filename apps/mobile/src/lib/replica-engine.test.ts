import {
  type ReplicaEngineState,
  engineAllowsAttempt,
  isEngineUnsupportedError,
  nextEngineState,
} from "@/lib/replica-engine";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

assertEqual(
  isEngineUnsupportedError(new Error("syncLibSQL is not supported in the current environment")),
  true,
  "the default-engine message",
);
assertEqual(
  isEngineUnsupportedError(new Error("enableChangeListener is not supported in libSQL mode")),
  true,
  "the libSQL-mode message",
);
assertEqual(
  isEngineUnsupportedError({ message: "NOT SUPPORTED IN THE CURRENT ENVIRONMENT" }),
  true,
  "case-insensitive, and reads a plain object",
);
assertEqual(isEngineUnsupportedError(new Error("Network request failed")), false, "a tunnel");
assertEqual(isEngineUnsupportedError(new Error("Unauthorized")), false, "a credential failure");
assertEqual(isEngineUnsupportedError(new Error("no such table: findings")), false, "a bad file");
assertEqual(isEngineUnsupportedError(undefined), false, "nothing is not a refusal");
assertEqual(isEngineUnsupportedError("not supported in libSQL mode"), true, "a thrown string");

const engineRefusal = new Error("syncLibSQL is not supported in the current environment");
const tunnel = new Error("Network request failed");

assertEqual(nextEngineState("unprobed", { kind: "ok" }), "supported", "the first pull proves it");
assertEqual(nextEngineState("supported", { kind: "ok" }), "supported", "and stays proven");

assertEqual(
  nextEngineState("unprobed", { error: engineRefusal, kind: "error" }),
  "unsupported",
  "the probe learns the build has no engine",
);

assertEqual(
  nextEngineState("unprobed", { error: tunnel, kind: "error" }),
  "unprobed",
  "a tunnel says nothing about the engine; try again next foreground",
);
assertEqual(
  nextEngineState("supported", { error: tunnel, kind: "error" }),
  "supported",
  "a proven build is never demoted by a network failure",
);

const terminal: ReplicaEngineState = "unsupported";
assertEqual(nextEngineState(terminal, { kind: "ok" }), "unsupported", "absorbs a success");
assertEqual(nextEngineState(terminal, { error: tunnel, kind: "error" }), "unsupported", "absorbs");

assertEqual(engineAllowsAttempt("unprobed"), true, "worth a probe");
assertEqual(engineAllowsAttempt("supported"), true, "worth a pull");
assertEqual(engineAllowsAttempt("unsupported"), false, "never again this launch");

console.log("replica-engine.test.ts: all assertions passed");
