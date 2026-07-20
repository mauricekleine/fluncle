// The ACCOUNT JOURNEY — the front door for every new arrival, walked end to end in
// one coherent flow (see `tests/e2e/README.md` for the shape every spec follows):
//
//   join the crew → land signed in → save a finding from the archive →
//   find it waiting on /account → sign out → the saves are gated again
//
// It is deliberately ONE test, not five: the value is the CHAIN. A save that lands
// only because the session survived the redirect, and a gate that only bites once a
// real session has been dropped, cannot be proven by disconnected fragments.
//
// SELF-CONTAINED. Every run mints a brand-new account (`Date.now()` in the email and
// the handle), so re-running against the same stack — or running twice in a row —
// never collides with the account the last run made. Nothing here depends on state
// another spec created.
//
// OUT OF SCOPE: the OAuth sign-in legs. "Continue with Google" needs a real identity
// provider (and ships DARK without `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, which
// the dummy e2e env deliberately omits), so the email/password door — the one with
// real server-side coverage in `signup-hooks.integration.test.ts` — is what this walks.

import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { blockExternalRequests } from "./browser";
import { SEEDED_SAVE_TARGET_LOG_ID, SEEDED_SAVE_TARGET_TITLE } from "./seed";

// Better Auth's `minPasswordLength` is 10 (src/lib/server/public-auth.ts).
const PASSWORD = "e2e-password-1234";

/** Collect every console error + page error for a fail-on-any assertion at the end. */
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

  // One stamp for the whole journey, so the handle and the address belong to the
  // same fresh identity. The handle must match `/^[a-z0-9_]{3,24}$/` (`isAllowedUsername`).
  const stamp = Date.now();
  const email = `e2e_crew_${stamp}@example.invalid`;
  const username = `e2e_${stamp}`;

  // ── 1. THE SIGNED-OUT DOOR ──────────────────────────────────────────────────
  // SSR first: the signed-out account page is server-rendered (it is `noindex`, but
  // it must still paint without JavaScript, so the form is reachable on a cold load).
  const rawHtml = await (await page.request.get("/account")).text();
  expect(rawHtml, "the signed-out account page should SSR its masthead").toContain(
    "Your place in the Galaxy",
  );

  const response = await page.goto("/account", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/your place in the galaxy/i);

  // ── 2. HYDRATION ────────────────────────────────────────────────────────────
  // The auth form is a client-driven React island: the mode tabs only move once it
  // hydrates, and the whole journey below is worthless if a pre-hydration click
  // silently no-ops. The gate is state-safe (the pattern from `home.spec.ts`): each
  // attempt starts by clicking "Sign in", so every attempt reads "signup → click →
  // expect signin", and the first hydrated attempt passes. Signing in asks for
  // "Email or username", so the exact "Email" field is present ONLY in signup mode.
  const emailField = page.getByLabel("Email", { exact: true });

  await expect(async () => {
    await page.getByRole("tab", { name: "Sign in" }).click();
    await expect(emailField).toBeHidden({ timeout: 2000 });
  }).toPass({ timeout: 60_000 });

  // Back to the door most arrivals came through.
  await page.getByRole("tab", { name: "Create account" }).click();
  await expect(emailField).toBeVisible();

  // ── 3. JOIN THE CREW ────────────────────────────────────────────────────────
  // NOTE (proven, not assumed): sign-up fires a `user.create.after` hook that both
  // stamps the crew number and auto-subscribes the address to the newsletter via
  // Resend, and Better Auth also mails a verification link on sign-up. The dummy e2e
  // env carries NO Resend credentials, so BOTH of those outbound legs fail — and the
  // account is still created and signed in. That is the point of asserting it here:
  // a Resend outage must never be able to block a sign-up.
  await emailField.fill(email);
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Create private account" }).click();

  // Signed in: the masthead swaps from the signed-out title to the Galaxy door, and
  // the top bar's crew slot now carries the handle we just chose (identity, not a count).
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/the galaxy/i, {
    timeout: 30_000,
  });
  const crewTrigger = page.getByRole("button", { name: "Your account" });
  await expect(crewTrigger).toContainText(username);

  // ── 4. SAVE A FINDING ───────────────────────────────────────────────────────
  // The `/me` tier the save rides enforces both a session AND a CSRF token
  // (`requireJsonMutation`), so this is the first step that proves the session the
  // sign-up minted is actually usable for a WRITE.
  await page.goto(`/log/${SEEDED_SAVE_TARGET_LOG_ID}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(SEEDED_SAVE_TARGET_LOG_ID);

  const savedButton = page.getByRole("button", { exact: true, name: "Saved" });

  await expect(async () => {
    // Idempotent by construction: once the button has flipped to "Saved" the attempt
    // clicks nothing, so a retry can never double-post. A pre-hydration click is a
    // no-op (it is a plain `type="button"`), which is exactly what the retry absorbs.
    if (await savedButton.isVisible()) {
      return;
    }

    await page.getByRole("button", { exact: true, name: "Save finding" }).click();
    await expect(savedButton).toBeVisible({ timeout: 5000 });
  }).toPass({ timeout: 60_000 });

  // ── 5. THE WRITE ACTUALLY LANDED ────────────────────────────────────────────
  // Not "a button changed its label" — a full navigation to a different route, whose
  // server-side loader re-reads the saved-findings table for this session.
  await page.goto("/account?tab=saves", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/saves/i);
  await expect(page.getByText(SEEDED_SAVE_TARGET_TITLE, { exact: false }).first()).toBeVisible();

  // ── 6. SIGN OUT, AND THE SAVES ARE GATED AGAIN ──────────────────────────────
  // The crew menu is the exit. State-safe retry again: the trigger TOGGLES, so each
  // attempt resets to closed before clicking.
  const signOutItem = page.getByRole("menuitem", { name: "Sign out" });

  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(signOutItem).toBeHidden({ timeout: 2000 });
    await crewTrigger.click();
    await expect(signOutItem).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 60_000 });

  // Signing out drops the session then reloads the page (crew-slot.tsx).
  await signOutItem.click();
  await expect(page.getByRole("button", { name: "Join the crew" })).toBeVisible({
    timeout: 30_000,
  });

  // A fresh, server-rendered read of the very URL that just showed the save: the
  // signed-out masthead is back, the auth form is back, and the saved finding is
  // NOWHERE on the page — the private read is gated, not merely hidden client-side.
  await page.goto("/account?tab=saves", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/your place in the galaxy/i);
  await expect(page.getByRole("tab", { name: "Create account" })).toBeVisible();
  await expect(page.getByText(SEEDED_SAVE_TARGET_TITLE, { exact: false })).toHaveCount(0);

  // ── 7. CLEANLINESS ──────────────────────────────────────────────────────────
  // No console errors, no page errors, across the whole journey. We own the entire
  // environment, so anything here is a real regression.
  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});
