import { describe, expect, it } from "vitest";
import { parseAccountTab } from "./shared";

// The account URL contract: only `saves` and `settings` ride in `?tab`. The Galaxy is
// the DEFAULT door, so it is deliberately never a valid explicit value — a bare
// `/account` (and any junk value) resolves to `undefined`, which the route reads as
// the Galaxy. This guards the wayfinding + loader tab-routing against drift.
describe("parseAccountTab", () => {
  it("accepts the two doors that ride in the URL", () => {
    expect(parseAccountTab("saves")).toBe("saves");
    expect(parseAccountTab("settings")).toBe("settings");
  });

  it("treats the Galaxy as implicit — never an explicit tab value", () => {
    expect(parseAccountTab("galaxy")).toBeUndefined();
  });

  it("folds an absent or junk value to undefined (the default door)", () => {
    expect(parseAccountTab(undefined)).toBeUndefined();
    expect(parseAccountTab("")).toBeUndefined();
    expect(parseAccountTab("Saves")).toBeUndefined();
    expect(parseAccountTab(42)).toBeUndefined();
    expect(parseAccountTab(null)).toBeUndefined();
  });
});
