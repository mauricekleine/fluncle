import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rootPath = join(dirname(fileURLToPath(import.meta.url)), "__root.tsx");
const root = readFileSync(rootPath, "utf8");

function declaredMetaNames(): string[] {
  return [...root.matchAll(/name:\s*"([^"]+)"/g)].map((match) => match[1] ?? "");
}

describe("root head — the inherited X card tags", () => {
  it("declares twitter:card, the one tag with no og fallback", () => {
    expect(declaredMetaNames()).toContain("twitter:card");
  });

  it("declares no twitter:title, twitter:description or twitter:image", () => {
    const declared = declaredMetaNames();

    for (const forbidden of ["twitter:title", "twitter:description", "twitter:image"]) {
      expect(declared).not.toContain(forbidden);
    }
  });

  it("keeps the og tags the omitted X tags fall back to", () => {
    for (const property of ["og:title", "og:description", "og:image"]) {
      expect(root).toContain(`property: "${property}"`);
    }
  });
});
