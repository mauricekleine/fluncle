import { describe, expect, it } from "vitest";
import { pageParam, textParam } from "./search-params";

// The coercers every paged public hub narrows its URL with. A query string is attacker- and
// crawler-authored, so the contract under test is TOLERANCE: junk folds to `undefined` (the bare
// canonical view) rather than throwing, clamping, or minting a second URL for the same content.

describe("pageParam", () => {
  it("keeps a page a reader can actually be on", () => {
    expect(pageParam("1")).toBe(1);
    expect(pageParam("42")).toBe(42);
    expect(pageParam(7)).toBe(7);
  });

  it("truncates toward the page a fractional value sits on", () => {
    expect(pageParam("2.9")).toBe(2);
  });

  it("drops anything that is not a page", () => {
    for (const value of [undefined, null, "", "  ", "abc", "0", "-3", NaN, Infinity, {}, []]) {
      expect(pageParam(value), JSON.stringify(value)).toBeUndefined();
    }
  });
});

describe("textParam", () => {
  it("keeps a trimmed non-empty string", () => {
    expect(textParam("netsky")).toBe("netsky");
    expect(textParam("  hospital  ")).toBe("hospital");
  });

  it("drops an empty, whitespace-only, or non-string value", () => {
    for (const value of [undefined, null, "", "   ", 12, true, {}, []]) {
      expect(textParam(value), JSON.stringify(value)).toBeUndefined();
    }
  });
});
