import { beforeAll, describe, expect, it, vi } from "vitest";
import { verifyState } from "./env";
import {
  clearedStateCookie,
  mintOauthState,
  stateCookieName,
  stateIsBoundToThisBrowser,
} from "./oauth-state";

// The OAuth state browser binding (./oauth-state.ts).
//
// BEFORE: the state carried a `nonce` that was never stored anywhere, so it proved
// nothing — a still-fresh state lifted from a log or a URL could be replayed at the
// callback with the attacker's own authorization code, and Fluncle would store THEIR
// platform tokens. AFTER: the start leg also hands the browser an HttpOnly cookie
// holding that nonce, and the callback refuses the exchange unless the two match.
//
// THE CLI CARVE-OUT IS GONE. `fluncle admin auth <platform>` used to receive the
// PROVIDER's authorize URL with a `bind: "none"` state — replayable for ten minutes,
// because the operator opened it in a client that had never been handed a cookie. A
// Bearer-carried start now prints a Fluncle-origin handoff link instead
// (./oauth-handoff.ts + its suite), so this module mints exactly one kind of state and
// the callback gate REJECTS every other `bind` rather than waving it through.

const SESSION_SECRET = "test-session-secret-oauth-state";

beforeAll(() => {
  process.env.ADMIN_SESSION_SECRET = SESSION_SECRET;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-22T12:00:00.000Z"));
});

/** Parse a `Set-Cookie` into `{ name, value, attributes }`. */
function parseSetCookie(header: string): {
  attributes: string[];
  name: string;
  value: string;
} {
  const [pair, ...attributes] = header.split("; ");
  const eq = pair?.indexOf("=") ?? -1;

  return {
    attributes,
    name: pair?.slice(0, eq) ?? "",
    value: pair?.slice(eq + 1) ?? "",
  };
}

function callbackRequest(cookie?: string): Request {
  return new Request("https://www.fluncle.com/api/admin/youtube/auth/callback?code=c&state=s", {
    headers: cookie === undefined ? {} : { cookie },
    method: "GET",
  });
}

describe("stateCookieName", () => {
  it("is one cookie PER FLOW, so two concurrent connects cannot clobber each other", () => {
    expect(stateCookieName("youtube-auth")).toBe("fluncle_oauth_youtube_auth");
    expect(stateCookieName("mixcloud-auth")).toBe("fluncle_oauth_mixcloud_auth");
    expect(stateCookieName("admin-login")).toBe("fluncle_oauth_admin_login");
    expect(
      new Set(["youtube-auth", "mixcloud-auth", "admin-login"].map(stateCookieName)).size,
    ).toBe(3);
  });

  it("is a legal cookie name even for an odd purpose", () => {
    expect(stateCookieName("Weird Purpose!")).toBe("fluncle_oauth_weird_purpose_");
  });
});

describe("mintOauthState", () => {
  it("signs a bound state and hands back the matching nonce cookie", async () => {
    const { setCookie, state } = await mintOauthState("youtube-auth");
    const payload = await verifyState(state);

    expect(payload).toMatchObject({ bind: "cookie", purpose: "youtube-auth" });
    expect(typeof payload.nonce).toBe("string");

    const cookie = parseSetCookie(setCookie ?? "");

    expect(cookie.name).toBe("fluncle_oauth_youtube_auth");
    expect(cookie.value).toBe(payload.nonce);
  });

  it("sets HttpOnly + SameSite=Lax + a 10-minute life, scoped to /api", async () => {
    const { setCookie } = await mintOauthState("youtube-auth");
    const { attributes } = parseSetCookie(setCookie ?? "");

    expect(attributes).toContain("HttpOnly");
    // Lax, not Strict: the callback is a top-level cross-site GET navigation back
    // from the platform, and Strict would drop the cookie there and break the flow.
    expect(attributes).toContain("SameSite=Lax");
    expect(attributes).toContain("Path=/api");
    expect(attributes).toContain("Max-Age=600");
  });

  it("mints a FRESH nonce every time (no reuse across starts)", async () => {
    const first = await mintOauthState("youtube-auth");
    const second = await mintOauthState("youtube-auth");

    expect(parseSetCookie(first.setCookie ?? "").value).not.toBe(
      parseSetCookie(second.setCookie ?? "").value,
    );
  });

  it("has NO unbound variant — every mint binds, so `setCookie` is unconditional", async () => {
    for (const purpose of ["youtube-auth", "mixcloud-auth", "admin-login"]) {
      const { setCookie, state } = await mintOauthState(purpose);

      expect(setCookie).toBeTypeOf("string");
      expect(await verifyState(state)).toMatchObject({ bind: "cookie", purpose });
    }
  });

  it("carries extra claims (the login's handoff ticket) but never lets one shadow `bind`", async () => {
    const { state } = await mintOauthState("admin-login", {
      bind: "none",
      handoff: "ticket-value",
      purpose: "spotify-auth",
    });

    // The fixed fields are spread LAST, so a caller cannot downgrade the binding or
    // repoint the purpose by naming one of them in `claims`.
    expect(await verifyState(state)).toMatchObject({
      bind: "cookie",
      handoff: "ticket-value",
      purpose: "admin-login",
    });
  });
});

