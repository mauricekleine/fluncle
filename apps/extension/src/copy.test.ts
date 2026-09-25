import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { COPY } from "./copy";

function readAsset(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
}

function elementText(html: string, pattern: RegExp): string | undefined {
  return pattern.exec(html)?.[1]?.trim();
}

describe("the static assets quote ./copy.ts verbatim", () => {
  const manifest = JSON.parse(readAsset("../manifest.json")) as Record<string, unknown>;
  const popup = readAsset("./popup.html");
  const options = readAsset("./options.html");

  test("manifest.json carries the ratified name and description", () => {
    expect(manifest.name).toBe(COPY.name);
    expect(manifest.description).toBe(COPY.description);
  });

  test("popup.html wears the name in its title and its wordmark", () => {
    expect(elementText(popup, /<title>([^<]*)<\/title>/)).toBe(COPY.name);
    expect(elementText(popup, /<div class="lens-wordmark">([^<]*)<\/div>/)).toBe(COPY.name);
  });

  test("options.html wears the name and the tagline", () => {
    expect(elementText(options, /<title>([^<]*)<\/title>/)).toBe(`${COPY.options.title} settings`);
    expect(elementText(options, /<h1>([^<]*)<\/h1>/)).toBe(COPY.options.title);
    expect(elementText(options, /<p class="lens-tagline">([^<]*)<\/p>/)).toBe(COPY.tagline);
  });

  test("options.html's pre-hydration labels match the ones options.ts writes over them", () => {
    const label = (id: string) =>
      elementText(options, new RegExp(`<div class="lens-field-label" id="${id}">([^<]*)</div>`));

    expect(label("scan-label")).toBe(COPY.options.scanLabel);
    expect(label("cards-label")).toBe(COPY.options.showCardsLabel);
    expect(label("target-label")).toBe(COPY.options.linkTargetLabel);
    expect(elementText(options, /<option value="web">([^<]*)<\/option>/)).toBe(
      COPY.options.linkTargetWeb,
    );
  });
});
