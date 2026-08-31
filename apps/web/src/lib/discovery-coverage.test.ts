// Regression net for public discovery instrumentation.
//
// Walks apps/web/src and classifies controls by RESOLVED behaviour (the href they go to, the
// preview singleton they start, the neighbour rail they sit in) rather than by the English on
// the button. A new public control of an instrumented class that ships without its event fails
// this file. The sweep result is the list of classes below; keep it honest when adding a class.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB_SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

const SKIP_DIR_NAMES = new Set(["admin", "api", "db", "game", "pipeline", "server", "test"]);

function walk(dir: string, skip: ReadonlySet<string> = SKIP_DIR_NAMES): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name.includes(".test.")) {
      continue;
    }

    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (skip.has(entry.name)) {
        continue;
      }

      out.push(...walk(path, skip));
      continue;
    }

    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(path);
    }
  }

  return out;
}

function rel(path: string): string {
  return path.slice(WEB_SRC.length + 1);
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("public discovery event coverage", () => {
  const files = walk(WEB_SRC);
  const sources = files.map((path) => ({ path, rel: rel(path), source: read(path) }));

  it("mounts one capture-phase listener from the public root", () => {
    const root = sources.find((file) => file.rel === "routes/__root.tsx");

    expect(root, "routes/__root.tsx must exist").toBeDefined();
    expect(root?.source).toContain("DiscoveryListener");
    expect(root?.source).toContain('from "@/components/discovery-listener"');

    const listener = sources.find((file) => file.rel === "components/discovery-listener.tsx");

    expect(listener?.source).toContain('addEventListener("click"');
    expect(listener?.source).toContain("capture: true");
    expect(listener?.source).toContain("passive: true");
    expect(listener?.source).toContain("classifyDiscoveryHref");
    expect(listener?.source).not.toContain("preventDefault");
  });

  it("covers every SEARCH_EXAMPLES consumer: links (classified by href) or an explicit example event", () => {
    const consumers = sources.filter(
      (file) =>
        (file.rel.startsWith("components/") || file.rel.startsWith("routes/")) &&
        file.source.includes("SEARCH_EXAMPLES"),
    );

    expect(consumers.map((file) => file.rel).sort()).toEqual([
      "components/front-door/search-entry.tsx",
      "components/search/search-command.tsx",
      "routes/search.tsx",
    ]);

    for (const file of consumers) {
      const linked = file.source.includes("searchPagePath(");
      const emitted = file.source.includes('"discovery_example"');

      expect(
        linked || emitted,
        `${file.rel} shows SEARCH_EXAMPLES but neither links to searchPagePath nor emits discovery_example`,
      ).toBe(true);
    }
  });

  it("covers the archive search form and the palette type-ahead as discovery_search", () => {
    const searchPage = sources.find((file) => file.rel === "routes/search.tsx");
    const palette = sources.find((file) => file.rel === "components/search/search-command.tsx");

    expect(searchPage?.source).toContain('action="/search"');
    expect(searchPage?.source).toContain('"discovery_search"');
    expect(searchPage?.source).toContain("classifySearchQueryKind");

    expect(palette?.source).toContain('"discovery_search"');
    expect(palette?.source).toContain("classifySearchQueryKind");
    expect(palette?.source).toContain("emitDiscoveryFromHref");
    expect(palette?.source).toContain("window.open");
  });

  it("covers palette window.open (uncertified row → Spotify) with an outbound emit beside it", () => {
    const palette = sources.find((file) => file.rel === "components/search/search-command.tsx");
    const source = palette?.source ?? "";
    const openAt = source.indexOf("window.open");

    expect(openAt).toBeGreaterThan(0);

    const window = source.slice(Math.max(0, openAt - 400), openAt + 80);

    expect(window).toContain("emitDiscoveryFromHref");
  });

  it("emits discovery_preview only from an explicit public preview after playback starts", () => {
    const player = sources.find((file) => file.rel === "lib/preview-player.ts");
    const source = player?.source ?? "";

    expect(source).toContain("shouldEmitDiscoveryPreview(options)");
    expect(source).toContain("publicPreview");
    expect(source).toContain('"discovery_preview"');
    expect(source).toContain('from "./discovery-emit"');

    const playingHandler = source.match(
      /addEventListener\("playing",\s*\(\) => \{([\s\S]*?)\n  \}\)/,
    );

    expect(playingHandler?.[1]).toContain('emitDiscoveryEvent("discovery_preview")');

    const startBody = source.match(
      /export function startPreview\([\s\S]*?element\.play\(\)\.catch/,
    )?.[0];

    expect(startBody).toBeDefined();
    expect(startBody).not.toContain("emitDiscoveryEvent");
  });

  it("marks neighbour rails as similar by behaviour, not by the English on the chip", () => {
    const marked = sources.filter(
      (file) =>
        file.rel.endsWith(".tsx") &&
        file.source.includes('data-discovery="similar"') &&
        !file.rel.includes("discovery-listener"),
    );

    expect(marked.map((file) => file.rel).sort()).toEqual([
      "components/chat/neighbour-card.tsx",
      "routes/artist.$slug.tsx",
      "routes/artists.index.tsx",
      "routes/log.$logId.tsx",
    ]);

    const artistChips = sources.find((file) => file.rel === "components/graph-sections.tsx");

    expect(artistChips?.source).toContain("ArtistChips");
    expect(artistChips?.source).not.toContain('data-discovery="similar"');
  });

  it("does not fire discovery events from a render effect except the click listener itself", () => {
    const offenders: string[] = [];

    for (const file of sources) {
      if (file.rel === "components/discovery-listener.tsx") {
        continue;
      }

      if (
        !file.source.includes("emitDiscoveryEvent") &&
        !file.source.includes("emitDiscoveryFromHref")
      ) {
        continue;
      }

      const effects = [...file.source.matchAll(/useEffect\(\(\)\s*=>\s*\{([\s\S]*?)\},/g)];

      for (const match of effects) {
        const body = match[1] ?? "";

        if (body.includes("emitDiscoveryEvent") || body.includes("emitDiscoveryFromHref")) {
          // The palette debounce is a committed query, not a render. It must skip example clicks.
          if (
            file.rel === "components/search/search-command.tsx" &&
            body.includes("exampleClick")
          ) {
            continue;
          }

          offenders.push(file.rel);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("never sends raw query text, identifiers, or session fields from the helper", () => {
    const helper = read(join(WEB_SRC, "lib/discovery-events.ts"));

    const helperCode = helper
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
      .join("\n");

    expect(helperCode).not.toMatch(/sessionId|userId|visitorId|personaliz/i);
    expect(helper).toContain("SEARCH_EXAMPLES");

    const emit = read(join(WEB_SRC, "lib/discovery-emit.ts"));
    const emitCode = emit
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
      .join("\n");

    expect(emit).toContain("sanitizeMetadata");
    expect(emit).toContain("DISCOVERY_QUERY_KINDS");
    expect(emitCode).not.toMatch(/sessionId|userId|visitorId|personaliz/i);
  });
});

describe("preview call sites state public intent", () => {
  const SKIP_FOR_SITES = new Set(["api", "db", "game", "pipeline", "server", "test"]);
  const siteFiles = walk(WEB_SRC, SKIP_FOR_SITES).map((path) => ({
    rel: rel(path),
    source: read(path),
  }));

  it("public usePreviewPlayer call sites opt in; admin ones never do", () => {
    const hookSites = siteFiles.filter(
      (file) => file.rel !== "lib/preview-player.ts" && file.source.includes("usePreviewPlayer("),
    );
    const publicSites = hookSites.filter((file) => !file.rel.includes("/admin/"));
    const adminSites = hookSites.filter((file) => file.rel.includes("/admin/"));

    expect(publicSites.map((file) => file.rel).sort()).toEqual([
      "components/account/saves-door.tsx",
      "components/chat/chain-card.tsx",
      "components/chat/finding-card.tsx",
      "components/log/log-footage.tsx",
      "components/recommendations/recommended-panel.tsx",
    ]);
    expect(adminSites.map((file) => file.rel).sort()).toEqual(["components/admin/note-dialog.tsx"]);

    for (const file of publicSites) {
      expect(file.source, `${file.rel} must pass publicPreview: true`).toMatch(
        /usePreviewPlayer\([\s\S]*publicPreview:\s*true/,
      );
    }

    for (const file of adminSites) {
      expect(file.source, `${file.rel} must not opt into public preview`).not.toContain(
        "publicPreview",
      );
    }
  });

  it("public usePreviewControls start opts in; admin starts stay silent even when src is omitted", () => {
    const startSites = siteFiles.filter(
      (file) =>
        file.rel !== "lib/preview-player.ts" &&
        file.source.includes("usePreviewControls") &&
        /\bstart\(/.test(file.source),
    );
    const publicSites = startSites.filter((file) => !file.rel.includes("/admin/"));
    const adminSites = startSites.filter((file) => file.rel.includes("/admin/"));

    expect(publicSites.map((file) => file.rel).sort()).toEqual(["components/mix/mix-builder.tsx"]);
    expect(adminSites.map((file) => file.rel).sort()).toEqual([
      "routes/admin/catalogue.tsx",
      "routes/admin/galaxies.tsx",
    ]);

    for (const file of publicSites) {
      expect(file.source, `${file.rel} must pass publicPreview: true`).toMatch(
        /\bstart\([\s\S]*publicPreview:\s*true/,
      );
    }

    for (const file of adminSites) {
      expect(file.source, `${file.rel} must not opt into public preview`).not.toContain(
        "publicPreview",
      );
    }

    const galaxies = adminSites.find((file) => file.rel === "routes/admin/galaxies.tsx");
    const catalogue = adminSites.find((file) => file.rel === "routes/admin/catalogue.tsx");

    expect(galaxies?.source).toMatch(/\bstart\(\s*logId\s*\)/);
    expect(catalogue?.source).toMatch(/\bstart\(\s*trackId,\s*\{\s*src:\s*auditionSrc\s*\}\s*\)/);
  });
});
