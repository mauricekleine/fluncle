import { takeWaitUntilPromises } from "@/test/cloudflare-workers-stub";
import { Data, Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serverLoggerLayer } from "./logger";
import { keepAlive } from "./wait-until";

class ZoneBusy extends Data.TaggedError("ZoneBusy")<{ zone: string }> {}

afterEach(() => {
  vi.restoreAllMocks();
  void takeWaitUntilPromises();
});

describe("keepAlive", () => {
  it("hands the task to waitUntil and returns before it finishes", async () => {
    const ran = vi.fn();

    await Effect.runPromise(keepAlive("purge.failed", Effect.sync(ran)));
    const pending = takeWaitUntilPromises();

    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(ran).toHaveBeenCalledOnce();
  });

  it("logs a failed task under its event instead of rejecting the kept-alive promise", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await Effect.runPromise(
      keepAlive("purge.failed", Effect.fail(new ZoneBusy({ zone: "fluncle.com" }))).pipe(
        Effect.provide(serverLoggerLayer),
      ),
    );
    await expect(Promise.all(takeWaitUntilPromises())).resolves.toBeDefined();

    const line = JSON.parse(String(error.mock.calls[0]?.[0])) as { cause: string; event: string };
    expect(line.event).toBe("purge.failed");
    expect(line.cause).toContain("ZoneBusy");
  });
});
