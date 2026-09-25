import { expect, test, type ConsoleMessage, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { blockExternalRequests } from "./browser";
import {
  SEEDED_CATALOGUE_RELEASE,
  SEEDED_FINDING_TITLES,
  SEEDED_FUTURE_RELEASE,
  SEEDED_LEAD,
  SEEDED_LEAD_COVER_URL,
  SEEDED_LEAD_NOTE,
} from "./seed";

const SHOT_DIR = process.env.FRONT_DOOR_SHOT_DIR ?? join(process.cwd(), ".dev", "front-door");

const DESKTOP = { height: 900, width: 1440 };
const MOBILE = { height: 844, width: 390 };

const SAFE_EXAMPLE = "netsky";

function decoded(html: string): string {
  return html.replaceAll("&#x27;", "'").replaceAll("&#39;", "'").replaceAll("&amp;", "&");
}

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

  const rawHtml = decoded(await (await page.request.get("/")).text());

  for (const heading of [
    "Search the archive",
    "What I'm on right now",
    "Latest findings",
    "Fresh",
    "Dig through the crates",
  ]) {
    expect(rawHtml, `SSR HTML should carry the "${heading}" band`).toContain(heading);
  }

  expect(rawHtml, "SSR HTML should carry the lead's note").toContain(SEEDED_LEAD_NOTE);
  expect(rawHtml, "SSR HTML should carry the lead's coordinate").toContain(SEEDED_LEAD.logId);

  expect(rawHtml).toContain(SEEDED_FINDING_TITLES[0] ?? "");

  expect(rawHtml, "the release band should carry the uncertified row").toContain(
    SEEDED_CATALOGUE_RELEASE.title,
  );
  expect(rawHtml).not.toContain(SEEDED_FUTURE_RELEASE.title);
  for (const forbidden of ["Uncertified", "uncertified", "Catalogue track", "Not certified"]) {
    expect(rawHtml, `no shipped copy may name the tier ("${forbidden}")`).not.toContain(forbidden);
  }

  const response = await page.goto("/", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  await expect(page.getByText(SEEDED_LEAD_NOTE)).toBeVisible();
  await expect(page.getByText(SEEDED_CATALOGUE_RELEASE.title).first()).toBeVisible();

  for (const [label, href] of [
    ["Tracks", "/tracks"],
    ["Artists", "/artists"],
    ["Albums", "/albums"],
    ["Labels", "/labels"],
  ] as const) {
    await expect(page.locator(`a.fd-browse-card[href="${href}"]`)).toHaveText(new RegExp(label));
  }

  const field = page.locator("button.fd-search-field");
  const input = page.getByPlaceholder("A name, a coordinate, or the sound of it…");

  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(input).toBeHidden({ timeout: 2000 });
    await field.click();
    await expect(input).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });

  await page.keyboard.press("Escape");
  await expect(input).toBeHidden();

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});

test("an example query is real, and it is a LINK to the persistent surface", async ({ page }) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  const rawHtml = await (await page.request.get("/")).text();
  expect(rawHtml, "the examples should SSR as links into /search").toContain(
    `href="/search?q=${SAFE_EXAMPLE}"`,
  );

  await page.goto("/", { waitUntil: "networkidle" });

  const examples = page.locator("a.fd-search-example");
  await expect(examples).toHaveCount(4);

  await examples.filter({ hasText: SAFE_EXAMPLE }).click();
  await expect(page).toHaveURL(new RegExp(`/search\\?q=${SAFE_EXAMPLE}$`));
  await expect(page.locator("#search-page-q")).toHaveValue(SAFE_EXAMPLE);

  await page.goBack({ waitUntil: "networkidle" });
  await expect(page).toHaveURL(/\/$/);

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

    for (const id of ["fd-search", "fd-lead", "fd-findings", "fd-fresh", "fd-browse"]) {
      const band = page.locator(`#${id}`);
      await expect(band, `${id} should render at ${name}`).toBeVisible();
      const box = await band.boundingBox();
      expect(box?.height ?? 0, `${id} should have height at ${name}`).toBeGreaterThan(0);
    }

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

    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    expect(scrollHeight, `the page should exceed one viewport at ${name}`).toBeGreaterThan(
      viewport.height,
    );

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

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/", { waitUntil: "networkidle" });

    const reduced = await page.evaluate(
      () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    );
    expect(reduced, "the context should be running with reduced motion").toBe(true);

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

    const backdrop = await page.evaluate(
      () => getComputedStyle(document.body, "::before").animationName,
    );
    expect(backdrop, "the cosmos drift must not run under reduce").toBe("none");

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
  await expect(page.locator("html[data-discovery-listening]")).toBeAttached({ timeout: 30_000 });

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

  await page.route(SEEDED_LEAD_COVER_URL, (route) => route.fulfill({ body: "", status: 404 }));

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

  const fallback = page.locator(".fd-lead-cover.track-artwork-fallback");
  await expect(fallback).toBeVisible();

  await expect(page.locator(`img[src="${SEEDED_LEAD_COVER_URL}"]`)).toHaveCount(0);

  await expect(page.getByText(SEEDED_LEAD_NOTE)).toBeVisible();

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});

