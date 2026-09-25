import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { blockExternalRequests } from "./browser";
import { capturedEmails } from "./fake-resend";
import { SEEDED_GRAPH_ENTITIES } from "./seed";

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

async function latestLink(email: string): Promise<{ link: string; text: string }> {
  let captured = { link: "", text: "" };

  await expect(async () => {
    const [latest] = (await capturedEmails(email)).slice(-1);
    const link = latest?.text.match(/https?:\/\/\S+magic-link\/verify\S+/)?.[0];

    expect(link, `no sign-in link captured for ${email}`).toBeTruthy();
    captured = { link: link ?? "", text: latest?.text ?? "" };
  }).toPass({ timeout: 15_000 });

  return captured;
}

test("Dave follows a label with one email and lands signed in, following it", async ({ page }) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);
  const { artist, label } = SEEDED_GRAPH_ENTITIES;
  const email = `e2e_dave_${Date.now()}@example.invalid`;

  await page.goto(`/label/${label.slug}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(label.name);

  const follow = page.getByRole("button", { exact: true, name: `Follow ${label.name}` });
  const popover = page.getByRole("dialog", { name: `Follow ${label.name}` });

  await expect(async () => {
    if (await popover.isVisible()) {
      return;
    }

    await follow.click();
    await expect(popover).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 60_000 });

  await expect(popover).toContainText("every Friday");
  await popover.getByLabel("Email", { exact: true }).fill(email);
  await popover.getByRole("button", { name: "Email me a link" }).click();
  await expect(popover.getByTestId("magic-link-sent")).toContainText(email);

  const { link, text } = await latestLink(email);

  expect(text).toContain(`following ${label.name}`);

  const callback = new URL(new URL(link).searchParams.get("callbackURL") ?? "", link);

  expect(callback.pathname).toBe(`/label/${label.slug}`);
  expect(callback.searchParams.get("follow")).toBeTruthy();

  await page.goto(link, { waitUntil: "networkidle" });

  const following = page.getByRole("button", {
    exact: true,
    name: `Follow ${label.name}`,
    pressed: true,
  });

  await expect(following).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByText(`Following ${label.name}. I'll email you their new releases`),
  ).toBeVisible();
  expect(new URL(page.url()).search).toBe("");

  await page.reload({ waitUntil: "networkidle" });
  await expect(following).toBeVisible({ timeout: 30_000 });

  await page.goto(`/artist/${artist.slug}`, { waitUntil: "networkidle" });

  const followArtist = page.getByRole("button", {
    exact: true,
    name: `Follow ${artist.name}`,
    pressed: false,
  });
  const followingArtist = page.getByRole("button", {
    exact: true,
    name: `Follow ${artist.name}`,
    pressed: true,
  });

  await expect(async () => {
    if (await followingArtist.isVisible()) {
      return;
    }

    await followArtist.click();
    await expect(followingArtist).toBeVisible({ timeout: 5000 });
  }).toPass({ timeout: 60_000 });

  await page.goto("/account?tab=saves", { waitUntil: "networkidle" });

  const claim = page.getByRole("dialog", { name: "Claim your username" });

  if (await claim.isVisible()) {
    await claim.getByRole("button", { name: "Not now" }).click();
  }

  await expect(page.getByRole("heading", { level: 2, name: "Following" })).toBeVisible();
  await expect(page.getByRole("link", { exact: true, name: label.name })).toBeVisible();
  await expect(page.getByRole("link", { exact: true, name: artist.name })).toBeVisible();

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});

test("a follow link that reaches the wrong inbox cannot follow anything", async ({ page }) => {
  await blockExternalRequests(page);

  const { label } = SEEDED_GRAPH_ENTITIES;

  const response = await page.request.post("/api/v1/me/follows", {
    data: { intent: "forged.intent" },
    headers: { "Content-Type": "application/json" },
  });

  expect(response.status()).toBe(401);

  await page.goto(`/label/${label.slug}?follow=forged.intent`, { waitUntil: "networkidle" });
  await expect(page.getByRole("button", { exact: true, name: `Follow ${label.name}` })).toBeVisible(
    { timeout: 30_000 },
  );
});
