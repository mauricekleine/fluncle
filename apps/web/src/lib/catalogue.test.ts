import { describe, expect, it } from "vitest";
import { cataloguePageHref } from "./catalogue";

// The pager's anchors are what crawlers walk, so they must come out in the CANONICAL shape:
// default sort implicit, page 1 bare. Spelling the default out (`?sort=name&page=4`) minted
// URL variants whose canonical points elsewhere — the GSC crawled-not-indexed leak this
// helper closes.
describe("cataloguePageHref", () => {
  it("keeps the default sort implicit and page 1 bare", () => {
    expect(cataloguePageHref("/label/liquicity", 1, "name", "name")).toBe("/label/liquicity");
  });

  it("carries only the page when the sort is the default", () => {
    expect(cataloguePageHref("/label/liquicity", 4, "name", "name")).toBe(
      "/label/liquicity?page=4",
    );
  });

  it("carries only the sort when the reader left the default on page 1", () => {
    expect(cataloguePageHref("/label/liquicity", 1, "recent", "name")).toBe(
      "/label/liquicity?sort=recent",
    );
  });

  it("carries both when the reader left the default on a later page", () => {
    expect(cataloguePageHref("/label/liquicity", 4, "recent", "name")).toBe(
      "/label/liquicity?sort=recent&page=4",
    );
  });

  it("respects a per-page default (the artist page's recent-first)", () => {
    expect(cataloguePageHref("/artist/monrroe", 2, "recent", "recent")).toBe(
      "/artist/monrroe?page=2",
    );
    expect(cataloguePageHref("/artist/monrroe", 2, "name", "recent")).toBe(
      "/artist/monrroe?sort=name&page=2",
    );
  });
});