test("the lead cover is the one eager image, and the head preloads exactly it", async ({
  page,
}) => {
  await blockExternalRequests(page);

  const rawHtml = await (await page.request.get("/")).text();

  expect(rawHtml, "the head should preload the lead cover at high priority").toMatch(
    /<link[^>]+rel="preload"[^>]+as="image"[^>]+/,
  );

  await page.goto("/", { waitUntil: "networkidle" });

  const lead = page.locator("img.fd-lead-cover");
  await expect(lead).toHaveAttribute("loading", "eager");
  await expect(lead).toHaveAttribute("fetchpriority", "high");

  const preloaded = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="preload"][as="image"]')).map(
      (link) => link.href,
    ),
  );
  const rendered = await lead.evaluate((element) => (element as HTMLImageElement).src);
  expect(preloaded).toContain(rendered);

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

  const findingsHtml = decoded(await (await page.request.get("/findings")).text());
  for (const title of SEEDED_FINDING_TITLES) {
    expect(findingsHtml, `/findings SSR should contain "${title}"`).toContain(title);
  }
  expect(findingsHtml, "/findings keeps the stamped nameplate").toContain("Fluncle's Findings");

  const findings = await page.goto("/findings", { waitUntil: "networkidle" });
  expect(findings?.status()).toBe(200);
  await expect(page.locator("a.cover-story")).toBeVisible();

  const story = await page.request.get(`/?story=${SEEDED_LEAD.logId}`, { maxRedirects: 0 });
  expect(story.status(), "/?story= should be a permanent redirect").toBe(301);
  expect(story.headers()["location"]).toContain(`/log/${SEEDED_LEAD.logId}`);

  const followed = await page.request.get(`/?story=${SEEDED_LEAD.logId}`);
  expect(followed.status()).toBe(200);
  expect(await followed.text()).toContain(SEEDED_LEAD.title);

  const bare = await page.request.get("/", { maxRedirects: 0 });
  expect(bare.status()).toBe(200);

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});

test("the cover backdrop can paint on the front door: body stays transparent", async ({ page }) => {
  await blockExternalRequests(page);
  await page.goto("/");

  const paint = await page.evaluate(() => ({
    backdropImage: getComputedStyle(document.body, "::before").backgroundImage,
    bodyBackground: getComputedStyle(document.body).backgroundColor,
  }));

  expect(paint.bodyBackground).toBe("rgba(0, 0, 0, 0)");
  expect(paint.backdropImage).toContain("fluncle-cover-no-text");
});

test("every static page the sitemap submits still resolves", async ({ page }) => {
  await blockExternalRequests(page);

  const sitemap = await (await page.request.get("/sitemap/pages-1.xml")).text();
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1] ?? "");

  expect(locs.length, "the pages child should list the static hubs").toBeGreaterThan(5);

  expect(locs.some((loc) => loc.endsWith("/"))).toBe(true);
  expect(locs.some((loc) => loc.endsWith("/findings"))).toBe(true);

  for (const loc of locs) {
    const path = new URL(loc).pathname;
    const response = await page.request.get(path, { maxRedirects: 0 });

    expect(response.status(), `${path} (submitted by the sitemap) should resolve`).toBe(200);
  }
});
