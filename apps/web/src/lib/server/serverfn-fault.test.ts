import { afterEach, describe, expect, it, vi } from "vitest";
import { GENERIC_SERVERFN_FAULT_MESSAGE, redactServerFnFault } from "./serverfn-fault";
import { ApiError } from "./spotify";

// `redactServerFnFault` is the wire-redaction discipline for TanStack Start server
// functions: it decides what may cross to the browser when a loader/server-fn throws.
// The property under test is the leak the 2026-07-26 incident exposed — a raw driver
// message reaching a PUBLIC browser — and its operator-only carve-out for /admin.

// Log + Sentry are the private diagnostics side channel. Stub both so the suite can
// assert the full fault is recorded server-side WITHOUT emitting real events.
const logEvent = vi.fn();

vi.mock("./log", () => ({
  logEvent: (...args: unknown[]) => logEvent(...args),
}));

const captureException = vi.fn();

vi.mock("@sentry/cloudflare", () => ({
  captureException: (...args: unknown[]) => captureException(...args),
}));

afterEach(() => {
  vi.clearAllMocks();
});

// A synthetic driver-shaped fault: the exact wire the incident put in front of the
// public — a libSQL/Turso error whose message names an internal column.
function driverError(): Error {
  const error = new Error(
    "SQLITE_INPUT_ERROR: SQLite input error: no such column: t.video_structure",
  );
  error.name = "LibsqlError";

  return error;
}

// The SSR transport: the server fn runs in-process, so the ambient request IS the
// page. No `x-tsr-serverFn` header (that is a client-fetcher stamp).
function pageRequest(pathname: string): Request {
  return new Request(`https://fluncle.com${pathname}`);
}

// The client-navigation transport: the server fn is called over HTTP at its own
// endpoint, stamped `x-tsr-serverFn: true`, with the originating page in the
// same-origin Referer.
function serverFnRequest(refererPathname: string | null): Request {
  const headers = new Headers({ "x-tsr-serverFn": "true" });

  if (refererPathname !== null) {
    headers.set("referer", `https://fluncle.com${refererPathname}`);
  }

  return new Request("https://fluncle.com/_serverFn/getReach", { headers });
}

describe("redactServerFnFault", () => {
  it("redacts an unexpected fault on a PUBLIC route to a generic message (SSR)", () => {
    const original = driverError();

    const result = redactServerFnFault(original, pageRequest("/log/1.A.1"));

    // The wire gets a fresh generic Error — no driver internals.
    expect(result).toBeInstanceOf(Error);
    expect(result).not.toBe(original);
    expect((result as Error).message).toBe(GENERIC_SERVERFN_FAULT_MESSAGE);
    expect((result as Error).message).not.toContain("video_structure");
  });

  it("redacts an unexpected fault on a PUBLIC route reached via a server-fn HTTP call (client nav)", () => {
    const result = redactServerFnFault(driverError(), serverFnRequest("/log/1.A.1"));

    expect((result as Error).message).toBe(GENERIC_SERVERFN_FAULT_MESSAGE);
  });

  it("keeps the detailed message on an ADMIN route (SSR)", () => {
    const original = driverError();

    const result = redactServerFnFault(original, pageRequest("/admin/reach"));

    // Operator-only diagnostics: the raw error passes through untouched.
    expect(result).toBe(original);
    expect((result as Error).message).toContain("no such column: t.video_structure");
  });

  it("keeps the detailed message on an ADMIN route reached via a server-fn HTTP call (client nav)", () => {
    const original = driverError();

    // The server-fn endpoint carries no page path; the /admin page is in the Referer.
    const result = redactServerFnFault(original, serverFnRequest("/admin/reach"));

    expect(result).toBe(original);
  });

  it("does NOT trust an /admin Referer on a PUBLIC page's SSR request", () => {
    // An operator navigating /admin -> /log carries an /admin Referer on the public
    // page's SSR request. Because there is no `x-tsr-serverFn` header, the Referer is
    // ignored and the page's own path decides: still public, still redacted.
    const headers = new Headers({ referer: "https://fluncle.com/admin/reach" });
    const request = new Request("https://fluncle.com/log/1.A.1", { headers });

    const result = redactServerFnFault(driverError(), request);

    expect((result as Error).message).toBe(GENERIC_SERVERFN_FAULT_MESSAGE);
  });

  it("redacts when the page cannot be determined (no request context, no Referer)", () => {
    // The safe default: no context => treat as public.
    expect((redactServerFnFault(driverError(), undefined) as Error).message).toBe(
      GENERIC_SERVERFN_FAULT_MESSAGE,
    );
    expect((redactServerFnFault(driverError(), serverFnRequest(null)) as Error).message).toBe(
      GENERIC_SERVERFN_FAULT_MESSAGE,
    );
  });

  it("echoes a deliberate ApiError untouched on a public route (a client contract)", () => {
    const apiError = new ApiError("youtube_not_configured", "YouTube OAuth is not configured", 400);

    const result = redactServerFnFault(apiError, pageRequest("/log/1.A.1"));

    expect(result).toBe(apiError);
    expect((result as ApiError).message).toBe("YouTube OAuth is not configured");
  });

  it("sends the FULL fault to the log and Sentry, on public AND admin", () => {
    const publicError = driverError();

    redactServerFnFault(publicError, pageRequest("/log/1.A.1"));

    expect(logEvent).toHaveBeenCalledWith("error", "serverfn.unexpected-fault", {
      error: publicError,
      path: "/log/1.A.1",
    });
    expect(captureException).toHaveBeenCalledWith(publicError, {
      tags: { source: "serverfn.redaction" },
    });

    vi.clearAllMocks();

    const adminError = driverError();

    redactServerFnFault(adminError, pageRequest("/admin/reach"));

    expect(logEvent).toHaveBeenCalledWith("error", "serverfn.unexpected-fault", {
      error: adminError,
      path: "/admin/reach",
    });
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("does NOT log or capture a deliberate ApiError (it is not an unexpected fault)", () => {
    redactServerFnFault(new ApiError("rate_limited", "Slow down", 429), pageRequest("/log/1.A.1"));

    expect(logEvent).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });
});
