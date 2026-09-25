import { expect, test, type ConsoleMessage, type Locator, type Page } from "@playwright/test";
import { blockExternalRequests } from "./browser";
import { routePreviews } from "./player";
import { SEEDED_DESTINATION_NEIGHBOUR, SEEDED_LEAD } from "./seed";
import { BASE_URL } from "./stack";

const PASSWORD = "e2e-password-1234";

const CATALOGUE_PATH = `/track/${SEEDED_DESTINATION_NEIGHBOUR.trackId}`;
const FINDING_PATH = `/log/${SEEDED_LEAD.logId}`;

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

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

async function openMenu(page: Page, trigger: Locator, expectItem: string): Promise<void> {
  const item = page.getByRole("menuitem", { exact: true, name: expectItem });

  await expect(async () => {
    await page.keyboard.press("Escape");
    await trigger.click();
    await expect(item).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });
}

function toast(page: Page, text: string): Locator {
  return page.locator("[data-sonner-toast]", { hasText: text });
}

test("the log and track pages unfurl with a title, a cover, and a card", async ({ page }) => {
  for (const path of [FINDING_PATH, CATALOGUE_PATH]) {
    const html = await (await page.request.get(path)).text();

    expect(html, `${path} og:title`).toContain('property="og:title"');
    expect(html, `${path} og:image`).toContain('property="og:image"');
    expect(html, `${path} twitter:card`).toContain('name="twitter:card"');
  }
});

test("saves a catalogue track and a finding signed out, shares the canonical link, and carries the saves into an account", async ({
  page,
  playwright,
}) => {
  await blockExternalRequests(page);
  await routePreviews(page, { seconds: 30 });

  const problems = watchForErrors(page);

  await hydrate(page, "/tracks");

  const row = page
    .locator(".discovery-row", { hasText: SEEDED_DESTINATION_NEIGHBOUR.title })
    .first();
  const rowMenu = row.locator(".track-menu-trigger");

  await openMenu(page, rowMenu, "Save");
  await page.getByRole("menuitem", { exact: true, name: "Save" }).click();
  await expect(toast(page, "Saved on this device.")).toBeVisible();

  await openMenu(page, rowMenu, "Remove from saves");

  await page.getByRole("menuitem", { exact: true, name: "Share" }).click();
  await expect(toast(page, "Link copied. Send it to the crew.")).toBeVisible();

  const copied = await page.evaluate(() => navigator.clipboard.readText());

  expect(copied).toBe(`https://www.fluncle.com${CATALOGUE_PATH}`);
  expect(new URL(copied).search).toBe("");

  await hydrate(page, FINDING_PATH);
  await page.getByRole("button", { name: "Play the preview" }).click();

  const player = page.getByRole("region", { name: "Player" });

  await expect(player).toContainText(SEEDED_LEAD.title);
  await openMenu(page, player.locator(".track-menu-trigger"), "Save");
  await page.getByRole("menuitem", { exact: true, name: "Save" }).click();
  await expect(toast(page, "Saved on this device.")).toBeVisible();

  await expect(page.getByRole("button", { exact: true, name: "Saved" })).toBeVisible();

  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("html[data-discovery-listening]")).toBeAttached({ timeout: 30_000 });
  await expect(page.getByRole("button", { exact: true, name: "Saved" })).toBeVisible();

  await hydrate(page, "/account");

  const deviceSaves = page.getByRole("region", { name: "Saved on this device" });

  await expect(deviceSaves).toBeVisible();
  await expect(
    deviceSaves.getByRole("link", { name: new RegExp(SEEDED_DESTINATION_NEIGHBOUR.title) }),
  ).toHaveAttribute("href", CATALOGUE_PATH);
  await expect(
    deviceSaves.getByRole("link", { name: new RegExp(SEEDED_LEAD.title) }),
  ).toHaveAttribute("href", FINDING_PATH);

  const stamp = Date.now();
  const email = `e2e_saver_${stamp}@example.invalid`;
  const api = await playwright.request.newContext({ baseURL: BASE_URL });
  const signUp = await api.post("/api/auth/sign-up/email", {
    data: { email, name: `e2e_s_${stamp}`, password: PASSWORD, username: `e2e_s_${stamp}` },
    headers: { Origin: BASE_URL },
  });

  expect(signUp.ok(), await signUp.text()).toBe(true);
  await api.dispose();

  const signInTab = page.getByRole("tab", { name: "Sign in" });
  const identifier = page.getByLabel("Email or username", { exact: true });

  await expect(async () => {
    await signInTab.click();
    await expect(identifier).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 60_000 });

  await identifier.fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { exact: true, name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/the galaxy/i, {
    timeout: 30_000,
  });

  await hydrate(page, "/account?tab=saves");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/saves/i);

  const savedTracks = page.locator(".saves-list");

  await expect(savedTracks).toContainText(SEEDED_DESTINATION_NEIGHBOUR.title, { timeout: 20_000 });
  await expect(savedTracks).toContainText(SEEDED_LEAD.title);
  await expect(
    savedTracks.getByRole("link", { name: new RegExp(SEEDED_DESTINATION_NEIGHBOUR.title) }),
  ).toHaveAttribute("href", CATALOGUE_PATH);

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});
