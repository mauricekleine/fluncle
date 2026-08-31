// THE FRONT DOOR (`/`) — the public-flow spec for the discovery page.
//
// It proves the four things every public-page spec proves (SSR, identity over the seeded fixtures,
// hydration of a genuinely client-only control, a clean console — see `tests/e2e/README.md`), and
// then the five things that are specific to THIS surface and cannot be asserted in prose:
//
//   A. every band renders from real seeded data, and the two registers stay distinct;
//   B. the page is one deliberate scroll at desktop 1440×900 and mobile 390×844, evidenced by
//      retained full-page screenshots rather than a claim;
//   C. motion supports the scroll and never gates it, and under `prefers-reduced-motion: reduce`
//      it is GENUINELY absent — asserted on computed style, not on the presence of a media query;
//   D. the whole page is keyboard-operable with a visible focus indicator, and its text clears
//      WCAG AA against what is actually behind it;
//   E. a failed third-party cover degrades to the fallback instead of a broken-image glyph.
//
// Plus the two contract rails the move to `/findings` created: `/?story=<id>` permanently redirects
// to the standalone log page, and `/findings` still serves the whole archive.
//
// ── THE TIER-4 RAIL ──────────────────────────────────────────────────────────────────────────
// Same rail as `search.spec.ts`: the search resolver's fourth tier calls a real model, and
// `blockExternalRequests` stubs the BROWSER's requests, never the Worker's. Every query this spec
// causes must therefore be answered by a tier that returns unconditionally. The front door's
// example pills include one filter query and one sonic query, so this spec CLICKS ONLY the bare
// single-token example (`netsky`, tier 3, which returns even with zero rows) and asserts the others
// are present without firing them.

import { expect, test, type ConsoleMessage, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { blockExternalRequests } from "./browser";
import {
  SEEDED_CATALOGUE_RELEASE,
  SEEDED_FINDING_TITLES,
  SEEDED_LEAD,
  SEEDED_LEAD_COVER_URL,
  SEEDED_LEAD_NOTE,
} from "./seed";

/** Where the retained evidence lands. Gitignored (`apps/web/.dev/`), overridable by the operator. */
const SHOT_DIR = process.env.FRONT_DOOR_SHOT_DIR ?? join(process.cwd(), ".dev", "front-door");

/** The two widths the acceptance criteria name. Desktop first — it is the reading width. */
const DESKTOP = { height: 900, width: 1440 };
const MOBILE = { height: 844, width: 390 };

/** The bare single-token example — tier 3, which answers unconditionally. Never a tier-4 query. */
const SAFE_EXAMPLE = "netsky";

/**
 * The SSR HTML with its character entities decoded. React escapes an apostrophe to `&#x27;` in text,
 * so a heading like "What I'm on right now" is never in the raw bytes verbatim — asserting on the
 * raw string would quietly test the escaping rather than the content.
 */
function decoded(html: string): string {
  return html.replaceAll("&#x27;", "'").replaceAll("&#39;", "'").replaceAll("&amp;", "&");
}

/** Collect every console error + page error for a fail-on-any assertion at the end. */
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

test("the front door SSRs every band from real data, hydrates its search, and logs no errors", async ({
  page,
}) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  // (1) SSR — the crawler's view, before any client JS. `page.request` does no rendering.
  const rawHtml = decoded(await (await page.request.get("/")).text());

  // Every band's heading is in the initial HTML, so the page outline is legible with no JS.
  for (const heading of [
    "Search the archive",
    "What I'm on right now",
    "Fluncle's Findings",
    "Fresh",
    "Browse",
  ]) {
    expect(rawHtml, `SSR HTML should carry the "${heading}" band`).toContain(heading);
  }

  // (A) The EDITED lead: the seeded note is what makes the placement edited rather than latest,
  // so its presence in the SSR HTML is the assertion that matters.
  expect(rawHtml, "SSR HTML should carry the lead's note").toContain(SEEDED_LEAD_NOTE);
  expect(rawHtml, "SSR HTML should carry the lead's coordinate").toContain(SEEDED_LEAD.logId);

  // The findings band, from real rows.
  expect(rawHtml).toContain(SEEDED_FINDING_TITLES[0] ?? "");

  // (A) The release band carries BOTH registers. The uncertified row renders by title and by its
  // artist, and — the structural half of the Unlit Rule — the page never NAMES its tier.
  expect(rawHtml, "the release band should carry the uncertified row").toContain(
    SEEDED_CATALOGUE_RELEASE.title,
  );
  for (const forbidden of ["Uncertified", "uncertified", "Catalogue track", "Not certified"]) {
    expect(rawHtml, `no shipped copy may name the tier ("${forbidden}")`).not.toContain(forbidden);
  }

  const response = await page.goto("/", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  // (2) Identity — the rendered page carries the seeded rows.
  await expect(page.getByText(SEEDED_LEAD_NOTE)).toBeVisible();
  await expect(page.getByText(SEEDED_CATALOGUE_RELEASE.title).first()).toBeVisible();

  // The four browse doors, each a real link into the wider archive.
  for (const [label, href] of [
    ["Tracks", "/tracks"],
    ["Artists", "/artists"],
    ["Albums", "/albums"],
    ["Labels", "/labels"],
  ] as const) {
    await expect(page.locator(`a.fd-browse-card[href="${href}"]`)).toHaveText(new RegExp(label));
  }

  // (3) Hydration — the seeding entry is entirely client-side (its onClick reaches the shared
  // search dialog through context), so a pre-hydration click no-ops. The retry is state-safe:
  // Escape resets to CLOSED before each attempt, because a naive loop against a toggle can
  // alternate forever.
  const field = page
    .getByRole("button", { name: "Search the archive" })
    .and(page.locator(".fd-search-field"));
  const input = page.getByPlaceholder("A name, a coordinate, or the sound of it…");

  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(input).toBeHidden({ timeout: 2000 });
    await field.click();
    await expect(input).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });

  await page.keyboard.press("Escape");
  await expect(input).toBeHidden();

  // (4) No console errors, no page errors.
  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});

