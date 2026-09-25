import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { signGrant } from "./admin-auth";
import { ADMIN_COOKIE_NAME } from "./env";
import { GENERIC_SERVERFN_FAULT_MESSAGE, redactServerFnFault } from "./serverfn-fault";
import { DueWorkMaintenancePendingError } from "./due-work";
import { ApiError } from "./spotify";

const logEvent = vi.fn();

vi.mock("./log", () => ({
  logEvent: (...args: unknown[]) => logEvent(...args),
}));

const captureException = vi.fn();

vi.mock("@sentry/cloudflare", () => ({
  captureException: (...args: unknown[]) => captureException(...args),
}));

vi.mock("./settings", () => ({
  deleteSetting: async () => {},
  getSetting: async () => undefined,
  setSetting: async () => {},
}));

const OPERATOR_TOKEN = "test-token-serverfn-fault-operator";
const SESSION_SECRET = "test-session-secret-serverfn-fault";

beforeAll(() => {
  process.env.FLUNCLE_API_TOKEN = OPERATOR_TOKEN;
  process.env.ADMIN_SESSION_SECRET = SESSION_SECRET;
});

afterEach(() => {
  vi.clearAllMocks();
});

function driverError(): Error {
  const error = new Error(
    "SQLITE_INPUT_ERROR: SQLite input error: no such column: t.video_structure",
  );
  error.name = "LibsqlError";

  return error;
}

function pageRequest(pathname: string, headers?: Record<string, string>): Request {
  return new Request(`https://fluncle.com${pathname}`, { headers });
}

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

    expect(result).toBeInstanceOf(Error);
    expect(result).not.toBe(original);
    expect((result as Error).message).toBe(GENERIC_SERVERFN_FAULT_MESSAGE);
    expect((result as Error).message).not.toContain("video_structure");
  });

  it("redacts SPOOFED admin headers with NO valid credential (the reopened-leak guard)", async () => {
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

    expect(result).toBe(original);
    expect((result as Error).message).toContain("no such column: t.video_structure");
  });

  it("keeps the detail for a VERIFIED operator via the signed grant cookie on a client-nav server-fn call", async () => {
    const original = driverError();

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

  it("does NOT log or capture a deferred due-work read", async () => {
    const pending = new DueWorkMaintenancePendingError("finding.render");

    const redacted = await redactServerFnFault(pending, pageRequest("/admin/renders"));

    expect(redacted).toBe(pending);
    expect(logEvent).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });
});
