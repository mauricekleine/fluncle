import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const routesDir = dirname(fileURLToPath(import.meta.url));

const HOME_ROUTE = "index.tsx";

const PRIVATE_ROUTES = new Set([
  "account.tsx",
  "chat.tsx",
  "device.tsx",
  "follows.tsx",
  "recommendations.tsx",
  "reset-password.tsx",
]);

function publicRoutesWithCanonical(): string[] {
  return readdirSync(routesDir)
    .filter((file) => file.endsWith(".tsx") && !file.startsWith("-") && !file.startsWith("admin"))
    .filter((file) => file !== HOME_ROUTE && !PRIVATE_ROUTES.has(file))
    .filter((file) => readFileSync(join(routesDir, file), "utf8").includes('rel: "canonical"'));
}

function declaresOwnShareUrl(source: string): boolean {
  return source.includes('property: "og:url"') || source.includes("docsHead(");
}

describe("public route share tags", () => {
  it("finds the public routes that declare a canonical", () => {
    expect(publicRoutesWithCanonical()).toEqual(
      expect.arrayContaining(["docs.api.tsx", "pipeline.tsx", "artist.$slug.tsx"]),
    );
  });

  it("every public route with its own canonical declares its own og:url, so a share never unfurls as the homepage the root head describes", () => {
    const inheriting = publicRoutesWithCanonical().filter(
      (file) => !declaresOwnShareUrl(readFileSync(join(routesDir, file), "utf8")),
    );

    expect(inheriting).toEqual([]);
  });

  it("every public route that sets its own og:url also sets its own og:title", () => {
    const untitled = publicRoutesWithCanonical().filter((file) => {
      const source = readFileSync(join(routesDir, file), "utf8");

      return source.includes('property: "og:url"') && !source.includes('property: "og:title"');
    });

    expect(untitled).toEqual([]);
  });
});
