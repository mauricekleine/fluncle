import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { signGrant } from "./admin-auth";
import { ADMIN_COOKIE_NAME } from "./env";
import { GENERIC_SERVERFN_FAULT_MESSAGE, redactServerFnFault } from "./serverfn-fault";
import { ApiError } from "./spotify";

// `redactServerFnFault` is the wire-redaction discipline for TanStack Start server
// functions: it decides what may cross to the browser when a loader/server-fn throws.
// The property under test is the leak the 2026-07-26 incident exposed — a raw driver
// message reaching a PUBLIC browser — and its operator-only carve-out, which is gated
// on a VERIFIED admin principal (`adminRole`), NEVER on a spoofable path/header claim.

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

// The grant epoch lives in the `settings` KV (env.ts reads it via a lazy import).
// Stub it UNSET so a freshly signed grant round-trips (epoch 0). `adminRole` itself is
// the REAL implementation — the whole point is to prove the actual credential check
// gates the detail, not a mock of it.
vi.mock("./settings", () => ({
  deleteSetting: async () => {},
  // Epoch UNSET for every key — a freshly signed grant is epoch 0 and round-trips.
  getSetting: async () => undefined,
  setSetting: async () => {},
}));

const OPERATOR_TOKEN = "test-token-serverfn-fault-operator";
const SESSION_SECRET = "test-session-secret-serverfn-fault";

beforeAll(() => {
  // readEnv reads process.env at call time; dotenv never overrides an already-set
  // value, so these win and keep the suite independent of local secrets.
  process.env.FLUNCLE_API_TOKEN = OPERATOR_TOKEN;
  process.env.ADMIN_SESSION_SECRET = SESSION_SECRET;
});

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
// page — with whatever credential (or none) the browser carried.
function pageRequest(pathname: string, headers?: Record<string, string>): Request {
  return new Request(`https://fluncle.com${pathname}`, { headers });
}

// The client-navigation transport: the server fn is called over HTTP at its own
// endpoint, stamped `x-tsr-serverFn: true`, carrying whatever headers the caller set.
function serverFnRequest(headers: Record<string, string>): Request {
  return new Request("https://fluncle.com/_serverFn/getReach", {
    headers: { "x-tsr-serverFn": "true", ...headers },
  });
}

async function operatorCookieHeader(): Promise<Record<string, string>> {
  return { cookie: `${ADMIN_COOKIE_NAME}=${await signGrant()}` };
}

describe("redactServerFnFault", () => {
  it("redacts an unexpected fault for an UNAUTHENTICATED caller (public SSR)", async () => {
    const original = driverError();

    const result = await redactServerFnFault(original, pageRequest("/log/1.A.1"));

    // The wire gets a fresh generic Error — no driver internals.
    expect(result).toBeInstanceOf(Error);
    expect(result).not.toBe(original);
    expect((result as Error).message).toBe(GENERIC_SERVERFN_FAULT_MESSAGE);
    expect((result as Error).message).not.toContain("video_structure");
  });

  it("redacts SPOOFED admin headers with NO valid credential (the reopened-leak guard)", async () => {
    // The attack the verified-identity gate closes: any external caller can set both
    // of these on a direct call to a public server fn. Without a real credential they
    // must buy nothing.
    const result = await redactServerFnFault(
      driverError(),
      serverFnRequest({ referer: "https://fluncle.com/admin/reach" }),
    );

    expect((result as Error).message).toBe(GENERIC_SERVERFN_FAULT_MESSAGE);
  });

  it("keeps the detail for a VERIFIED operator via the signed grant cookie (SSR /admin)", async () => {
    const original = driverError();

    const result = await redactServerFnFault(
      original,
      pageRequest("/admin/reach", await operatorCookieHeader()),
    );

    // Operator diagnostics: the raw error passes through untouched.
    expect(result).toBe(original);
    expect((result as Error).message).toContain("no such column: t.video_structure");
  });

  it("keeps the detail for a VERIFIED operator via the signed grant cookie on a client-nav server-fn call", async () => {
    const original = driverError();

    // Same-origin server-fn fetches carry the grant cookie, so the operator keeps
    // detail on the client-navigation path too — via the real credential, not the URL.
    const result = await redactServerFnFault(
      original,
      serverFnRequest(await operatorCookieHeader()),
    );

    expect(result).toBe(original);
  });

  it("keeps the detail for a VERIFIED admin Bearer token", async () => {
    const original = driverError();

    const result = await redactServerFnFault(
      original,
      pageRequest("/log/1.A.1", { authorization: `Bearer ${OPERATOR_TOKEN}` }),
    );

    expect(result).toBe(original);
  });

  it("redacts a WRONG Bearer token (not a principal at all)", async () => {
    const result = await redactServerFnFault(
      driverError(),
      pageRequest("/admin/reach", { authorization: "Bearer nope" }),
    );

    expect((result as Error).message).toBe(GENERIC_SERVERFN_FAULT_MESSAGE);
  });

  it("redacts a TAMPERED grant cookie even on an /admin path", async () => {
    const grant = await signGrant();
    const tampered = `${grant.slice(0, -1)}${grant.at(-1) === "a" ? "b" : "a"}`;

    const result = await redactServerFnFault(
      driverError(),
      pageRequest("/admin/reach", { cookie: `${ADMIN_COOKIE_NAME}=${tampered}` }),
    );

    expect((result as Error).message).toBe(GENERIC_SERVERFN_FAULT_MESSAGE);
  });

  it("redacts when there is no request context (safe default)", async () => {
    expect(((await redactServerFnFault(driverError(), undefined)) as Error).message).toBe(
      GENERIC_SERVERFN_FAULT_MESSAGE,
    );
  });

  it("echoes a deliberate ApiError untouched for any caller (a client contract)", async () => {
    const apiError = new ApiError("youtube_not_configured", "YouTube OAuth is not configured", 400);

    const result = await redactServerFnFault(apiError, pageRequest("/log/1.A.1"));

    expect(result).toBe(apiError);
    expect((result as ApiError).message).toBe("YouTube OAuth is not configured");
  });

  it("sends the FULL fault to the log and Sentry, for public AND admin callers", async () => {
    const publicError = driverError();

    await redactServerFnFault(publicError, pageRequest("/log/1.A.1"));

    expect(logEvent).toHaveBeenCalledWith("error", "serverfn.unexpected-fault", {
      error: publicError,
      path: "/log/1.A.1",
    });
    expect(captureException).toHaveBeenCalledWith(publicError, {
      tags: { source: "serverfn.redaction" },
    });

    vi.clearAllMocks();

    const adminError = driverError();

    await redactServerFnFault(
      adminError,
      pageRequest("/admin/reach", await operatorCookieHeader()),
    );

    expect(logEvent).toHaveBeenCalledWith("error", "serverfn.unexpected-fault", {
      error: adminError,
      path: "/admin/reach",
    });
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("does NOT log or capture a deliberate ApiError (it is not an unexpected fault)", async () => {
    await redactServerFnFault(
      new ApiError("rate_limited", "Slow down", 429),
      pageRequest("/log/x"),
    );

    expect(logEvent).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });
});
