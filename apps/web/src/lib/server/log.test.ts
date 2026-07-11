import { afterEach, describe, expect, it, vi } from "vitest";
import { logEvent } from "./log";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logEvent — the Worker's one structured emitter", () => {
  it("emits a single JSON line with the event as the first field", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    logEvent("warn", "publish.telegram-failed", { logId: "007.A.03", trackId: "abc" });

    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0]?.[0] as string;
    expect(typeof line).toBe("string");
    expect(JSON.parse(line)).toEqual({
      event: "publish.telegram-failed",
      logId: "007.A.03",
      trackId: "abc",
    });
  });

  it("routes the level to the matching console method", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    logEvent("error", "api.unexpected-fault");
    logEvent("info", "cluster.assigned");

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(errSpy.mock.calls[0]?.[0] as string)).toEqual({
      event: "api.unexpected-fault",
    });
  });

  it("serializes an Error value to { message, stack } (a bare Error stringifies to {})", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    logEvent("error", "api.unexpected-fault", { error: new Error("secret-internal-detail") });

    const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string) as {
      error: { message: string; stack: string };
      event: string;
    };
    expect(parsed.error.message).toBe("secret-internal-detail");
    expect(typeof parsed.error.stack).toBe("string");
    expect(parsed.error.stack).toContain("Error");
  });

  it("omits fields entirely when none are given", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    logEvent("warn", "spotify.artist-image-skipped");

    expect(JSON.parse(spy.mock.calls[0]?.[0] as string)).toEqual({
      event: "spotify.artist-image-skipped",
    });
  });
});
