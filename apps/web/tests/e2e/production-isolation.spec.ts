import { expect, test } from "@playwright/test";
import { SEEDED_LEAD_COVER_URL } from "./seed";

function isProductionHost(url: string): boolean {
  const { hostname } = new URL(url);

  return hostname === "fluncle.com" || hostname.endsWith(".fluncle.com");
}

test("a run never reaches a production host, even for the seeded fixture media", async ({
  page,
}) => {
  const answered: string[] = [];
  const unresolved: string[] = [];

  page.on("response", (response) => {
    if (isProductionHost(response.url())) {
      answered.push(response.url());
    }
  });
  page.on("requestfailed", (request) => {
    if (isProductionHost(request.url())) {
      unresolved.push(request.failure()?.errorText ?? "");
    }
  });

  await page.goto("/", { waitUntil: "networkidle" });

  const outcome = await page.evaluate(async (url) => {
    try {
      await fetch(url, { mode: "no-cors" });
      return "reached";
    } catch {
      return "blocked";
    }
  }, SEEDED_LEAD_COVER_URL);

  expect(outcome).toBe("blocked");
  expect(answered).toEqual([]);
  expect(unresolved.every((errorText) => errorText.includes("ERR_NAME_NOT_RESOLVED"))).toBe(true);
});
