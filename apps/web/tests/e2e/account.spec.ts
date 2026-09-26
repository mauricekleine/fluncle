import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { blockExternalRequests } from "./browser";
import { capturedEmails } from "./fake-resend";
import { BASE_URL } from "./stack";
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

async function magicLinkFor(email: string): Promise<string> {
  let link: string | undefined;

  await expect(async () => {
    const [latest] = (await capturedEmails(email)).slice(-1);

    link = latest?.text.match(/https?:\/\/\S+magic-link\/verify\S+/)?.[0];
    expect(link, `no sign-in link captured for ${email}`).toBeTruthy();
  }).toPass({ timeout: 15_000 });

  return link ?? "";
}

async function requestMagicLink(page: Page, email: string): Promise<void> {
  const emailField = page.getByLabel("Email", { exact: true });
  const sent = page.getByTestId("magic-link-sent");

  await expect(async () => {
    if (await sent.isVisible()) {
      return;
    }

    await emailField.fill(email);
    await page.getByRole("button", { name: "Email me a link" }).click();
    await expect(sent).toBeVisible({ timeout: 5000 });
  }).toPass({ timeout: 60_000 });

  await expect(sent).toContainText(email);
}

test("the crew slot opens the sign-in door from a fresh public page", async ({ page }) => {
  await blockExternalRequests(page);

  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Join the crew" }).click();

  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("button", { name: "Email me a link" })).toBeVisible();
});

test("a new account joins by magic link, saves a finding, sees it on /account, and loses it on sign out", async ({
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

  await requestMagicLink(page, email);

  const link = await magicLinkFor(email);

  expect(new URL(link).searchParams.get("callbackURL")).toBe("/account?tab=saves");

  await page.goto(link, { waitUntil: "networkidle" });

  expect(new URL(page.url()).pathname).toBe("/account");
  expect(new URL(page.url()).searchParams.get("tab")).toBe("saves");

  const claim = page.getByRole("dialog", { name: "Claim your username" });

  await expect(claim).toBeVisible({ timeout: 30_000 });
  await claim.getByLabel("Username", { exact: true }).fill(username);
  await claim.getByRole("button", { name: "Claim username" }).click();
  await expect(claim).toBeHidden({ timeout: 30_000 });

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/saves/i, {
    timeout: 30_000,
  });

  const crewTrigger = page.getByRole("button", { name: "Your account" });
  await expect(crewTrigger).toContainText(username, { timeout: 30_000 });

  const reused = await page.request.get(link, { maxRedirects: 0 });

  expect(reused.headers()["location"] ?? "").toContain("error=INVALID_TOKEN");

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
  await expect(page.getByRole("button", { name: "Email me a link" })).toBeVisible();
  await expect(page.getByText(SEEDED_SAVE_TARGET_TITLE, { exact: false })).toHaveCount(0);

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});

test("an existing password account still signs in with its password", async ({ page }) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);
  const stamp = Date.now();
  const email = `e2e_pw_${stamp}@example.invalid`;
  const username = `e2e_pw_${stamp}`.slice(0, 24);
  const created = await page.request.post("/api/auth/sign-up/email", {
    data: { email, name: username, password: PASSWORD, username },
    headers: { Origin: BASE_URL },
  });

  expect(created.ok()).toBe(true);

  await page.context().clearCookies();
  await page.goto("/account", { waitUntil: "networkidle" });

  const passwordField = page.getByLabel("Password", { exact: true });

  await expect(async () => {
    if (await passwordField.isVisible()) {
      return;
    }

    await page.getByRole("button", { name: "Sign in with a password" }).click();
    await expect(passwordField).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 60_000 });

  await page.getByLabel("Email or username", { exact: true }).fill(username);
  await passwordField.fill(PASSWORD);
  await page.getByRole("button", { exact: true, name: "Sign in" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/the galaxy/i, {
    timeout: 30_000,
  });
  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});
