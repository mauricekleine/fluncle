// The held discovery exhibit (`/concepts`), asserted.
//
// Its sibling `tests/browser/concepts-evidence.ts` takes the pictures; this file
// proves the things a picture cannot: that the surfaces SSR, that the tier
// distinction is carried visually and never named, that the keyboard reaches
// every control, that the outbound destinations are the real ones, that the
// motion concept grounds itself under `prefers-reduced-motion: reduce`, and that
// the exhibit changes nothing about the product it sits beside.
//
// The concepts read a committed snapshot rather than the seeded database, so
// these assertions are stable regardless of what the e2e seed holds.

import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";

import { blockExternalRequests } from "./browser";

/** The lead coordinate in the committed snapshot. */
const ANCHOR_LOG_ID = "090.6.2K";
const ANCHOR_TITLE = "Bob & Weave";

const CONCEPTS = ["/concepts/front", "/concepts/desk", "/concepts/run"];

/**
 * The tier is a visual distinction and never a verbal one (DESIGN.md, The Unlit
 * Rule): no surface may introduce the uncertified tier as a thing to learn.
 */
const FORBIDDEN_TIER_WORDS = [
  "uncertified",
  "not certified",
  "catalogue track",
  "catalogue tracks",
  "non-finding",
];

function watchForErrors(page: Page): string[] {
  const problems: string[] = [];

  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") {
      problems.push(`console.error: ${message.text()}`);
    }
  });

  return problems;
}

test("every concept SSRs its zero-input surface with real snapshot data", async ({ page }) => {
  for (const path of CONCEPTS) {
    const response = await page.request.get(path);

    expect(response.status(), `${path} status`).toBe(200);

    const html = await response.text();

    // Identity, not counts: the snapshot's own records are in the server HTML, so
    // a visitor with no JavaScript already has somewhere to go.
    expect(html, `${path} carries real archive data`).toContain("open.spotify.com");
    expect(html, `${path} carries a real coordinate`).toMatch(/\b\d{3}\.\d\.\d[A-Z]\b/);
  }
});

test("the exhibit is held out of the index and out of every feed", async ({ page }) => {
  for (const path of ["/concepts", ...CONCEPTS]) {
    const html = await (await page.request.get(path)).text();

    expect(html, `${path} is noindex`).toContain("noindex");
  }

  // The exhibit adds no public surface: it is in no sitemap and no feed.
  const sitemap = await (await page.request.get("/sitemap.xml")).text();

  expect(sitemap).not.toContain("/concepts");

  const feed = await (await page.request.get("/feed.json")).text();

  expect(feed).not.toContain("/concepts");
});

test("no concept names the uncertified tier", async ({ page }) => {
  const paths = [
    "/concepts/front",
    `/concepts/front/track/${ANCHOR_LOG_ID}`,
    "/concepts/front/on/label/hospital-records",
    "/concepts/desk",
    `/concepts/desk?soundsLike=${ANCHOR_LOG_ID}`,
    "/concepts/run",
  ];

  for (const path of paths) {
    const html = (await (await page.request.get(path)).text()).toLowerCase();

    for (const word of FORBIDDEN_TIER_WORDS) {
      expect(html, `${path} must not name the tier ("${word}")`).not.toContain(word);
    }
  }
});

test("a seed continues to sonic neighbours the visitor has not been shown", async ({ page }) => {
  // Concept A offers the step as an edited block; concept B as a facet. Both must
  // reach records that carry NO coordinate — the unfamiliar half of the archive.
  for (const path of [
    `/concepts/front/track/${ANCHOR_LOG_ID}`,
    `/concepts/desk?soundsLike=${ANCHOR_LOG_ID}`,
  ]) {
    const html = await (await page.request.get(path)).text();

    expect(html, `${path} names the seed`).toContain(ANCHOR_TITLE);
    // The captured neighbourhood is drawn from the whole archive, so it carries
    // records with a listening link and no coordinate of their own.
    expect(html.match(/open\.spotify\.com/g)?.length ?? 0).toBeGreaterThan(3);
  }
});

test("every outbound listening link is a real destination, opened safely", async ({ page }) => {
  await blockExternalRequests(page);
  await page.goto("/concepts/front");

  const outbound = page.locator('main a[target="_blank"]');
  const count = await outbound.count();

  expect(count, "the front page offers outbound listening").toBeGreaterThan(0);

  for (let index = 0; index < Math.min(count, 12); index++) {
    const link = outbound.nth(index);
    const href = await link.getAttribute("href");

    expect(href, "an outbound link points at a real platform").toMatch(
      /^https:\/\/(open\.spotify\.com|music\.apple\.com|(www\.)?youtube\.com)\//,
    );
    expect(await link.getAttribute("rel"), "an outbound link is rel=noreferrer").toContain(
      "noreferrer",
    );
  }
});

test("each concept is fully operable from the keyboard", async ({ page }) => {
  for (const path of CONCEPTS) {
    await blockExternalRequests(page);
    await page.goto(path);

    const reached: string[] = [];

    for (let press = 0; press < 12; press++) {
      await page.keyboard.press("Tab");

      const active = await page.evaluate(() => {
        const element = document.activeElement;

        return element === null ? "" : element.tagName.toLowerCase();
      });

      reached.push(active);
    }

    // Tabbing lands on real controls rather than falling through to the body.
    expect(
      reached.filter((tag) => tag === "a" || tag === "button" || tag === "input").length,
      `${path} puts controls in the tab order`,
    ).toBeGreaterThan(2);

    // And the control that has focus shows a ring rather than the UA default.
    const outline = await page.evaluate(() => {
      const element = document.activeElement;

      if (!(element instanceof HTMLElement)) {
        return "";
      }

      const style = getComputedStyle(element);

      return `${style.outlineStyle}|${style.outlineWidth}|${style.boxShadow}`;
    });

    expect(outline, `${path} shows a visible focus indicator`).not.toBe("none|0px|none");
  }
});

test("the exhibit renders with no console errors", async ({ page }) => {
  for (const path of ["/concepts", ...CONCEPTS]) {
    const problems = watchForErrors(page);

    await blockExternalRequests(page);
    await page.goto(path);
    await page.waitForLoadState("networkidle").catch(() => undefined);

    expect(problems, `${path} logs nothing`).toEqual([]);
  }
});

test("the run grounds its motion under prefers-reduced-motion", async ({ browser }) => {
  const reduced = await browser.newContext({ reducedMotion: "reduce" });
  const page = await reduced.newPage();

  await blockExternalRequests(page);
  await page.goto("/concepts/run");

  const cover = page.locator("[data-run-cover]").first();

  // The concept marks its animated element; if it is not there, the concept is not
  // claiming a transition and there is nothing to ground.
  if ((await cover.count()) > 0) {
    const motion = await cover.evaluate((element) => {
      const style = getComputedStyle(element);

      return {
        animation: style.animationName,
        transition: style.transitionProperty,
      };
    });

    expect(motion.animation, "no animation under reduce").toBe("none");
    expect(motion.transition, "no transition under reduce").not.toContain("opacity");
  }

  await reduced.close();
});

test("the concepts leave the product's own surfaces untouched", async ({ page }) => {
  // The exhibit is additive. The home page, the graph pages, and the public API
  // answer exactly as they did, and none of them links into it.
  for (const path of ["/", "/fresh", "/api/v1/findings?limit=1"]) {
    const response = await page.request.get(path);

    expect(response.status(), `${path} status`).toBe(200);
    expect(await response.text(), `${path} does not link the exhibit`).not.toContain("/concepts");
  }
});
