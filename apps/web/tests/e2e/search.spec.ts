import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { blockExternalRequests } from "./browser";
import {
  SEEDED_FINDING_TITLES,
  SEEDED_FUTURE_RELEASE,
  SEEDED_PARTIAL_RELEASE,
  SEEDED_SONIC_ANCHOR,
  SEEDED_SONIC_NEIGHBOUR,
  SEEDED_STYLE,
} from "./seed";

const SEEDED_ARTIST_NAME = "Nova Kestrel";
const SEEDED_LABEL_NAME = "Driftwave Audio";

const FIRST_FINDING_TITLE = SEEDED_FINDING_TITLES[0];
const FIRST_FINDING_COORDINATE = "701.1.0A";

const NO_MATCH_TOKEN = "zzzqqx";

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

async function typeQuery(page: Page, query: string): Promise<void> {
  const input = page.getByPlaceholder("A name, a coordinate, or the sound of it…");

  await input.fill("");
  await input.fill(query);
}

test("search dialog resolves the deterministic tiers over the seeded archive", async ({ page }) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  const rawHtml = await (await page.request.get("/")).text();
  expect(rawHtml, "SSR HTML should carry the search trigger").toContain("Search the archive");

  const response = await page.goto("/", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  const trigger = page.getByRole("button", { name: "Search the archive" });
  const input = page.getByPlaceholder("A name, a coordinate, or the sound of it…");

  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(input).toBeHidden({ timeout: 2000 });
    await trigger.click();
    await expect(input).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });

  await typeQuery(page, "Aurora");
  await expect(page.getByRole("option", { name: new RegExp(FIRST_FINDING_TITLE) })).toBeVisible();

  await typeQuery(page, SEEDED_ARTIST_NAME);
  await expect(page.getByRole("option", { exact: true, name: SEEDED_ARTIST_NAME })).toBeVisible();

  await typeQuery(page, FIRST_FINDING_COORDINATE);
  await expect(page.getByRole("option", { name: new RegExp(FIRST_FINDING_TITLE) })).toBeVisible();

  await typeQuery(page, NO_MATCH_TOKEN);
  await expect(page.getByText("Nothing out here.")).toBeVisible();

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});

test("tracks hub SSRs the archive and round-trips its filters through the URL", async ({
  page,
}) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  const rawHtml = await (await page.request.get("/tracks")).text();
  for (const title of SEEDED_FINDING_TITLES) {
    expect(rawHtml, `SSR HTML should contain "${title}"`).toContain(title);
  }
  expect(rawHtml).not.toContain(SEEDED_FUTURE_RELEASE.title);
  expect(rawHtml).toContain(SEEDED_PARTIAL_RELEASE.title);

  const response = await page.goto("/tracks", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  for (const title of SEEDED_FINDING_TITLES) {
    await expect(page.getByText(title, { exact: false }).first()).toBeVisible();
  }

  const keyPill = page.getByRole("combobox", { name: "Key: Any key" });

  await expect(async () => {
    await page.keyboard.press("Escape");
    await keyPill.click();
    await expect(page.getByRole("option", { exact: true, name: "A minor" })).toBeVisible({
      timeout: 3000,
    });
  }).toPass({ timeout: 30_000 });

  await page.getByRole("option", { exact: true, name: "A minor" }).click();

  await expect(page).toHaveURL(/[?&]key=A\+minor/);
  await expect(page.getByText("No tracks match those filters.")).toBeVisible();

  await page.reload({ waitUntil: "networkidle" });
  await expect(page).toHaveURL(/[?&]key=A\+minor/);
  await expect(page.getByRole("combobox", { name: "Key: A minor" })).toBeVisible();
  await expect(page.getByText("No tracks match those filters.")).toBeVisible();

  await page.goto(`/tracks?label=${encodeURIComponent(SEEDED_LABEL_NAME)}`, {
    waitUntil: "networkidle",
  });
  await expect(page.getByRole("combobox", { name: `Label: ${SEEDED_LABEL_NAME}` })).toBeVisible();
  for (const title of SEEDED_FINDING_TITLES) {
    await expect(page.getByText(title, { exact: false }).first()).toBeVisible();
  }

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});

