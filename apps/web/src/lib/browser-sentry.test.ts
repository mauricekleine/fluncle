import { describe, expect, it, vi } from "vitest";
import { browserSpanStart, browserTracesSampler, bufferBrowserErrors } from "./browser-sentry";

const HUMAN_UA = "Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36";

describe("browser tracing", () => {
  it("starts late-initialized pageloads at navigation origin while preserving navigation timing", () => {
    expect(
      browserSpanStart({ name: "/track/$trackId", op: "pageload", startTime: 999 }, 123000),
    ).toEqual({ name: "/track/$trackId", op: "pageload", startTime: 123 });
    expect(browserSpanStart({ name: "/search", op: "navigation", startTime: 999 }, 123000)).toEqual(
      { name: "/search", op: "navigation", startTime: 999 },
    );
  });
  it.each([
    ["www.fluncle.com", HUMAN_UA, 0.5],
    ["mirror.onion", HUMAN_UA, 0.5],
    ["127.0.0.1", HUMAN_UA, 0],
    ["app.workers.dev", HUMAN_UA, 0],
    ["www.fluncle.com", "HeadlessChrome/130", 0],
    ["www.fluncle.com", "", 0],
  ])("samples %s with %s at %s", (host, userAgent, expected) => {
    expect(browserTracesSampler(host, userAgent)).toBe(expected);
  });
});

describe("early browser errors", () => {
  it("replays errors and rejections in arrival order and detaches the buffer", () => {
    const target = new EventTarget();
    const flush = bufferBrowserErrors(target);
    const error = new Error("before hydration");
    target.dispatchEvent(Object.assign(new Event("error"), { error }));
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "rejected" }));
    target.dispatchEvent(Object.assign(new Event("error"), { message: "without error object" }));
    const capture = vi.fn();
    flush(capture);
    expect(capture.mock.calls.map(([item]) => item)).toEqual([
      error,
      "rejected",
      "without error object",
    ]);
    expect(capture.mock.calls.map(([, hint]) => hint)).toEqual([
      { mechanism: { handled: false, type: "auto.browser.global_handlers.onerror" } },
      { mechanism: { handled: false, type: "auto.browser.global_handlers.onunhandledrejection" } },
      { mechanism: { handled: false, type: "auto.browser.global_handlers.onerror" } },
    ]);
    target.dispatchEvent(Object.assign(new Event("error"), { error: "after init" }));
    flush(capture);
    expect(capture).toHaveBeenCalledTimes(3);
  });

  it("bounds a startup error storm to the most recent twenty errors", () => {
    const target = new EventTarget();
    const flush = bufferBrowserErrors(target);
    for (let index = 0; index < 25; index += 1) {
      target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: index }));
    }
    const captured: unknown[] = [];
    flush((error) => captured.push(error));
    expect(captured).toEqual(Array.from({ length: 20 }, (_, index) => index + 5));
  });
});