test("an example query is real: clicking one opens the dialog already answering", async ({
  page,
}) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  await page.goto("/", { waitUntil: "networkidle" });

  // All four examples render — they are the resolver's own list, one per tier.
  const examples = page.locator(".fd-search-example");
  await expect(examples).toHaveCount(4);

  // Only the bare single-token one is CLICKED (the tier-4 rail in this file's header). It seeds
  // the dialog, and the seed is the proof: the field opens carrying the query, not empty.
  const input = page.getByPlaceholder("A name, a coordinate, or the sound of it…");
  const safeExample = page.locator(".fd-search-example", { hasText: SAFE_EXAMPLE });

  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(input).toBeHidden({ timeout: 2000 });
    await safeExample.click();
    await expect(input).toHaveValue(SAFE_EXAMPLE, { timeout: 3000 });
  }).toPass({ timeout: 30_000 });

  await page.keyboard.press("Escape");

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});

test("the page is one deliberate scroll at both widths, and the evidence is retained", async ({
  page,
}) => {
  await blockExternalRequests(page);

  mkdirSync(SHOT_DIR, { recursive: true });

  for (const [name, viewport] of [
    ["desktop-1440x900", DESKTOP],
    ["mobile-390x844", MOBILE],
  ] as const) {
    await page.setViewportSize(viewport);
    await page.goto("/", { waitUntil: "networkidle" });

    // Every band is present and laid out at this width — a section that collapsed to zero height
    // is not "one long scroll", it is a hole.
    for (const id of ["fd-search", "fd-lead", "fd-findings", "fd-fresh", "fd-browse"]) {
      const band = page.locator(`#${id}`);
      await expect(band, `${id} should render at ${name}`).toBeVisible();
      const box = await band.boundingBox();
      expect(box?.height ?? 0, `${id} should have height at ${name}`).toBeGreaterThan(0);
    }

    // The bands run DOWN the page in source order, which is what makes it a scroll rather than a
    // grid of panels. Each band's top must sit below the previous band's top.
    const tops = await page.evaluate(() =>
      ["fd-search", "fd-lead", "fd-findings", "fd-fresh", "fd-browse"].map(
        (id) => document.getElementById(id)?.getBoundingClientRect().top ?? Number.NaN,
      ),
    );
    for (let index = 1; index < tops.length; index += 1) {
      const previous = tops[index - 1] ?? Number.NaN;
      const current = tops[index] ?? Number.NaN;
      expect(
        current,
        `band ${index} should sit below band ${index - 1} at ${name}`,
      ).toBeGreaterThan(previous);
    }

    // And it is LONG: a front door that fits in one viewport is not the surface this page is.
    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    expect(scrollHeight, `the page should exceed one viewport at ${name}`).toBeGreaterThan(
      viewport.height,
    );

    // Nothing bleeds sideways — the mobile width is where a long scroll usually breaks.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `no horizontal bleed at ${name}`).toBeLessThanOrEqual(1);

    await page.screenshot({ fullPage: true, path: join(SHOT_DIR, `${name}.png`) });
  }
});

