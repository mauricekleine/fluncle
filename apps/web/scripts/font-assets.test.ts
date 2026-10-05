import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("web font caching", () => {
  it("routes every font face through Vite as an external source asset", () => {
    const stylesheet = new URL("../src/styles.css", import.meta.url);
    const css = readFileSync(stylesheet, "utf8");
    const faces = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)];

    expect(faces).toHaveLength(6);
    for (const [, face] of faces) {
      const urls = [...(face ?? "").matchAll(/url\(["']?([^"')]+)["']?\)/g)];
      expect(urls).toHaveLength(1);
      for (const [, path] of urls) {
        expect(path).toMatch(/^\.\/fonts\/.+\.woff2$/);
        const font = new URL(path ?? "", stylesheet);
        expect(font.pathname).not.toContain("/public/");
        expect(statSync(font).size).toBeGreaterThan(4096);
      }
    }
  });

  it("reserves the immutable font cache for fingerprinted assets", () => {
    const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");

    expect(headers).not.toMatch(/^\/fonts\/\*\s*$/m);
    expect(headers).toMatch(
      /^\/assets\/\*\n\s+Cache-Control: public, max-age=31536000, immutable$/m,
    );
  });
});
