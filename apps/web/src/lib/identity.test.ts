// The entity description is "reused verbatim; edit it here or nowhere" (see
// ./identity.ts, and VOICE.md §7's Meta description row). Every TypeScript surface
// honours that by importing the constant — home/about/reach heads, the MCP server
// card, agent-discovery's markdown, the JSON-LD.
//
// Two surfaces cannot import it, because they are static assets served straight off
// disk: `public/llms.txt` (the plain-language map every LLM and crawler reads) and
// `public/manifest.webmanifest` (the installed PWA's description). Both hold a
// HAND-COPIED duplicate of the same sentence, and nothing checked that the copies
// still matched — so an edit to `fluncleDescription` would silently leave the two
// most machine-read surfaces quoting the previous entity description.
//
// This is that check. It asserts equality, not containment: a paraphrase is exactly
// the failure the verbatim rule exists to prevent, and containment would pass one.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fluncleDescription } from "./identity";

const APP_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function readPublicAsset(name: string): string {
  return readFileSync(join(APP_ROOT, "public", name), "utf8");
}

describe("the canonical entity description", () => {
  it("is quoted verbatim by public/llms.txt", () => {
    // The blockquote directly under the `# Fluncle` heading — llms.txt's summary
    // line, which is where the spec puts the one-sentence description of the site.
    const blockquote = readPublicAsset("llms.txt")
      .split("\n")
      .find((line) => line.startsWith("> "));

    expect(blockquote).toBe(`> ${fluncleDescription}`);
  });

  it("is quoted verbatim by public/manifest.webmanifest", () => {
    const manifest: unknown = JSON.parse(readPublicAsset("manifest.webmanifest"));
    const description =
      typeof manifest === "object" && manifest !== null
        ? (manifest as Record<string, unknown>).description
        : undefined;

    expect(description).toBe(fluncleDescription);
  });
});