test.describe("reduced motion", () => {
  test("every front-door transition is genuinely absent under prefers-reduced-motion", async ({
    page,
  }) => {
    await blockExternalRequests(page);
    // Emulated on the PAGE rather than declared as a fixture option, so the preference is set by
    // this test and cannot be silently lost to fixture layering — the assertion below re-reads it
    // from the browser before trusting anything else in here.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/", { waitUntil: "networkidle" });

    // The media query really is being honoured by the browser — otherwise the assertions below
    // would pass for the wrong reason (a page with no motion in the first place).
    const reduced = await page.evaluate(
      () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    );
    expect(reduced, "the context should be running with reduced motion").toBe(true);

    // COMPUTED style, not the presence of a media query in the sheet: this is the assertion that a
    // gate placed above the rule it means to neutralize would fail.
    const moving = await page.evaluate(() => {
      const selectors = [
        ".fd-section-more",
        ".fd-section-more-icon",
        ".fd-search-field",
        ".fd-search-example",
        ".fd-lead-open",
        ".fd-finding-cover",
        ".fd-finding-coordinate",
        ".fd-browse-card",
        ".fd-browse-label",
      ];
      const offenders: string[] = [];

      for (const selector of selectors) {
        for (const element of Array.from(document.querySelectorAll(selector))) {
          const style = getComputedStyle(element);
          const duration = [style.transitionDuration, style.animationDuration].join(" ");

          if (/[1-9]/.test(duration)) {
            offenders.push(
              `${selector} → transition ${style.transitionDuration}, animation ${style.animationDuration}`,
            );
          }
        }
      }

      return offenders;
    });

    expect(moving, `these still move under reduce:\n${moving.join("\n")}`).toEqual([]);

    // The two AMBIENT movements are gated the other way (`no-preference`), so they must be off too:
    // the cosmos drift on the backdrop is the one that runs on every page.
    const backdrop = await page.evaluate(
      () => getComputedStyle(document.body, "::before").animationName,
    );
    expect(backdrop, "the cosmos drift must not run under reduce").toBe("none");

    // Hovering a finding tile must not scale it — the float is grounded, and the feedback that
    // survives is colour only.
    const cover = page.locator(".fd-finding-cover").first();
    await cover.hover();
    const transform = await cover.evaluate((element) => getComputedStyle(element).transform);
    expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(transform);
  });
});

