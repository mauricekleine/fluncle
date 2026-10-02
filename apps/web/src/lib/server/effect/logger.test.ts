import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, vi } from "vitest";
import { serverLoggerLayer } from "./logger";

afterEach(() => {
  vi.restoreAllMocks();
});

function logged(level: "error" | "info" | "warn"): unknown[] {
  return vi.mocked(console[level]).mock.calls.map(([line]) => JSON.parse(String(line)));
}

describe("serverLogger", () => {
  it.effect("writes the logEvent JSON shape: event plus annotations as fields", () =>
    Effect.gen(function* () {
      vi.spyOn(console, "info").mockImplementation(() => {});

      yield* Effect.logInfo("musicbrainz.rate-limited").pipe(
        Effect.annotateLogs({ retryAfterMs: 1100 }),
      );

      expect(logged("info")).toEqual([{ event: "musicbrainz.rate-limited", retryAfterMs: 1100 }]);
    }).pipe(Effect.provide(serverLoggerLayer)),
  );

  it.effect("routes warnings and errors to the matching console level", () =>
    Effect.gen(function* () {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});

      yield* Effect.logWarning("quota.low");
      yield* Effect.logError("upstream.failed");

      expect(logged("warn")).toEqual([{ event: "quota.low" }]);
      expect(logged("error")).toEqual([{ event: "upstream.failed" }]);
    }).pipe(Effect.provide(serverLoggerLayer)),
  );

  it.effect("serialises an Error field to its message and stack", () =>
    Effect.gen(function* () {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const error = new Error("socket closed");

      yield* Effect.logError("fetch.failed").pipe(Effect.annotateLogs({ error }));

      expect(logged("error")).toEqual([
        { error: { message: "socket closed", stack: error.stack }, event: "fetch.failed" },
      ]);
    }).pipe(Effect.provide(serverLoggerLayer)),
  );
});
