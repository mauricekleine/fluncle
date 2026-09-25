import { chromium } from "@playwright/test";
import { BASE_URL } from "./stack";

const MAX_ATTEMPTS = 5;

const WARM_UP_PATHS = ["/", "/findings", "/log", "/tracks", "/artists", "/account"];

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

    console.warn("e2e: dev server did not settle during warm-up; running the suite anyway.");
  } finally {
    await browser.close();
  }
}
