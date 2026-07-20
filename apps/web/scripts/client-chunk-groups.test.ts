import { describe, expect, it } from "vitest";

import { clientChunkGroups, ENTRIES_AWARE_MERGE_THRESHOLD } from "./client-chunk-groups";

// These guard the two properties that make the client chunking safe rather than
// merely small. Both failure modes are SILENT — the build stays green, the chunk
// count still looks good, and a public page quietly triples in first-paint JS —
// so the invariants are asserted here instead of trusted to review.
describe("client chunk groups", () => {
  it("keeps the entries-aware merge threshold at zero", () => {
    // Non-zero merges subgroups ACROSS entry sets, which measurably welded the
    // 2.1 MB @scalar API-reference bundle onto /tracks. See the module comment.
    expect(ENTRIES_AWARE_MERGE_THRESHOLD).toBe(0);

    for (const group of clientChunkGroups) {
      if ("entriesAware" in group && group.entriesAware) {
        expect(group.entriesAwareMergeThreshold).toBe(0);
      }
    }
  });

  it("leaves the eager group unbounded", () => {
    // A `maxSize` here cuts the eager set at arbitrary module boundaries and
    // reorders CommonJS interop initialisation: at 1 MB the built app threw
    // "n is not a function" from the use-sync-external-store shim and never
    // hydrated, with the build, typecheck and tests all green. See the module.
    const app = clientChunkGroups.find((group) => group.name === "app");

    expect(app).toBeDefined();
    expect(app?.tags).toContain("$initial");
    expect(app?.maxSize).toBeUndefined();
  });

  it("merges the lazy tail only within an identical entry set", () => {
    // Every group that is NOT the eager `$initial` set must be entries-aware.
    // A lazy group without it merges by dependency tree and can pull one route's
    // vendor weight onto another route's critical path.
    const lazy = clientChunkGroups.filter((group) => !("tags" in group));

    expect(lazy.length).toBeGreaterThan(0);
    for (const group of lazy) {
      expect(group.entriesAware).toBe(true);
    }
  });

  it("orders groups so the eager set is matched first", () => {
    const priorities = clientChunkGroups.map((group) => group.priority ?? 0);

    expect(priorities).toStrictEqual([...priorities].sort((a, b) => b - a));
  });
});
