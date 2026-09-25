import { describe, expect, it } from "vitest";
import { hubHref, hubOrderParam } from "./hub-order";

describe("hub order params", () => {
  it("keeps the two named views and folds everything else to the default", () => {
    expect(hubOrderParam("az")).toBe("az");
    expect(hubOrderParam("recent")).toBe("recent");
    expect(hubOrderParam("most")).toBeUndefined();
    expect(hubOrderParam("oldest")).toBeUndefined();
    expect(hubOrderParam(undefined)).toBeUndefined();
  });

  it("builds the bare path for the default view and drops every default param", () => {
    expect(hubHref("/labels", {})).toBe("/labels");
    expect(hubHref("/labels", { order: "most", page: 1 })).toBe("/labels");
    expect(hubHref("/labels", { page: 3 })).toBe("/labels?page=3");
    expect(hubHref("/artists", { order: "az", page: 2 })).toBe("/artists?order=az&page=2");
    expect(hubHref("/albums", { order: "recent", q: "hosp" })).toBe("/albums?q=hosp&order=recent");
  });
});