const SEARCH_SHOT_DIR = process.env.SEARCH_SHOT_DIR ?? join(process.cwd(), ".dev", "search");

const DESKTOP = { height: 900, width: 1440 };
const MOBILE = { height: 844, width: 390 };

const QUERY_KINDS = [
  {
    expected: [FIRST_FINDING_TITLE],
    kind: "text",
    query: "Aurora",
  },
  {
    expected: [SEEDED_ARTIST_NAME],
    kind: "entity",
    query: SEEDED_ARTIST_NAME,
  },
  {
    expected: ["Reading by name only right now."],
    kind: "structured",
    query: `${SEEDED_ARTIST_NAME} tracks in A minor`,
  },
  {
    expected: [SEEDED_SONIC_NEIGHBOUR.title],
    kind: "sonic",
    query: `tracks that sound like ${SEEDED_SONIC_ANCHOR.title}`,
  },
] as const;

test("the whole query state lives in the URL, for every kind of query", async ({ page }) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  for (const { expected, kind, query } of QUERY_KINDS) {
    const url = `/search?q=${encodeURIComponent(query)}`;

    const rawHtml = await (await page.request.get(url)).text();
    for (const text of expected) {
      expect(rawHtml, `${kind}: the SSR HTML should already carry "${text}"`).toContain(text);
    }

    const response = await page.goto(url, { waitUntil: "networkidle" });
    expect(response?.status(), `${kind}: a shared URL must load`).toBe(200);
    for (const text of expected) {
      await expect(page.getByText(text, { exact: false }).first()).toBeVisible();
    }

    await expect(page.locator("#search-page-q")).toHaveValue(query);

    await page.reload({ waitUntil: "networkidle" });
    await expect(page).toHaveURL(
      new RegExp(`q=${encodeURIComponent(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
    for (const text of expected) {
      await expect(page.getByText(text, { exact: false }).first()).toBeVisible();
    }
  }

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});

test("a style ranks the seeded catalogue by its anchor artists' sound", async ({ page }) => {
  await blockExternalRequests(page);

  const queryUrl = `/search?q=${SEEDED_STYLE.slug}`;
  const rawHtml = await (await page.request.get(queryUrl)).text();
  let prior = -1;

  for (const title of SEEDED_STYLE.rankedTitles) {
    const position = rawHtml.indexOf(title);
    expect(position, `${title} must follow the preceding style track in SSR`).toBeGreaterThan(
      prior,
    );
    prior = position;
  }

  expect(rawHtml).not.toContain("Reading by name only right now.");

  await page.goto(`/tracks?sound=${SEEDED_STYLE.slug}`, { waitUntil: "networkidle" });
  await expect(page.locator(".log-index-intro")).toContainText("closest to Liquid first");

  const rankedIds = await page
    .locator("a[href^='/track/e2e-style-']")
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")?.split("/").at(-1)));

  expect(rankedIds).toEqual(SEEDED_STYLE.rankedTrackIds);
});

test("a coordinate resolves on the page WITHOUT bouncing the URL away", async ({ page }) => {
  await blockExternalRequests(page);

  await page.goto(`/search?q=${FIRST_FINDING_COORDINATE}`, { waitUntil: "networkidle" });

  await expect(page).toHaveURL(new RegExp(`/search\\?q=${FIRST_FINDING_COORDINATE}$`));
  await expect(page.getByRole("link", { name: new RegExp(FIRST_FINDING_TITLE) })).toBeVisible();
  await expect(page.getByText(FIRST_FINDING_COORDINATE).first()).toBeVisible();
});

test("back and forward walk the searches a reader actually made", async ({ page }) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  await page.goto("/search", { waitUntil: "networkidle" });

  const field = page.locator("#search-page-q");

  const palette = page.getByRole("dialog");

  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden({ timeout: 2000 });
    await page.keyboard.press("ControlOrMeta+k");
    await expect(palette).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  await field.fill("Aurora");
  await field.press("Enter");
  await expect(page).toHaveURL(/q=Aurora/);
  await expect(page.getByText(FIRST_FINDING_TITLE).first()).toBeVisible();

  await field.fill(SEEDED_ARTIST_NAME);
  await field.press("Enter");
  await expect(page).toHaveURL(/Kestrel/);

  await expect(page.getByRole("link", { exact: true, name: SEEDED_ARTIST_NAME })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/q=Aurora/);
  await expect(field).toHaveValue("Aurora");
  await expect(page.getByText(FIRST_FINDING_TITLE).first()).toBeVisible();

  await page.goForward();
  await expect(page).toHaveURL(/Kestrel/);
  await expect(page.getByRole("link", { exact: true, name: SEEDED_ARTIST_NAME })).toBeVisible();
  await expect(field).toHaveValue(SEEDED_ARTIST_NAME);

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});

test("⌘K stays the accelerator on every public page and HANDS OFF to the surface", async ({
  page,
}) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  await page.goto("/log", { waitUntil: "networkidle" });

  const dialogInput = page.getByPlaceholder("A name, a coordinate, or the sound of it…");

  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(dialogInput).toBeHidden({ timeout: 2000 });
    await page.keyboard.press("ControlOrMeta+k");
    await expect(dialogInput).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });

  await dialogInput.fill("Aurora");

  await expect(page.getByRole("option", { name: new RegExp(FIRST_FINDING_TITLE) })).toBeVisible();

  const handoff = page.getByRole("option", { name: "Open this search as a page" });
  await expect(handoff).toBeVisible();
  await handoff.click();

  await expect(page).toHaveURL(/\/search\?q=Aurora$/);
  await expect(page.locator("#search-page-q")).toHaveValue("Aurora");
  await expect(page.getByText(FIRST_FINDING_TITLE).first()).toBeVisible();

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});

test("the handoff is offered even when the palette found nothing", async ({ page }) => {
  await blockExternalRequests(page);

  await page.goto("/log", { waitUntil: "networkidle" });

  const dialogInput = page.getByPlaceholder("A name, a coordinate, or the sound of it…");

  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(dialogInput).toBeHidden({ timeout: 2000 });
    await page.keyboard.press("ControlOrMeta+k");
    await expect(dialogInput).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });

  await dialogInput.fill(NO_MATCH_TOKEN);

  await expect(page.getByText("Nothing out here.")).toBeVisible();
  await expect(page.getByRole("option", { name: "Open this search as a page" })).toBeVisible();
});

test("the zero state teaches with real, followable example queries", async ({ page }) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  const rawHtml = await (await page.request.get("/search")).text();
  expect(rawHtml).toContain("Give me a name, a coordinate, or the sound of a track.");
  expect(rawHtml).toContain('href="/search?q=netsky"');

  await page.goto("/search", { waitUntil: "networkidle" });

  const examples = page.locator(".search-page-examples a");
  await expect(examples).toHaveCount(4);

  await examples.first().click();
  await expect(page).toHaveURL(/\/search\?q=netsky$/);
  await expect(page.locator("#search-page-q")).toHaveValue("netsky");

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});

test("the empty states name what happened and offer a way back", async ({ page }) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  await page.goto(`/search?q=${NO_MATCH_TOKEN}`, { waitUntil: "networkidle" });
  await expect(page.getByText(`Nothing out here for “${NO_MATCH_TOKEN}”.`)).toBeVisible();

  const wayBack = page.getByRole("link", { name: "dig through my tracks" });
  await expect(wayBack).toBeVisible();

  await expect(page.locator(".search-page-examples a")).toHaveCount(4);

  await page.goto("/search?q=999.9.9Z", { waitUntil: "networkidle" });
  await expect(page.getByText("No finding at that coordinate.")).toBeVisible();
  await expect(page.getByText("Nothing out here for")).toBeHidden();

  await wayBack.click();
  await expect(page).toHaveURL(/\/tracks$/);

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});

test("the surface is fully keyboard-operable with a visible focus indicator", async ({ page }) => {
  await blockExternalRequests(page);
  await page.goto(`/search?q=${encodeURIComponent("Aurora")}`, { waitUntil: "networkidle" });

  const targets = [
    ".search-page-input",
    ".search-page-submit",
    ".play-cover",
    ".discovery-row-link",
    ".track-menu-trigger",
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

      const visible = await page.evaluate((inputSelector) => {
        const active = document.activeElement;

        if (!active) {
          return { outlineStyle: "none", outlineWidth: "0px", shadow: "none" };
        }

        const painted = active.matches(".discovery-row-link")
          ? (active.closest(".discovery-row") ?? active)
          : active.matches(inputSelector) && active.parentElement
            ? active.parentElement
            : active;
        const style = getComputedStyle(painted);

        return {
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
          shadow: style.boxShadow,
        };
      }, ".search-page-input");

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
    `every control must be reachable by Tab; missing ${targets
      .filter((target) => !found.has(target))
      .join(", ")}`,
  ).toEqual([...targets].sort());

  await page.locator(".search-page-input").focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(SEEDED_ARTIST_NAME);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/Kestrel/);
});

test.describe("reduced motion", () => {
  test("every transition on the surface is genuinely absent under prefers-reduced-motion", async ({
    page,
  }) => {
    await blockExternalRequests(page);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/search?q=${encodeURIComponent("Aurora")}`, { waitUntil: "networkidle" });

    const reduced = await page.evaluate(
      () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    );
    expect(reduced, "the context should be running with reduced motion").toBe(true);

    const moving = await page.evaluate(() => {
      const selectors = [
        ".search-page-field",
        ".search-page-input",
        ".search-page-submit",
        ".search-example",
        ".search-page-row",
        ".search-cover",
        ".discovery-row",
        ".discovery-row-art",
        ".play-cover-glyph",
        ".track-menu-trigger",
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
  });
});

test("every line of text clears WCAG AA against what is actually behind it", async ({ page }) => {
  await blockExternalRequests(page);
  await page.goto(`/search?q=${encodeURIComponent("Aurora")}`, { waitUntil: "networkidle" });

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
    const root = document.querySelector(".search-page");

    if (!root) {
      return ["no .search-page on the document"];
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

      const composited = over(background, { ...base, a: 1 });
      const measured = ratio(parse(style.color), composited);

      if (measured < floor) {
        problems.push(
          `${element.className || element.tagName} "${(element.textContent ?? "").trim().slice(0, 40)}" — ${measured.toFixed(2)}:1, needs ${floor}:1`,
        );
      }
    }

    return problems;
  });

  expect(failures, `these lines fail WCAG AA:\n${failures.join("\n")}`).toEqual([]);
});

