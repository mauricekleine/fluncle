import { describe, expect, it } from "vitest";
import { deleteConfirmationMatches, deleteConfirmationWord } from "./delete-confirm";

describe("deleteConfirmationMatches", () => {
  it("arms only when the typed value matches the username (case- and space-insensitive)", () => {
    expect(deleteConfirmationMatches("raver", "raver")).toBe(true);
    expect(deleteConfirmationMatches("RAVER", "raver")).toBe(true);
    expect(deleteConfirmationMatches("  raver  ", "raver")).toBe(true);
  });

  it("stays disarmed on an empty or wrong entry", () => {
    expect(deleteConfirmationMatches("", "raver")).toBe(false);
    expect(deleteConfirmationMatches("   ", "raver")).toBe(false);
    expect(deleteConfirmationMatches("nope", "raver")).toBe(false);
  });

  it("falls back to the literal 'delete' when the account has no username", () => {
    expect(deleteConfirmationMatches("delete", undefined)).toBe(true);
    expect(deleteConfirmationMatches("DELETE", undefined)).toBe(true);
    expect(deleteConfirmationMatches("delete", "")).toBe(true);
    expect(deleteConfirmationMatches("raver", undefined)).toBe(false);
    expect(deleteConfirmationMatches("", undefined)).toBe(false);
  });
});

describe("deleteConfirmationWord", () => {
  it("is the username when present, else 'delete'", () => {
    expect(deleteConfirmationWord("raver")).toBe("raver");
    expect(deleteConfirmationWord(undefined)).toBe("delete");
    expect(deleteConfirmationWord("   ")).toBe("delete");
  });
});