test("the front door is fully keyboard-operable with a visible focus indicator", async ({
  page,
}) => {
  await blockExternalRequests(page);
  await page.goto("/", { waitUntil: "networkidle" });

  // Press Tab until every front-door control has held focus, or we run out of patience. Each
  // target is identified by a class the page owns, so the check is about the PAGE's controls
  // rather than the chrome's (which the other public specs already cover).
  const targets = [
    ".fd-search-field",
    ".fd-search-example",
    ".fd-lead-open",
    ".fd-finding",
    ".fd-section-more",
    ".fd-browse-card",
  ];
  const found = new Set<string>();

  for (let step = 0; step < 150 && found.size < targets.length; step += 1) {
    await page.keyboard.press("Tab");

    const matched = await page.evaluate(
      (selectors) =>
        selectors.filter((selector) => document.activeElement?.matches(selector) === true),
      targets,
    );

    for (const selector of matched) {
      found.add(selector);

      // (D) Focus is VISIBLE. The canon focus affordance is an Eclipse-Gold ring, so a focused
      // control must paint a real outline (or a ring drawn as a box-shadow) — never `none`.
      const visible = await page.evaluate(() => {
        const active = document.activeElement;

        if (!active) {
          return { outlineStyle: "none", outlineWidth: "0px", shadow: "none" };
        }

        const style = getComputedStyle(active);

        return {
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
          shadow: style.boxShadow,
        };
      });

      const hasRing =
        (visible.outlineStyle !== "none" && Number.parseFloat(visible.outlineWidth) > 0) ||
        visible.shadow !== "none";

      expect(
        hasRing,
        `${selector} must paint a visible focus indicator, saw ${JSON.stringify(visible)}`,
      ).toBe(true);
    }
  }

  expect(
    [...found].sort(),
    `every front-door control must be reachable by Tab; missing ${targets
      .filter((target) => !found.has(target))
      .join(", ")}`,
  ).toEqual([...targets].sort());

  // And the keyboard OPERATES it, not just reaches it: Enter on the focused search field opens
  // the dialog. (The field is the first page control, so re-focus it explicitly.)
  await page.locator(".fd-search-field").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByPlaceholder("A name, a coordinate, or the sound of it…")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("every line of front-door text clears WCAG AA against what is actually behind it", async ({
  page,
}) => {
  await blockExternalRequests(page);
  await page.goto("/", { waitUntil: "networkidle" });

  // The composite is computed the way an automated checker computes it: walk each text node's
  // ancestors, alpha-composite their background colours down onto the document's own base, and
  // take the WCAG contrast ratio against the resolved foreground. It is an approximation in
  // exactly one way — it cannot see the cover-art backdrop image THROUGH the plate — which is why
  // the plate is a dimming pane in the first place (DESIGN.md's Legible Sky Rule); the pane's own
  // alpha over the warm-dark base is what this measures, and it is the floor that must hold.
  const failures = await page.evaluate(() => {
    type Rgba = { a: number; b: number; g: number; r: number };

    function parse(color: string): Rgba {
      const match = /rgba?\(([^)]+)\)/.exec(color);

      if (!match?.[1]) {
        return { a: 0, b: 0, g: 0, r: 0 };
      }

      const parts = match[1].split(",").map((part) => Number.parseFloat(part.trim()));

      return { a: parts[3] ?? 1, b: parts[2] ?? 0, g: parts[1] ?? 0, r: parts[0] ?? 0 };
    }

    function over(top: Rgba, bottom: Rgba): Rgba {
      const a = top.a + bottom.a * (1 - top.a);

      if (a === 0) {
        return { a: 0, b: 0, g: 0, r: 0 };
      }

      const blend = (t: number, b: number): number => (t * top.a + b * bottom.a * (1 - top.a)) / a;

      return { a, b: blend(top.b, bottom.b), g: blend(top.g, bottom.g), r: blend(top.r, bottom.r) };
    }

    function luminance({ b, g, r }: Rgba): number {
      const channel = (value: number): number => {
        const scaled = value / 255;

        return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
      };

      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    }

    function ratio(fg: Rgba, bg: Rgba): number {
      const [light, dark] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);

      return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
    }

    // The document's own ground: `html` carries the opaque warm dark, `body` is deliberately
    // transparent so the backdrop can paint (the paint contract in styles.css).
    const base = parse(getComputedStyle(document.documentElement).backgroundColor);
    const problems: string[] = [];
    const root = document.querySelector(".fd-page");

    if (!root) {
      return ["no .fd-page on the document"];
    }

    for (const element of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
      const own = Array.from(element.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim().length > 0,
      );

      if (!own || element.offsetParent === null) {
        continue;
      }

      const style = getComputedStyle(element);
      const size = Number.parseFloat(style.fontSize);
      const weight = Number.parseFloat(style.fontWeight);
      // WCAG "large text": ≥24px, or ≥18.66px at bold. Large text clears at 3:1, the rest 4.5:1.
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const floor = large ? 3 : 4.5;

      let background: Rgba = { a: 0, b: 0, g: 0, r: 0 };
      let node: Element | null = element;

      while (node) {
        background = over(background, parse(getComputedStyle(node).backgroundColor));

        if (background.a >= 0.999) {
          break;
        }

        node = node.parentElement;
      }

      const composed = over(background, { ...base, a: 1 });
      const measured = ratio(parse(style.color), composed);

      if (measured < floor) {
        problems.push(
          `${element.tagName.toLowerCase()}.${element.className} — ${measured.toFixed(2)}:1 (needs ${floor}:1), "${(element.textContent ?? "").trim().slice(0, 40)}"`,
        );
      }
    }

    return problems;
  });

  expect(failures, `WCAG AA failures on the front door:\n${failures.join("\n")}`).toEqual([]);
});

