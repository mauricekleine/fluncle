import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { blockExternalRequests } from "./browser";
import { SEEDED_SAVE_TARGET_LOG_ID, SEEDED_SAVE_TARGET_TITLE } from "./seed";

const PASSWORD = "e2e-password-1234";

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

test("a new account joins, saves a finding, sees it on /account, and loses it on sign out", async ({
  page,
}) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  const stamp = Date.now();
  const email = `e2e_crew_${stamp}@example.invalid`;
  const username = `e2e_${stamp}`;

  const rawHtml = await (await page.request.get("/account")).text();
  expect(rawHtml, "the signed-out account page should SSR its masthead").toContain(
    "Your place in the Galaxy",
  );

  const response = await page.goto("/account", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/your place in the galaxy/i);

  const emailField = page.getByLabel("Email", { exact: true });

  await expect(async () => {
    await page.getByRole("tab", { name: "Sign in" }).click();
    await expect(emailField).toBeHidden({ timeout: 2000 });
  }).toPass({ timeout: 60_000 });

  await page.getByRole("tab", { name: "Create account" }).click();
  await expect(emailField).toBeVisible();

  await emailField.fill(email);
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Create private account" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/the galaxy/i, {
    timeout: 30_000,
  });
  const crewTrigger = page.getByRole("button", { name: "Your account" });
  await expect(crewTrigger).toContainText(username);

  await page.goto(`/log/${SEEDED_SAVE_TARGET_LOG_ID}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(SEEDED_SAVE_TARGET_LOG_ID);

  const savedButton = page.getByRole("button", { exact: true, name: "Saved" });

  await expect(async () => {
    if (await savedButton.isVisible()) {
      return;
    }

    await page.getByRole("button", { exact: true, name: "Save finding" }).click();
    await expect(savedButton).toBeVisible({ timeout: 5000 });
  }).toPass({ timeout: 60_000 });

  await page.goto("/account?tab=saves", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/saves/i);
  await expect(page.getByText(SEEDED_SAVE_TARGET_TITLE, { exact: false }).first()).toBeVisible();

  const signOutItem = page.getByRole("menuitem", { name: "Sign out" });

  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(signOutItem).toBeHidden({ timeout: 2000 });
    await crewTrigger.click();
    await expect(signOutItem).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 60_000 });

  await signOutItem.click();
  await expect(page.getByRole("button", { name: "Join the crew" })).toBeVisible({
    timeout: 30_000,
  });

  await page.goto("/account?tab=saves", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/your place in the galaxy/i);
  await expect(page.getByRole("tab", { name: "Create account" })).toBeVisible();
  await expect(page.getByText(SEEDED_SAVE_TARGET_TITLE, { exact: false })).toHaveCount(0);

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});