test("the surface reads at both widths, and the evidence is retained", async ({ page }) => {
  await blockExternalRequests(page);

  mkdirSync(SEARCH_SHOT_DIR, { recursive: true });

  for (const [name, viewport] of [
    ["desktop-1440x900", DESKTOP],
    ["mobile-390x844", MOBILE],
  ] as const) {
    await page.setViewportSize(viewport);
    await page.goto(`/search?q=${encodeURIComponent("Aurora")}`, { waitUntil: "networkidle" });

    for (const selector of [".search-page-form", ".search-page-matchline", ".discovery-list"]) {
      const part = page.locator(selector).first();
      await expect(part, `${selector} should render at ${name}`).toBeVisible();
      const box = await part.boundingBox();
      expect(box?.height ?? 0, `${selector} should have height at ${name}`).toBeGreaterThan(0);
    }

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `no horizontal bleed at ${name}`).toBeLessThanOrEqual(1);

    const submit = await page.locator(".search-page-submit").boundingBox();
    expect(
      submit?.height ?? 0,
      `the submit control should be a real target at ${name}`,
    ).toBeGreaterThanOrEqual(40);

    await page.screenshot({ fullPage: true, path: join(SEARCH_SHOT_DIR, `${name}.png`) });
  }

  await page.setViewportSize(MOBILE);
  await page.goto("/search", { waitUntil: "networkidle" });
  await expect(page.locator(".search-page-examples a").first()).toBeVisible();
  await page.screenshot({ fullPage: true, path: join(SEARCH_SHOT_DIR, "mobile-390x844-zero.png") });
});