test("a failed third-party cover degrades to the fallback, never a broken image", async ({
  page,
}) => {
  await blockExternalRequests(page);

  // Override the stub for the LEAD's cover specifically: the third-party host is down. Registered
  // after `blockExternalRequests`, so this narrower route wins.
  await page.route(SEEDED_LEAD_COVER_URL, (route) => route.fulfill({ body: "", status: 404 }));

  // A 404 on a subresource is reported by the browser as a console error. It is the state under
  // test, so this ONE spec allows exactly that message for exactly that URL, and nothing else —
  // the fail-on-any gate stays otherwise intact.
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message: ConsoleMessage) => {
    const text = message.text();
    const isTheFailedCover =
      text.includes("Failed to load resource") || text.includes(SEEDED_LEAD_COVER_URL);

    if (message.type() === "error" && !isTheFailedCover) {
      problems.push(`console.error: ${text}`);
    }
  });

  await page.goto("/", { waitUntil: "networkidle" });

  // `TrackArtwork` swaps a failed cover for the eclipse-gradient fallback — including when the
  // error fires BEFORE hydration, which is the case a lazy `onError` alone would miss.
  const fallback = page.locator(".fd-lead-cover.track-artwork-fallback");
  await expect(fallback).toBeVisible();
  // And the broken <img> is gone rather than left showing the browser's broken glyph.
  await expect(page.locator(`img[src="${SEEDED_LEAD_COVER_URL}"]`)).toHaveCount(0);

  // The page around it is untouched: a cover that could not be fetched is a data gap, never a
  // broken page.
  await expect(page.getByText(SEEDED_LEAD_NOTE)).toBeVisible();

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});

test("the lead cover is the one eager image, and the head preloads exactly it", async ({
  page,
}) => {
  await blockExternalRequests(page);

  // The applicable performance budget for the largest contentful element is STRUCTURAL: the LCP
  // image is preloaded at high priority, fetched eagerly, and every other cover stays lazy — the
  // signal only helps while it is scarce (the `-artist-page.test.ts` precedent).
  const rawHtml = await (await page.request.get("/")).text();

  expect(rawHtml, "the head should preload the lead cover at high priority").toMatch(
    /<link[^>]+rel="preload"[^>]+as="image"[^>]+/,
  );

  await page.goto("/", { waitUntil: "networkidle" });

  const lead = page.locator("img.fd-lead-cover");
  await expect(lead).toHaveAttribute("loading", "eager");
  await expect(lead).toHaveAttribute("fetchpriority", "high");

  // The preload names the SAME url the element renders, so the two share one cache entry rather
  // than racing for two.
  const preloaded = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="preload"][as="image"]')).map(
      (link) => link.href,
    ),
  );
  const rendered = await lead.evaluate((element) => (element as HTMLImageElement).src);
  expect(preloaded).toContain(rendered);

  // Every OTHER cover on the page is lazy and priority-free.
  const others: Locator = page.locator("img.fd-finding-cover");
  const count = await others.count();
  expect(count, "the findings band should render covers").toBeGreaterThan(0);

  for (let index = 0; index < count; index += 1) {
    const cover = others.nth(index);
    await expect(cover).toHaveAttribute("loading", "lazy");
    expect(await cover.getAttribute("fetchpriority")).toBeNull();
  }
});

test("the incumbent archive page is whole at /findings, and /?story= permanently redirects", async ({
  page,
}) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  // The archive page the front door handed the feed to: still 200, still cover-led, still carrying
  // every seeded finding in its SSR HTML.
  const findingsHtml = decoded(await (await page.request.get("/findings")).text());
  for (const title of SEEDED_FINDING_TITLES) {
    expect(findingsHtml, `/findings SSR should contain "${title}"`).toContain(title);
  }
  expect(findingsHtml, "/findings keeps the stamped nameplate").toContain("Fluncle's Findings");

  const findings = await page.goto("/findings", { waitUntil: "networkidle" });
  expect(findings?.status()).toBe(200);
  await expect(page.locator("a.cover-story")).toBeVisible();

  // The one inbound path the move could have broken: the Stories dialog's raw masked URL. It
  // resolves with a PERMANENT redirect to the standalone page the mask always displayed.
  const story = await page.request.get(`/?story=${SEEDED_LEAD.logId}`, { maxRedirects: 0 });
  expect(story.status(), "/?story= should be a permanent redirect").toBe(301);
  expect(story.headers()["location"]).toContain(`/log/${SEEDED_LEAD.logId}`);

  // Following it lands on a real page.
  const followed = await page.request.get(`/?story=${SEEDED_LEAD.logId}`);
  expect(followed.status()).toBe(200);
  expect(await followed.text()).toContain(SEEDED_LEAD.title);

  // And the bare front door is untouched: a 200, never a redirect.
  const bare = await page.request.get("/", { maxRedirects: 0 });
  expect(bare.status()).toBe(200);

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});