describe("stateIsBoundToThisBrowser — the callback gate", () => {
  it("ACCEPTS the browser that started the flow (cookie matches the nonce)", async () => {
    const { setCookie, state } = await mintOauthState("youtube-auth");
    const payload = await verifyState(state);

    expect(stateIsBoundToThisBrowser(callbackRequest(setCookie?.split("; ")[0]), payload)).toBe(
      true,
    );
  });

  it("REFUSES a state replayed in a browser that has no cookie", async () => {
    const { state } = await mintOauthState("youtube-auth");
    const payload = await verifyState(state);

    expect(stateIsBoundToThisBrowser(callbackRequest(), payload)).toBe(false);
    expect(stateIsBoundToThisBrowser(callbackRequest("other=1"), payload)).toBe(false);
    expect(stateIsBoundToThisBrowser(callbackRequest("fluncle_oauth_youtube_auth="), payload)).toBe(
      false,
    );
  });

  it("REFUSES a state whose nonce is not the one this browser holds", async () => {
    const mine = await mintOauthState("youtube-auth");
    const theirs = await mintOauthState("youtube-auth");
    const theirPayload = await verifyState(theirs.state);

    // My browser presents MY nonce against THEIR state — the two halves must match.
    expect(
      stateIsBoundToThisBrowser(callbackRequest(mine.setCookie?.split("; ")[0]), theirPayload),
    ).toBe(false);
  });

  it("REFUSES a cross-FLOW cookie (a YouTube nonce cannot satisfy a Mixcloud state)", async () => {
    const youtube = await mintOauthState("youtube-auth");
    const mixcloud = await mintOauthState("mixcloud-auth");
    const mixcloudPayload = await verifyState(mixcloud.state);

    expect(
      stateIsBoundToThisBrowser(
        callbackRequest(youtube.setCookie?.split("; ")[0]),
        mixcloudPayload,
      ),
    ).toBe(false);
  });

  it("ALLOWS two concurrent flows: each cookie satisfies its own state", async () => {
    const youtube = await mintOauthState("youtube-auth");
    const mixcloud = await mintOauthState("mixcloud-auth");
    const both = [youtube, mixcloud].map((m) => m.setCookie?.split("; ")[0]).join("; ");

    expect(stateIsBoundToThisBrowser(callbackRequest(both), await verifyState(youtube.state))).toBe(
      true,
    );
    expect(
      stateIsBoundToThisBrowser(callbackRequest(both), await verifyState(mixcloud.state)),
    ).toBe(true);
  });

  it('REJECTS the retired `bind: "none"` even with the right cookie present', () => {
    // The unbound state is gone with the CLI carve-out. A state still carrying it is
    // either pre-deploy (it expires in ten minutes) or someone re-signing an old
    // shape — either way the callback refuses rather than skipping the cookie check.
    expect(
      stateIsBoundToThisBrowser(callbackRequest("fluncle_oauth_youtube_auth=n"), {
        bind: "none",
        iat: Date.now(),
        nonce: "n",
        purpose: "youtube-auth",
      }),
    ).toBe(false);
  });

  it("REJECTS a state with no `bind` at all (reject-unknown, not pass-through)", () => {
    expect(
      stateIsBoundToThisBrowser(callbackRequest("fluncle_oauth_youtube_auth=n"), {
        iat: Date.now(),
        nonce: "n",
        purpose: "youtube-auth",
      }),
    ).toBe(false);
  });

  it("refuses a bound state with a missing purpose or nonce (nothing to match on)", () => {
    expect(
      stateIsBoundToThisBrowser(callbackRequest("fluncle_oauth_youtube_auth=n"), {
        bind: "cookie",
        nonce: "n",
      }),
    ).toBe(false);
    expect(
      stateIsBoundToThisBrowser(callbackRequest("fluncle_oauth_youtube_auth=n"), {
        bind: "cookie",
        purpose: "youtube-auth",
      }),
    ).toBe(false);
  });
});

describe("clearedStateCookie", () => {
  it("expires the nonce so a state is single-use even in its own browser", () => {
    const { attributes, name, value } = parseSetCookie(clearedStateCookie("youtube-auth"));

    expect(name).toBe("fluncle_oauth_youtube_auth");
    expect(value).toBe("");
    expect(attributes).toContain("Max-Age=0");
    expect(attributes).toContain("HttpOnly");
    expect(attributes).toContain("Path=/api");
  });
});
