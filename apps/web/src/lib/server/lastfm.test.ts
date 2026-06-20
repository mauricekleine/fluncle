import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signLastfmParams } from "@/lib/server/lastfm";

// The signature is the one load-bearing, easy-to-get-wrong bit: alphabetize the
// signed params, concatenate `<name><value>` with no separators, append the
// shared secret, MD5 (hex). These tests pin that against an independent md5 so a
// future refactor can't silently change the scheme.
describe("signLastfmParams", () => {
  const secret = "MY_SHARED_SECRET";

  it("alphabetizes params, concatenates name+value, appends the secret, MD5s", () => {
    const params = {
      api_key: "KEY",
      method: "auth.getToken",
    };

    // Independently derived expectation: api_key + method, sorted, + secret.
    const expected = createHash("md5")
      .update("api_keyKEYmethodauth.getToken" + secret, "utf8")
      .digest("hex");

    expect(signLastfmParams(params, secret)).toBe(expected);
  });

  it("matches the spec's worked example (auth.getMobileSession)", () => {
    // From last.fm/api/mobileauth: the exact concatenation the docs show.
    const params = {
      api_key: "YOUR_API_KEY",
      method: "auth.getMobileSession",
      password: "YOUR_PASSWORD",
      username: "YOUR_USERNAME",
    };
    const expected = createHash("md5")
      .update(
        "api_keyYOUR_API_KEYmethodauth.getMobileSessionpasswordYOUR_PASSWORDusernameYOUR_USERNAMEMY_SHARED_SECRET",
        "utf8",
      )
      .digest("hex");

    expect(signLastfmParams(params, secret)).toBe(expected);
  });

  it("excludes format, callback, and api_sig from the signature", () => {
    const signed = { api_key: "KEY", method: "track.love" };
    const withExcluded = {
      ...signed,
      api_sig: "stale",
      callback: "cb",
      format: "json",
    };

    // The excluded params must not change the signature.
    expect(signLastfmParams(withExcluded, secret)).toBe(signLastfmParams(signed, secret));
  });

  it("orders sk/track/artist deterministically for track.love regardless of input order", () => {
    const a = {
      api_key: "KEY",
      artist: "Teddy Killerz",
      method: "track.love",
      sk: "SESSION",
      track: "Gate",
    };
    const b = {
      api_key: "KEY",
      artist: "Teddy Killerz",
      method: "track.love",
      sk: "SESSION",
      track: "Gate",
    };

    const expected = createHash("md5")
      .update("api_keyKEYartistTeddy Killerzmethodtrack.loveskSESSIONtrackGate" + secret, "utf8")
      .digest("hex");

    expect(signLastfmParams(a, secret)).toBe(expected);
    expect(signLastfmParams(b, secret)).toBe(expected);
  });
});
