import { describe, expect, it } from "vitest";

import { clientChunkGroups, ENTRIES_AWARE_MERGE_THRESHOLD } from "./client-chunk-groups";

describe("client chunk groups", () => {
  it("keeps the entries-aware merge threshold at zero", () => {
    expect(ENTRIES_AWARE_MERGE_THRESHOLD).toBe(0);

    for (const group of clientChunkGroups) {
      if ("entriesAware" in group && group.entriesAware) {
        expect(group.entriesAwareMergeThreshold).toBe(0);
      }
    }
  });

  it("leaves the eager group unbounded", () => {
    const app = clientChunkGroups.find((group) => group.name === "app");

    expect(app).toBeDefined();
    expect(app?.tags).toContain("$initial");
    expect(app?.maxSize).toBeUndefined();
  });

  it("merges the lazy tail only within an identical entry set", () => {
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
