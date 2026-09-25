import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Page } from "playwright-core";
import { launchBrowser, newAdminPage } from "./admin";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const OUT_DIR = process.env.OUT_DIR ?? "/tmp/admin-shell-smoke";

const ENTRIES: { expectH1: string; name: string; path: string }[] = [
  { expectH1: "Dashboard", name: "Dashboard", path: "/admin" },
  { expectH1: "Findings", name: "Findings", path: "/admin/findings" },
  { expectH1: "Renders", name: "Renders", path: "/admin/renders" },
  { expectH1: "Artists", name: "Artists", path: "/admin/artists" },
  { expectH1: "Labels", name: "Labels", path: "/admin/labels" },
  { expectH1: "Galaxies", name: "Galaxies", path: "/admin/galaxies" },
  { expectH1: "Playlists", name: "Playlists", path: "/admin/plans" },
  { expectH1: "Mixtapes", name: "Mixtapes", path: "/admin/mixtapes" },
  { expectH1: "Dream-weaver", name: "Dream-weaver", path: "/admin/mixable-order" },
  { expectH1: "Recordings", name: "Recordings", path: "/admin/recordings" },
  { expectH1: "Clip library", name: "Clips", path: "/admin/clips" },
  { expectH1: "Newsletter", name: "Newsletter", path: "/admin/newsletter" },
  { expectH1: "Costs", name: "Costs", path: "/admin/costs" },
  { expectH1: "Usage & cost", name: "Usage & cost", path: "/admin/usage" },
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

async function waitForHydration(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");

  const sidebar = page.locator('[data-slot="sidebar"][data-state]').first();
  const before = await sidebar.getAttribute("data-state");
  const trigger = page.getByRole("button", { name: "Toggle Sidebar" }).first();

  const deadline = Date.now() + 15_000;

  while ((await sidebar.getAttribute("data-state")) === before) {
    if (Date.now() > deadline) {
      throw new Error("hydration gate: the sidebar toggle never became interactive");
    }

    await trigger.click();
    await page.waitForTimeout(250);
  }

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

async function waitForPath(page: Page, path: string): Promise<void> {
  await page.waitForURL((url) => url.pathname === path, { waitUntil: "networkidle" });
}

function navLink(page: Page, name: string) {
  return page.getByRole("link", { name: new RegExp(`^${name}( \\(\\d+\\))?$`) }).first();
}

async function expectTitle(page: Page, h1: string, label: string): Promise<void> {
  await page
    .locator("h1", { hasText: h1 })
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => undefined);

  const text = (await page.locator("h1").first().textContent())?.trim() ?? "";

  if (!text.startsWith(h1)) {
    failures.push(`[${label}] expected h1 "${h1}", saw "${text}"`);
  }
}

mkdirSync(OUT_DIR, { recursive: true });

const browser = await launchBrowser();

{
  const { context, page } = await newAdminPage(browser, BASE_URL, { height: 900, width: 1440 });
  watchErrors(page, "desktop");

  await page.goto(`${BASE_URL}/admin`, { waitUntil: "networkidle" });
  await waitForHydration(page);
  await expectTitle(page, "Dashboard", "desktop /admin");
  await page.screenshot({ path: join(OUT_DIR, "dashboard-desktop.png") });

  for (const entry of ENTRIES) {
    await page.goto(`${BASE_URL}/admin`, { waitUntil: "networkidle" });

    await expectTitle(page, "Dashboard", `desktop ${entry.name} (home)`);
    await navLink(page, entry.name).click();
    await waitForPath(page, entry.path);
    await expectTitle(page, entry.expectH1, `desktop ${entry.name}`);
    await page.screenshot({
      path: join(OUT_DIR, `${entry.name.toLowerCase()}-desktop.png`),
    });
  }

  await page.goto(`${BASE_URL}/admin`, { waitUntil: "networkidle" });
  await navLink(page, "System").click();
  await waitForPath(page, "/status");
  await page.screenshot({ path: join(OUT_DIR, "system-desktop.png") });

  await page.goto(`${BASE_URL}/admin?stage=needs-tagging&mix=open`, { waitUntil: "networkidle" });
  await waitForPath(page, "/admin/findings");
  await expectTitle(page, "Findings", "desktop deep-link");
  await page.screenshot({ path: join(OUT_DIR, "deep-link-desktop.png") });

  await context.close();
}

{
  const { context, page } = await newAdminPage(browser, BASE_URL, { height: 844, width: 390 });
  watchErrors(page, "mobile");

  await page.goto(`${BASE_URL}/admin`, { waitUntil: "networkidle" });
  await page.waitForLoadState("networkidle");
  await expectTitle(page, "Dashboard", "mobile /admin");
  await page.screenshot({ path: join(OUT_DIR, "dashboard-mobile.png") });

  await page.getByRole("button", { name: "Toggle Sidebar" }).first().click();
  await navLink(page, "Playlists").waitFor();
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
  await navLink(page, "Playlists").click();
  await waitForPath(page, "/admin/plans");
  await expectTitle(page, "Playlists", "mobile Playlists");
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
