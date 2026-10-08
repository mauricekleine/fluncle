import { parse } from "dotenv";
import { describe, expect, it } from "vitest";
import { dotenvLine } from "./dotenv-line";

describe("local secret file encoding", () => {
  it.each([
    "",
    "plain-token",
    'a"b',
    "back\\slash",
    "literal\\n",
    "tab\there",
    "line\nnext",
    "line\rnext",
    " space # dollar$ ",
    "single' and double\"",
  ])("preserves dotenv value %j", (value) => {
    expect(parse(dotenvLine("TOKEN", value))["TOKEN"]).toBe(value);
  });

  it("rejects an unrepresentable secret without including its value", () => {
    const value = "all'\"`\\n#tail";

    expect(() => dotenvLine("TOKEN", value)).toThrow("Cannot encode TOKEN");
  });
});
