// Playwright global setup — warm the Vite dev server before any spec measures it.
//
// This suite runs against a DEV server, which pre-bundles dependencies on demand.
// On a cold dep cache (every CI run) Vite can discover a new dependency while it
// is already serving the page, re-optimize, and answer the in-flight module
// requests with `504 (Outdated Optimize Dep)` — at which point the client entry
// fails to import and the page never hydrates. It self-heals on the next load.
//
// That is a property of the dev server's cold start, not of the app, but it would
// (correctly) trip a spec's fail-on-any-console-error gate. So we absorb it here,
// once, with throwaway loads: every spec then measures a steady-state server, and
// the strict gate stays strict — no per-spec warm-up to remember, no error filters.
//
// The race is timing-dependent and does not reproduce on a fast machine even with
// the cache deleted, so this loops until a load completes cleanly rather than
// assuming a fixed number of passes is enough.
//
// Runs AFTER the `webServer` command has booted the stack (Playwright's order) and
// under Node, so it uses the Playwright browser API only — no Bun globals.

import { chromium } from "@playwright/test";
import { BASE_URL } from "./stack";

const MAX_ATTEMPTS = 5;

export default async function globalSetup(): Promise<void> {
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage();

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let sawError = false;
      const onError = (): void => {
        sawError = true;
      };

      page.on("pageerror", onError);
      await page.goto(BASE_URL, { waitUntil: "networkidle" });
      // Let any post-load re-optimization surface before judging the attempt.
      await page.waitForTimeout(500);
      page.off("pageerror", onError);

      if (!sawError) {
        return;
      }

      console.log(`e2e: dev server still settling (warm-up attempt ${attempt})…`);
    }

    // Not fatal: let the specs run and report the real error with full context.
    console.warn("e2e: dev server did not settle during warm-up; running the suite anyway.");
  } finally {
    await browser.close();
  }
}
