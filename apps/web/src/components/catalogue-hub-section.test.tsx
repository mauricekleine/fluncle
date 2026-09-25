import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CataloguePager } from "./catalogue-groups";
import { HubLetterLane, HubYearLane, laneScrollAffordances } from "./catalogue-hub-section";

const buildHref = (page: number) => (page <= 1 ? "/artists" : `/artists?page=${page}`);

describe("HubLetterLane", () => {
  it("renders a present letter as a real ?page=N anchor and an absent one as a muted span", () => {
    const html = renderToStaticMarkup(
      <HubLetterLane
        buildHref={buildHref}
        label="Artists A to Z"
        letters={[
          { letter: "a", page: 1 },
          { letter: "m", page: 3 },
        ]}
      />,
    );

    expect(html).toContain('<a class="catalogue-letter" href="/artists">A</a>');
    expect(html).toContain('<a class="catalogue-letter" href="/artists?page=3">M</a>');

    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain(">B</span>");

    expect(html).toContain('aria-label="Artists A to Z"');
  });

  it("renders nothing when the hub has no findings-free entities", () => {
    expect(
      renderToStaticMarkup(<HubLetterLane buildHref={buildHref} label="x" letters={[]} />),
    ).toBe("");
  });
});

describe("HubYearLane (the /tracks single-row year scroller)", () => {
  const buildYearHref = (page: number) => (page <= 1 ? "/tracks" : `/tracks?page=${page}`);

  it("SSRs every year as a real ?page=N anchor plus a caret on each side", () => {
    const html = renderToStaticMarkup(
      <HubYearLane
        buildHref={buildYearHref}
        label="Tracks by year"
        years={[
          { page: 1, year: "2026" },
          { page: 3, year: "2024" },
        ]}
      />,
    );

    expect(html).toContain('<a class="catalogue-letter" href="/tracks">2026</a>');
    expect(html).toContain('<a class="catalogue-letter" href="/tracks?page=3">2024</a>');

    expect(html).toContain('aria-label="Tracks by year"');
    expect(html).not.toContain("catalogue-letters");

    expect(html).toContain('aria-label="Scroll years left"');
    expect(html).toContain('aria-label="Scroll years right"');
    expect(html).toContain("<button");
  });

  it("renders nothing when the set spans no dated release", () => {
    expect(
      renderToStaticMarkup(<HubYearLane buildHref={buildYearHref} label="x" years={[]} />),
    ).toBe("");
  });
});

describe("laneScrollAffordances (the caret enable/disable logic)", () => {
  it("cannot go left at the start, can go right when content overflows", () => {
    expect(laneScrollAffordances({ clientWidth: 300, scrollLeft: 0, scrollWidth: 900 })).toEqual({
      canScrollLeft: false,
      canScrollRight: true,
    });
  });

  it("cannot go right once scrolled to the far end (1px slack for rounding)", () => {
    expect(laneScrollAffordances({ clientWidth: 300, scrollLeft: 600, scrollWidth: 900 })).toEqual({
      canScrollLeft: true,
      canScrollRight: false,
    });
  });

  it("offers neither direction when the content fits with no overflow", () => {
    expect(laneScrollAffordances({ clientWidth: 900, scrollLeft: 0, scrollWidth: 900 })).toEqual({
      canScrollLeft: false,
      canScrollRight: false,
    });
  });
});

describe("CataloguePager (the hub's numbered pager) renders real anchors", () => {
  it("emits Previous / Next / numbered links as <a href> in the SSR HTML", () => {
    const html = renderToStaticMarkup(
      <CataloguePager
        buildHref={buildHref}
        label="More artists, more pages"
        page={2}
        pageCount={4}
      />,
    );

    expect(html).toContain('href="/artists"');
    expect(html).toContain('href="/artists?page=3"');
    expect(html).toContain("Previous");
    expect(html).toContain("Next");
    expect(html).toContain("Page 2 of 4");
  });

  it("renders nothing for a single page (no pager to walk)", () => {
    expect(
      renderToStaticMarkup(
        <CataloguePager buildHref={buildHref} label="x" page={1} pageCount={1} />,
      ),
    ).toBe("");
  });
});
