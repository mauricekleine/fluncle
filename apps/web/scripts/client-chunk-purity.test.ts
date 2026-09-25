import { describe, expect, it, vi } from "vitest";
import {
  clientChunkPurityGate,
  clientChunkPurityMessage,
  clientChunkPurityReport,
  type PurityChunk,
} from "./client-chunk-purity";

const ROOT = "/repo/apps/web/src";
const NO_IMPORTS = () => [];

function chunk(isEntry: boolean, modules: Record<string, number>): PurityChunk {
  return {
    isEntry,
    modules: Object.fromEntries(
      Object.entries(modules).map(([id, renderedLength]) => [id, { renderedLength }]),
    ),
  };
}

describe("clientChunkPurityReport", () => {
  it("passes a bundle of client-safe modules", () => {
    const report = clientChunkPurityReport(
      {
        "assets/chunk~artists.js": chunk(false, {
          [`${ROOT}/lib/track-stage.ts`]: 1175,
          [`${ROOT}/routes/admin/artists.tsx`]: 30000,
        }),
        "assets/entry.js": chunk(true, { [`${ROOT}/lib/artist-review.ts`]: 4000 }),
      },
      NO_IMPORTS,
    );

    expect(report).toEqual({ eager: [], lazy: [] });
    expect(clientChunkPurityMessage(report)).toBeNull();
  });

  it("fires on a server module in a LAZY route chunk — the shape that takes a route down", () => {
    const report = clientChunkPurityReport(
      {
        "assets/chunk~artists.js": chunk(false, {
          [`${ROOT}/db/schema.ts`]: 82164,
          [`${ROOT}/lib/server/artists.ts`]: 2444,
          [`${ROOT}/lib/server/database-request-scope.ts`]: 147,
        }),
      },
      NO_IMPORTS,
    );

    expect(report.eager).toEqual([]);
    expect(report.lazy).toEqual([
      "assets/chunk~artists.js: src/db/schema.ts (82164 B)",
      "assets/chunk~artists.js: src/lib/server/artists.ts (2444 B)",
      "assets/chunk~artists.js: src/lib/server/database-request-scope.ts (147 B)",
    ]);

    const message = clientChunkPurityMessage(report);
    expect(message).toContain("Server-only modules reached lazy client route chunks (3)");
    expect(message).toContain("src/lib/server/database-request-scope.ts");
    expect(message).toContain("docs/client-bundle.md");
  });

  it("fires on a server module in the EAGER entry chunk, and names that blast radius instead", () => {
    const report = clientChunkPurityReport(
      { "assets/entry.js": chunk(true, { [`${ROOT}/lib/server/galaxies-map.ts`]: 900 }) },
      NO_IMPORTS,
    );

    expect(report.lazy).toEqual([]);
    expect(report.eager).toEqual(["src/lib/server/galaxies-map.ts (900 B)"]);

    const message = clientChunkPurityMessage(report);
    expect(message).toContain("Server-only modules reached the eager client entry chunk (1)");
    expect(message).toContain("before it paints");
  });

  it("reports both radii at once when a bundle leaks into each", () => {
    const report = clientChunkPurityReport(
      {
        "assets/chunk~findings.js": chunk(false, { [`${ROOT}/lib/server/track-stage.ts`]: 1175 }),
        "assets/entry.js": chunk(true, { [`${ROOT}/db/schema.ts`]: 82164 }),
      },
      NO_IMPORTS,
    );

    expect(report.eager).toHaveLength(1);
    expect(report.lazy).toHaveLength(1);
  });

  it("holds the one exemption only while its import-free premise holds", () => {
    const trackMatch = `${ROOT}/lib/server/track-match.ts`;
    const bundle = { "assets/entry.js": chunk(true, { [trackMatch]: 3000 }) };

    expect(clientChunkPurityReport(bundle, NO_IMPORTS).eager).toEqual([]);

    const grown = clientChunkPurityReport(bundle, () => [`${ROOT}/lib/server/db.ts`]);
    expect(grown.eager).toEqual([
      "apps/web/src/lib/server/track-match.ts — exempt ONLY while import-free, and it now imports 1",
    ]);
  });
});

describe("the gate plugin", () => {
  const leakyBundle = {
    "assets/chunk~artists.js": {
      isEntry: false,
      modules: { [`${ROOT}/lib/server/artists.ts`]: { renderedLength: 2444 } },
      type: "chunk",
    },
    "assets/styles.css": { type: "asset" },
  } as never;

  function runGate(dir: string, bundle: unknown) {
    const gate = clientChunkPurityGate();
    const error = vi.fn();
    const generateBundle = gate.generateBundle;

    if (typeof generateBundle !== "function") {
      throw new TypeError("the gate must expose a generateBundle hook");
    }

    void generateBundle.call(
      { error, getModuleInfo: () => null } as never,
      { dir } as never,
      bundle as never,
      false,
    );

    return error;
  }

  it("is named so a failing build points at this file", () => {
    expect(clientChunkPurityGate().name).toBe("fluncle-client-chunk-purity");
  });

  it("fails the client build on a leak, through the real hook signature", () => {
    const error = runGate("/repo/apps/web/dist/client", leakyBundle);

    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain("src/lib/server/artists.ts (2444 B)");
  });

  it("leaves the SSR bundle alone — the Worker is allowed every server module", () => {
    expect(runGate("/repo/apps/web/dist/server", leakyBundle)).not.toHaveBeenCalled();
  });

  it("stays silent on a clean client bundle", () => {
    const clean = {
      "assets/chunk~artists.js": {
        isEntry: false,
        modules: { [`${ROOT}/lib/artist-review.ts`]: { renderedLength: 4000 } },
        type: "chunk",
      },
    } as never;

    expect(runGate("/repo/apps/web/dist/client", clean)).not.toHaveBeenCalled();
  });
});
