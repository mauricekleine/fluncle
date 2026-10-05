import { describe, expect, it, vi } from "vitest";
import llmsTxt from "../../../public/llms.txt?raw";

vi.mock("./tracks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tracks")>()),
  listTracks: vi.fn(async () => ({ tracks: [] })),
}));
vi.mock("./galaxies-map", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./galaxies-map")>()),
  isGalaxyMapFullyNamed: vi.fn(async () => false),
}));

const { handleAgentDiscovery } = await import("./agent-discovery");

function listenPages(): string[] {
  const listen = llmsTxt.split("## Listen")[1]?.split("\n## ")[0] ?? "";

  return [...listen.matchAll(/\]\((https:\/\/www\.fluncle\.com\/[^)]*)\)/g)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  );
}

describe("the markdown home — Accept: text/markdown on /", () => {
  it("names every web page llms.txt lists under Listen", async () => {
    const res = await handleAgentDiscovery(
      new Request("https://www.fluncle.com/", { headers: { accept: "text/markdown" } }),
    );
    const body = (await res?.text()) ?? "";
    const pages = listenPages();

    expect(pages.length).toBeGreaterThan(5);
    for (const page of pages) {
      expect(body, `markdown home is missing ${page}`).toContain(`(${page})`);
    }
  });
});
