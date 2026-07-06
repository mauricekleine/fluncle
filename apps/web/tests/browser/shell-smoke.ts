// The admin-shell browser smoke (docs/admin-shell.md §Verifying): drives every
// sidebar entry in a real Chrome as the operator, past hydration, at desktop
// and phone widths, and screenshots each stop. Run it against a live dev
// server after any shell or admin-chrome change:
//
//   BASE_URL=http://127.0.0.1:3000 OUT_DIR=/tmp/shell-smoke \
//     bun tests/browser/shell-smoke.ts
//
// Exits non-zero on a failed navigation, a missing page title, or any page
// error, and prints every console error it saw. Screenshots land in OUT_DIR.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Page } from "playwright-core";
import { launchBrowser, newAdminPage } from "./admin";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const OUT_DIR = process.env.OUT_DIR ?? "/tmp/admin-shell-smoke";

// Every sidebar entry, by its accessible link name, with the page title (the
// plate h1) its target renders. System leaves the shell for the public /status.
const ENTRIES: { expectH1: string; name: string; path: string }[] = [
  { expectH1: "Dashboard", name: "Dashboard", path: "/admin" },
  { expectH1: "Findings", name: "Findings", path: "/admin/findings" },
  { expectH1: "Plans", name: "Plans", path: "/admin/plans" },
  { expectH1: "Clip library", name: "Recordings", path: "/admin/clips" },
  { expectH1: "Plans", name: "Mixtapes", path: "/admin/plans" },
  { expectH1: "Clip library", name: "Clips", path: "/admin/clips" },
  { expectH1: "Newsletter", name: "Newsletter", path: "/admin/newsletter" },
];

const failures: string[] = [];

function watchErrors(page: Page, label: string): void {
  page.on("pageerror", (error) => failures.push(`[${label}] pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      failures.push(`[${label}] console.error: ${message.text()}`);
    }
  });
}

// Past-hydration gate: the sidebar collapse toggle only works once React has
// hydrated, so toggling it (and seeing data-state flip) proves interactivity —
// not just painted SSR HTML.
async function waitForHydration(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");

  const sidebar = page.locator('[data-slot="sidebar"][data-state]').first();
  const before = await sidebar.getAttribute("data-state");
  const trigger = page.getByRole("button", { name: "Toggle Sidebar" }).first();

  // A click that lands before hydration does nothing, so RETRY until one
  // sticks — the first observed flip is the proof of interactivity.
  const deadline = Date.now() + 15_000;

  while ((await sidebar.getAttribute("data-state")) === before) {
    if (Date.now() > deadline) {
      throw new Error("hydration gate: the sidebar toggle never became interactive");
    }

    await trigger.click();
    await page.waitForTimeout(250);
  }

  // Toggle back, then let the 200ms width transition finish, so screenshots
  // never catch the rail mid-animation.
  await trigger.click();
  await page.waitForFunction(
    (previous) =>
      document.querySelector('[data-slot="sidebar"][data-state]')?.getAttribute("data-state") ===
      previous,
    before,
    { timeout: 5000 },
  );
  await page.waitForTimeout(300);
}

// Wait for a navigation to land on a path (TanStack materializes default
// search params into the URL, so an exact-URL wait never matches).
async function waitForPath(page: Page, path: string): Promise<void> {
  await page.waitForURL((url) => url.pathname === path, { waitUntil: "networkidle" });
}

// A sidebar link's accessible name is its label plus an optional live count
// ("Findings (17)"), so match on the label with the count optional.
function navLink(page: Page, name: string) {
  return page.getByRole("link", { name: new RegExp(`^${name}( \\(\\d+\\))?$`) }).first();
}

async function expectTitle(page: Page, h1: string, label: string): Promise<void> {
  const heading = page.locator("h1").first();
  const text = (await heading.textContent())?.trim() ?? "";

  if (!text.startsWith(h1)) {
    failures.push(`[${label}] expected h1 "${h1}", saw "${text}"`);
  }
}

mkdirSync(OUT_DIR, { recursive: true });

const browser = await launchBrowser();

// Desktop: land on the board, prove hydration, then CLICK through every
// sidebar entry (clicking verifies the real hrefs, not just the routes).
{
  const { context, page } = await newAdminPage(browser, BASE_URL, { height: 900, width: 1440 });
  watchErrors(page, "desktop");

  await page.goto(`${BASE_URL}/admin`, { waitUntil: "networkidle" });
  await waitForHydration(page);
  await expectTitle(page, "Dashboard", "desktop /admin");
  await page.screenshot({ path: join(OUT_DIR, "dashboard-desktop.png") });

  for (const entry of ENTRIES) {
    await page.goto(`${BASE_URL}/admin`, { waitUntil: "networkidle" });
    await navLink(page, entry.name).click();
    await waitForPath(page, entry.path);
    await expectTitle(page, entry.expectH1, `desktop ${entry.name}`);
    await page.screenshot({
      path: join(OUT_DIR, `${entry.name.toLowerCase()}-desktop.png`),
    });
  }

  // System leaves the shell for the public status page.
  await page.goto(`${BASE_URL}/admin`, { waitUntil: "networkidle" });
  await navLink(page, "System").click();
  await waitForPath(page, "/status");
  await page.screenshot({ path: join(OUT_DIR, "system-desktop.png") });

  // The board's deep-linked filters keep working (migration discipline).
  await page.goto(`${BASE_URL}/admin?stage=needs-tagging&mix=open`, { waitUntil: "networkidle" });
  await expectTitle(page, "Dashboard", "desktop deep-link");
  await page.screenshot({ path: join(OUT_DIR, "deep-link-desktop.png") });

  await context.close();
}

// Phone width: the sidebar becomes a sheet behind the header trigger.
{
  const { context, page } = await newAdminPage(browser, BASE_URL, { height: 844, width: 390 });
  watchErrors(page, "mobile");

  await page.goto(`${BASE_URL}/admin`, { waitUntil: "networkidle" });
  await page.waitForLoadState("networkidle");
  await expectTitle(page, "Dashboard", "mobile /admin");
  await page.screenshot({ path: join(OUT_DIR, "dashboard-mobile.png") });

  // Open the sheet, walk to Plans through it. Wait out the sheet's enter
  // transition (opacity + slide) so the shot shows the settled surface.
  await page.getByRole("button", { name: "Toggle Sidebar" }).first().click();
  await navLink(page, "Plans").waitFor();
  await page.waitForFunction(
    () => {
      const sheet = document.querySelector('[data-mobile="true"]');
      return sheet !== null && getComputedStyle(sheet).opacity === "1";
    },
    undefined,
    { timeout: 5000 },
  );
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(OUT_DIR, "sheet-mobile.png") });
  await navLink(page, "Plans").click();
  await waitForPath(page, "/admin/plans");
  await expectTitle(page, "Plans", "mobile Plans");
  await page.screenshot({ path: join(OUT_DIR, "plans-mobile.png") });

  await context.close();
}

await browser.close();

if (failures.length > 0) {
  console.error(`\nFAIL — ${failures.length} problem(s):`);
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
}

console.log(`PASS — screenshots in ${OUT_DIR}`);
