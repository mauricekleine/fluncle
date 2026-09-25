import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { blockExternalRequests } from "./browser";

const EXPECTED_REJECTION_LOG =
  "console.error: Failed to load resource: the server responded with a status of 400 (Bad Request)";

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

async function openDialog(page: Page, trigger: string, heading: string): Promise<void> {
  const dialog = page.getByRole("dialog").filter({ hasText: heading });

  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: 2000 });
    await page.getByRole("button", { name: trigger }).first().click();
    await expect(dialog).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 60_000 });
}

test("the newsletter form reaches the subscribe contract and shows its verdict", async ({
  page,
}) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  await page.goto("/findings", { waitUntil: "networkidle" });
  await openDialog(page, "Newsletter", "The weekly newsletter");

  const emailField = page.getByLabel("Email", { exact: true });

  await emailField.fill("a@b.c");
  await page.getByRole("button", { name: "Get on the list" }).click();
  await expect(page.getByText("Enter a valid email address.")).toBeVisible({ timeout: 15_000 });

  await page.locator("#newsletter-website").fill("definitely-a-bot");
  await emailField.fill(`e2e_${Date.now()}@example.invalid`);
  await page.getByRole("button", { name: "Get on the list" }).click();
  await expect(page.getByText("Invalid request")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Welcome to the mothership")).toHaveCount(0);

  expect(
    problems.filter((problem) => problem !== EXPECTED_REJECTION_LOG),
    `expected a clean console apart from the provoked 400s, saw:\n${problems.join("\n")}`,
  ).toEqual([]);
});

test("the submission dialog hydrates and refuses to search on nothing", async ({ page }) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  await page.goto("/findings", { waitUntil: "networkidle" });
  await openDialog(page, "Submit a track", "Search Spotify, pick the match");

  await expect(page.getByRole("button", { name: "Send for review" })).toHaveCount(0);
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("Enter a Spotify URL or track search.")).toBeVisible({
    timeout: 15_000,
  });

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});
