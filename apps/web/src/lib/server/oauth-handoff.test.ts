import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { signOauthHandoff, signOauthState } from "./env";
import { handoffUrl, mintHandoffTicket, readHandoffTicket } from "./oauth-handoff";

// The handoff TICKET (./oauth-handoff.ts) — the carrier that lets a connect started in
// a terminal finish in a browser.
//
// A Bearer-carried start cannot safely hand a provider URL to a browser that has no nonce
// cookie. The ticket carries a Fluncle-origin link, and the mint happens inside the
// operator's logged-in browser.
//
// This suite is the ticket alone. The wire-up — the start route's carrier branch, and
// the handoff route's grant-cookie gate — is asserted end to end through the real
// handlers in ../../routes/api/admin/oauth-binding.test.ts.

const SESSION_SECRET = "test-session-secret-oauth-handoff";

beforeAll(() => {
  process.env.ADMIN_SESSION_SECRET = SESSION_SECRET;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("readHandoffTicket", () => {
  it("reads back the purpose a ticket was minted for", async () => {
    for (const purpose of [
      "instagram-auth",
      "mixcloud-auth",
      "spotify-auth",
      "tiktok-auth",
      "twitch-auth",
      "youtube-auth",
    ] as const) {
      expect(await readHandoffTicket(await mintHandoffTicket(purpose))).toBe(purpose);
    }
  });

  it("refuses a missing, empty, or garbage ticket", async () => {
    expect(await readHandoffTicket(null)).toBeUndefined();
    expect(await readHandoffTicket("")).toBeUndefined();
    expect(await readHandoffTicket("not-a-token")).toBeUndefined();
    expect(await readHandoffTicket("body.signature")).toBeUndefined();
  });

  it("refuses a ticket past its ten-minute window", async () => {
    const ticket = await mintHandoffTicket("youtube-auth");

    expect(await readHandoffTicket(ticket)).toBe("youtube-auth");

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);

    expect(await readHandoffTicket(ticket)).toBeUndefined();
  });

  it("refuses `admin-login` — logging in is what MINTS the cookie the handoff needs", async () => {
    // Signed under the real handoff subkey, so only the purpose allow-list stops it.
    // A login handoff could only ever loop: the route would bounce it to the login,
    // which would bounce it back.
    const ticket = await signOauthHandoff({ iat: Date.now(), purpose: "admin-login" });

    expect(await readHandoffTicket(ticket)).toBeUndefined();
  });

  it("refuses a purpose outside the registry, however well-formed", async () => {
    const ticket = await signOauthHandoff({ iat: Date.now(), purpose: "soundcloud-auth" });

    expect(await readHandoffTicket(ticket)).toBeUndefined();
  });

  it("refuses a ticket with no purpose claim at all", async () => {
    expect(await readHandoffTicket(await signOauthHandoff({ iat: Date.now() }))).toBeUndefined();
  });

  it("refuses an OAUTH STATE presented as a ticket — the two subkeys are separate", async () => {
    // Identical wire format, different label. Without the split, a handoff ticket and
    // an OAuth state would be interchangeable and the binding could be smuggled past.
    const state = await signOauthState({
      bind: "cookie",
      iat: Date.now(),
      nonce: "n",
      purpose: "youtube-auth",
    });

    expect(await readHandoffTicket(state)).toBeUndefined();
  });

  it("refuses a ticket signed under a DIFFERENT root secret", async () => {
    const ticket = await mintHandoffTicket("youtube-auth");

    process.env.ADMIN_SESSION_SECRET = "some-other-secret";
    expect(await readHandoffTicket(ticket)).toBeUndefined();
    process.env.ADMIN_SESSION_SECRET = SESSION_SECRET;
  });
});

describe("handoffUrl", () => {
  it("is a Fluncle-origin link on the canonical /api/v1 mount", async () => {
    const ticket = await mintHandoffTicket("youtube-auth");
    const url = new URL(handoffUrl("https://www.fluncle.com", ticket));

    expect(url.origin).toBe("https://www.fluncle.com");
    expect(url.pathname).toBe("/api/v1/admin/oauth/handoff");
    expect(url.searchParams.get("token")).toBe(ticket);
  });

  it("percent-encodes the ticket, so the value can never break out of the query", () => {
    expect(handoffUrl("", "a&b=c#d")).toBe("/api/v1/admin/oauth/handoff?token=a%26b%3Dc%23d");
  });
});
