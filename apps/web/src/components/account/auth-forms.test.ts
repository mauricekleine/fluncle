import { describe, expect, it } from "vitest";
import { MAGIC_LINK_CALLBACK_ERROR, MAGIC_LINK_FAILED, readCallbackError } from "./auth-forms";

describe("magic-link callback errors", () => {
  it("names an expired or reused link only for the token error", () => {
    expect(readCallbackError("?error=INVALID_TOKEN")).toBe(MAGIC_LINK_CALLBACK_ERROR);
  });

  it("does not blame the link for a server-side failure", () => {
    expect(readCallbackError("?error=failed_to_create_session")).toBe(MAGIC_LINK_FAILED);
  });

  it("says nothing on a clean landing", () => {
    expect(readCallbackError("?tab=saves")).toBeUndefined();
  });
});
