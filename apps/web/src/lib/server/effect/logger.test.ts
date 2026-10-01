import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serverLoggerLayer } from "./logger";

afterEach(() => {
  vi.restoreAllMocks();
});

function logged(level: "error" | "info" | "warn"): unknown[] {
  const spy = vi.mocked(console[level]);

  return spy.mock.calls.map(([line]) => JSON.parse(String(line)));
}

describe("serverLogger", () => {
  it("writes the logEvent JSON shape: event plus annotations as fields", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});

    Effect.runSync(
      Effect.logInfo("musicbrainz.rate-limited").pipe(
        Effect.annotateLogs({ retryAfterMs: 1100 }),
        Effect.provide(serverLoggerLayer),
      ),
    );

    expect(logged("info")).toEqual([{ event: "musicbrainz.rate-limited", retryAfterMs: 1100 }]);
  });

  it("routes warnings and errors to the matching console level", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    Effect.runSync(
      Effect.logWarning("quota.low").pipe(
        Effect.andThen(Effect.logError("upstream.failed")),
        Effect.provide(serverLoggerLayer),
      ),
    );

    expect(logged("warn")).toEqual([{ event: "quota.low" }]);
    expect(logged("error")).toEqual([{ event: "upstream.failed" }]);
  });

  it("serialises an Error field to its message and stack", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("socket closed");

    Effect.runSync(
      Effect.logError("fetch.failed").pipe(
        Effect.annotateLogs({ error }),
        Effect.provide(serverLoggerLayer),
      ),
    );

    expect(logged("error")).toEqual([
      { error: { message: "socket closed", stack: error.stack }, event: "fetch.failed" },
    ]);
  });
});
