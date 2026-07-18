// The crawlable hub components render REAL anchors into the SSR HTML — that is the whole point of
// this slice, so it is pinned here with `renderToStaticMarkup` (vitest env = node, no DOM needed).
// A crawler that runs no JS must be able to walk the A–Z lane and the pager as plain <a href>.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CataloguePager } from "./catalogue-groups";
import { CatalogueHubPageSection, HubLetterLane } from "./catalogue-hub-section";

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

    // The present letters resolve to real hrefs — "a" folds to the bare hub, "m" to its page.
    expect(html).toContain('<a class="catalogue-letter" href="/artists">A</a>');
    expect(html).toContain('<a class="catalogue-letter" href="/artists?page=3">M</a>');
    // An absent letter is a non-link, aria-hidden so a crawler ignores the dead glyph.
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain(">B</span>");
    // The nav carries its literal accessible name.
    expect(html).toContain('aria-label="Artists A to Z"');
  });

  it("renders nothing when the hub has no findings-free entities", () => {
    expect(
      renderToStaticMarkup(<HubLetterLane buildHref={buildHref} label="x" letters={[]} />),
    ).toBe("");
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

    // Real anchors, the crawlable spine of the paged variants.
    expect(html).toContain('href="/artists"'); // Previous → page 1 → the bare hub
    expect(html).toContain('href="/artists?page=3"'); // Next → page 3
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

describe("CatalogueHubPageSection", () => {
  it("SSRs the page's tiles plus its head lane and its footer pager", () => {
    const html = renderToStaticMarkup(
      <CatalogueHubPageSection
        gridClassName="artist-grid"
        heading="More artists"
        headingId="artists-catalogue-heading"
        items={[{ slug: "aphrodite" }, { slug: "bcee" }]}
        lane={
          <HubLetterLane
            buildHref={buildHref}
            label="Artists A to Z"
            letters={[{ letter: "a", page: 1 }]}
          />
        }
        listLabel="More artists"
        pager={
          <CataloguePager
            buildHref={buildHref}
            label="More artists, more pages"
            page={1}
            pageCount={3}
          />
        }
        renderTile={(entry) => (
          <li key={entry.slug}>
            <a href={`/artist/${entry.slug}`}>{entry.slug}</a>
          </li>
        )}
      />,
    );

    // Every tile is in the HTML (not fetched on scroll) — the crawler sees them all.
    expect(html).toContain('href="/artist/aphrodite"');
    expect(html).toContain('href="/artist/bcee"');
    // The lane rides in the head; the pager rides below.
    expect(html).toContain("catalogue-letter");
    expect(html).toContain("Page 1 of 3");
    expect(html).toContain('id="artists-catalogue-heading"');
  });
});
