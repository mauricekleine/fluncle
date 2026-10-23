import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authedJsonFetch, csrfJsonHeaders, fetchCsrfToken } from "./authed-fetch";

type Call = { init?: RequestInit; path: string };

let calls: Call[];
let location: { href: string };

function serve(...responses: Response[]): void {
  const queue = [...responses];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ init, path });
      const next = queue.shift();
      if (next === undefined) {
        throw new Error(`unexpected request to ${path}`);
      }
      return next;
    }),
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  calls = [];
  location = { href: "/mix" };
  vi.stubGlobal("window", { location });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("csrfJsonHeaders", () => {
  it("sends the token in the account mutation header as JSON", () => {
    expect(csrfJsonHeaders("tok")).toEqual({
      "Content-Type": "application/json",
      "x-fluncle-csrf": "tok",
    });
  });
});

describe("fetchCsrfToken", () => {
  it("returns the minted token", async () => {
    serve(json({ csrfToken: "tok", ok: true }));

    expect(await fetchCsrfToken()).toBe("tok");
    expect(calls.map((call) => call.path)).toEqual(["/api/v1/me/csrf"]);
    expect(location.href).toBe("/mix");
  });

  it("sends a lapsed session to sign in", async () => {
    serve(json({ code: "auth_required", ok: false }, 401));

    expect(await fetchCsrfToken()).toBeUndefined();
    expect(location.href).toBe("/account");
  });

  it("stays on the page when the caller ignores a lapsed session", async () => {
    serve(json({ code: "auth_required", ok: false }, 401));

    expect(await fetchCsrfToken({ onLapsedSession: "ignore" })).toBeUndefined();
    expect(location.href).toBe("/mix");
  });

  it("returns an empty token when the response carries none", async () => {
    serve(json({ ok: true }));

    expect(await fetchCsrfToken({ onLapsedSession: "ignore" })).toBe("");
  });
});

describe("authedJsonFetch", () => {
  it("mints a token, then sends the mutation with it", async () => {
    const accepted = json({ ok: true });
    serve(json({ csrfToken: "tok", ok: true }), accepted);

    const response = await authedJsonFetch("/api/v1/me/follows", {
      body: JSON.stringify({ id: "a" }),
      method: "POST",
    });

    expect(response).toBe(accepted);
    expect(calls[1]).toEqual({
      init: {
        body: JSON.stringify({ id: "a" }),
        headers: { "Content-Type": "application/json", "x-fluncle-csrf": "tok" },
        method: "POST",
      },
      path: "/api/v1/me/follows",
    });
  });

  it("never sends the mutation when the session has lapsed", async () => {
    serve(json({ code: "auth_required", ok: false }, 401));

    expect(await authedJsonFetch("/api/v1/me/follows", { method: "POST" })).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(location.href).toBe("/account");
  });

  it("sends a session that lapses mid-mutation to sign in", async () => {
    serve(json({ csrfToken: "tok", ok: true }), json({ code: "auth_required", ok: false }, 401));

    expect(await authedJsonFetch("/api/v1/me/follows", { method: "POST" })).toBeUndefined();
    expect(location.href).toBe("/account");
  });

  it("hands any other refusal back to the caller", async () => {
    const limited = json({ code: "rate_limited", ok: false }, 429);
    serve(json({ csrfToken: "tok", ok: true }), limited);

    expect(await authedJsonFetch("/api/v1/me/follows", { method: "POST" })).toBe(limited);
    expect(location.href).toBe("/mix");
  });
});
