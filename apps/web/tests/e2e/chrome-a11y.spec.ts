// THE PUBLIC CHROME'S KEYBOARD AND OUTLINE CONTRACT.
//
// On every page the chrome wraps (the seven discovery pages here):
//   - the first Tab stop is "Skip to the page", visible when focused, and Enter moves focus to the
//     page region (`#content`), so the next Tab continues from the page;
//   - the heading outline opens on the page's OWN H1: one H1, inside the page region, and no heading
//     before it (the search palette, closed, contributes none);
//   - the page hydrates with a clean console.
// The search palette, OPEN, is a dialog named by its own title, and that title leaves the outline
// again when the palette closes.
// The chromeless public surfaces carry no skip link on purpose (public-chrome.tsx): they render no
// shared chrome to bypass. That precondition is asserted here, so the exemption cannot quietly stop
// being true.

import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { blockExternalRequests } from "./browser";

const PAGES = ["/", "/search", "/tracks", "/artists", "/albums", "/labels", "/fresh"] as const;
const CHROMELESS = ["/radio", "/galaxy", "/pipeline", "/device"] as const;

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

async function hydrate(page: Page, path: string): Promise<void> {
  const response = await page.goto(path, { waitUntil: "networkidle" });

  expect(response?.status()).toBe(200);
  await expect(page.locator("html[data-discovery-listening]")).toBeAttached({ timeout: 30_000 });
}

for (const path of PAGES) {
  test(`${path}: skip link first, the page's own H1 first, a clean console`, async ({ page }) => {
    await blockExternalRequests(page);

    const problems = watchForErrors(page);

    await hydrate(page, path);

    // The outline: exactly one H1, inside the page region, and nothing heads the document before it.
    const outline = await page.locator("h1, h2, h3, h4, h5, h6").evaluateAll((headings) =>
      headings.map((heading) => ({
        inPage: heading.closest("#content") !== null,
        tag: heading.tagName,
      })),
    );

    expect(outline[0], `the first heading on ${path}`).toEqual({ inPage: true, tag: "H1" });
    expect(
      outline.filter((heading) => heading.tag === "H1"),
      `${path} has one H1`,
    ).toHaveLength(1);

    // The first Tab stop is the skip link; it shows itself, and Enter lands focus on the page.
    await page.keyboard.press("Tab");

    const skip = page.getByRole("link", { name: "Skip to the page" });

    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(page.locator("#content")).toBeFocused();

    // The next Tab continues from the page, never back up into the top bar.
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(
        () =>
          document.activeElement?.closest(".nav-topbar") === null &&
          document.activeElement !== document.body,
      ),
      `the Tab after the skip on ${path} stays in the page`,
    ).toBe(true);

    expect(problems, `expected a clean console on ${path}, saw:\n${problems.join("\n")}`).toEqual(
      [],
    );
  });
}

test("the open palette is a dialog named by its title, and the title leaves with it", async ({
  page,
}) => {
  await blockExternalRequests(page);
  await hydrate(page, "/tracks");

  const titleHeading = page.getByRole("heading", { name: "Search the archive" });

  await expect(titleHeading).toHaveCount(0);

  await page.getByRole("button", { name: "Search the archive" }).click();

  const dialog = page.getByRole("dialog", { name: "Search the archive" });

  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Search the archive" })).toBeAttached();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(titleHeading).toHaveCount(0);
});

for (const path of CHROMELESS) {
  test(`${path} is chromeless: no shared chrome, so nothing for a skip link to bypass`, async ({
    page,
  }) => {
    await blockExternalRequests(page);

    const response = await page.goto(path, { waitUntil: "networkidle" });

    expect(response?.status()).toBe(200);
    await expect(page.locator("html[data-discovery-listening]")).toBeAttached({
      timeout: 30_000,
    });

    // The exemption's precondition: none of the shared chrome a skip link would bypass.
    await expect(page.locator(".nav-topbar")).toHaveCount(0);
    await expect(page.locator(".nav-footer")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Skip to the page" })).toHaveCount(0);
  });
}
