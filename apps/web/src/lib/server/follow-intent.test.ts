import { describe, expect, it } from "vitest";
import {
  attachFollowIntent,
  FOLLOW_INTENT_TTL_MS,
  parseFollowTarget,
  signFollowIntent,
  verifyFollowIntent,
} from "./follow-intent";

const secret = "follow-intent-test-secret";
const target = { entityId: "label-1", kind: "label" } as const;

describe("follow intent", () => {
  it("round-trips for the same email regardless of case and whitespace", () => {
    const token = signFollowIntent({ email: "Dave@Example.com", secret, target });

    expect(verifyFollowIntent({ email: " dave@example.com ", secret, token })).toEqual(target);
  });

  it("carries no email in the clear", () => {
    const token = signFollowIntent({ email: "dave@example.com", secret, target });

    expect(Buffer.from(token.split(".")[0] ?? "", "base64url").toString()).not.toContain("dave");
  });

  it("rejects another email, another secret, a tampered body, and an expired token", () => {
    const now = Date.now();
    const token = signFollowIntent({ email: "dave@example.com", now, secret, target });
    const [body, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body ?? "", "base64url").toString()), i: "x" }),
    ).toString("base64url");

    expect(verifyFollowIntent({ email: "jade@example.com", secret, token })).toBeUndefined();
    expect(
      verifyFollowIntent({ email: "dave@example.com", secret: "other", token }),
    ).toBeUndefined();
    expect(
      verifyFollowIntent({ email: "dave@example.com", secret, token: `${forged}.${signature}` }),
    ).toBeUndefined();
    expect(
      verifyFollowIntent({
        email: "dave@example.com",
        now: now + FOLLOW_INTENT_TTL_MS + 1,
        secret,
        token,
      }),
    ).toBeUndefined();
  });

  it("parses only artist and label targets with an id", () => {
    expect(parseFollowTarget({ entityId: " a1 ", kind: "artist" })).toEqual({
      entityId: "a1",
      kind: "artist",
    });
    expect(parseFollowTarget({ entityId: "a1", kind: "album" })).toBeUndefined();
    expect(parseFollowTarget({ kind: "label" })).toBeUndefined();
    expect(parseFollowTarget("label:a1")).toBeUndefined();
  });

  it("threads the intent onto the link's callback path and keeps it on-site", () => {
    const link =
      "https://www.fluncle.com/api/auth/magic-link/verify?token=t&callbackURL=%2Flabel%2Fhospital&errorCallbackURL=%2Flabel%2Fhospital";
    const out = new URL(
      attachFollowIntent({
        baseUrl: "https://www.fluncle.com",
        intent: "abc.def",
        magicLinkUrl: link,
      }),
    );

    expect(out.searchParams.get("token")).toBe("t");
    expect(out.searchParams.get("callbackURL")).toBe("/label/hospital?follow=abc.def");

    const offsite = link.replace("%2Flabel%2Fhospital", "https%3A%2F%2Fevil.example%2F");

    expect(
      attachFollowIntent({
        baseUrl: "https://www.fluncle.com",
        intent: "abc.def",
        magicLinkUrl: offsite,
      }),
    ).toBe(offsite);
  });
});
