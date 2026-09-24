// THE PUBLIC CHROME'S KEYBOARD AND OUTLINE CONTRACT, on the pages the discovery programme serves.
//
// Two promises: the first Tab stop is a skip link that lands focus on the page itself, and every
// page's heading outline opens on its own H1 — the search palette, closed, contributes no heading.

import { expect, test, type Page } from "@playwright/test";
import { blockExternalRequests } from "./browser";

const PAGES = ["/", "/search", "/tracks", "/artists", "/albums", "/labels", "/fresh"] as const;

async function hydrate(page: Page, path: string): Promise<void> {
  const response = await page.goto(path, { waitUntil: "networkidle" });

  expect(response?.status()).toBe(200);
  await expect(page.locator("html[data-discovery-listening]")).toBeAttached({ timeout: 30_000 });
}

for (const path of PAGES) {
  test(`${path} opens its outline on its own H1`, async ({ page }) => {
    await blockExternalRequests(page);
    await hydrate(page, path);

    const outline = await page
      .locator("h1, h2, h3, h4, h5, h6")
      .evaluateAll((headings) => headings.map((heading) => heading.tagName));

    expect(outline[0], `the first heading on ${path}`).toBe("H1");
  });
}

test("the first Tab stop skips the top bar and lands on the page", async ({ page }) => {
  await blockExternalRequests(page);
  await hydrate(page, "/tracks");

  await page.keyboard.press("Tab");

  const skip = page.getByRole("link", { name: "Skip to the page" });

  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();

  await page.keyboard.press("Enter");
  await expect(page.locator("#content")).toBeFocused();
});
