import { afterEach, describe, expect, it } from "vitest";
import { createFollowDigestToken, verifyFollowDigestToken } from "./follow-digest-tokens";

const originalSecret = process.env.BETTER_AUTH_SECRET;

afterEach(() => {
  if (originalSecret === undefined) {
    delete process.env.BETTER_AUTH_SECRET;
  } else {
    process.env.BETTER_AUTH_SECRET = originalSecret;
  }
});

describe("follow digest signed links", () => {
  it("accepts only the intended user and purpose", () => {
    process.env.BETTER_AUTH_SECRET = "unit-test-secret";
    const token = createFollowDigestToken("user.one", "manage");
    expect(verifyFollowDigestToken(token, "manage")).toBe("user.one");
    expect(verifyFollowDigestToken(token, "unsubscribe")).toBeNull();
    expect(
      verifyFollowDigestToken(
        `${Buffer.from("other").toString("base64url")}.${token.split(".").slice(1).join(".")}`,
        "manage",
      ),
    ).toBeNull();
    expect(verifyFollowDigestToken(`${token.slice(0, -1)}x`, "manage")).toBeNull();
  });
});
