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
// The warm-up walks SEVERAL routes rather than only the root, because a dep is
// pre-bundled when the module that imports it is first requested, and the routes
// pull disjoint graphs: the front door is a light page, while the archive feed, the
// graph pages, and the account door each drag in components nothing else uses. A
// warm-up that loads one route leaves every other route's first spec to discover
// its deps mid-run — which is precisely the 504 this exists to absorb.
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

/**
 * One route per distinct client module graph the suite drives. Not every spec's URL — a
 * representative that pulls the same components is enough, since pre-bundling is per DEPENDENCY.
 * `/account` is included for the auth form's graph; it renders its signed-out door anonymously.
 */
const WARM_UP_PATHS = ["/", "/findings", "/log", "/tracks", "/artists", "/account"];
// The FIRST load compiles the whole client module graph on demand, which on a CI
// runner takes well over Playwright's 30s default navigation timeout. A page made
// with `browser.newPage()` does not inherit the config's timeouts, so it is set
// explicitly here — and a timeout is treated as "not settled yet", not as fatal.
const WARM_UP_TIMEOUT_MS = 150_000;

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

      for (const path of WARM_UP_PATHS) {
        try {
          await page.goto(new URL(path, BASE_URL).href, {
            timeout: WARM_UP_TIMEOUT_MS,
            waitUntil: "networkidle",
          });
          // Let any post-load re-optimization surface before judging the attempt.
          await page.waitForTimeout(500);
        } catch (error) {
          sawError = true;
          console.log(
            `e2e: warm-up load of ${path} did not settle (${(error as Error).message.split("\n")[0]})`,
          );
        }
      }

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
