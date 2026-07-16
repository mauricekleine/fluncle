import { describe, expect, it } from "vitest";
import { type SavedFinding } from "./shared";
import { filterSavedFindings, SAVES_POWER_SCALE, sortSavedFindings } from "./saves-filter";

// The saved-findings power-scale tools are pure functions (kept out of the component
// on purpose), so they carry their own focused tests: substring search + the two sorts.

function finding(over: Partial<SavedFinding> & { title: string }): SavedFinding {
  return {
    artists: over.artists ?? ["Nobody"],
    imageUrl: over.imageUrl,
    logId: over.logId ?? "0001",
    note: over.note,
    savedAt: over.savedAt ?? "2026-01-01T00:00:00.000Z",
    title: over.title,
    trackId: over.trackId ?? over.title,
  };
}

const list: SavedFinding[] = [
  finding({ artists: ["Netsky"], savedAt: "2026-03-01T00:00:00.000Z", title: "Come Alive" }),
  finding({
    artists: ["Nu:Tone", "Logistics"],
    savedAt: "2026-01-01T00:00:00.000Z",
    title: "Balaclava",
  }),
  finding({ artists: ["Alix Perez"], savedAt: "2026-02-01T00:00:00.000Z", title: "Forsaken" }),
];

describe("filterSavedFindings", () => {
  it("returns the list untouched (same reference) for a blank query", () => {
    expect(filterSavedFindings(list, "")).toBe(list);
    expect(filterSavedFindings(list, "   ")).toBe(list);
  });

  it("matches on the title, case-insensitively", () => {
    expect(filterSavedFindings(list, "alive").map((f) => f.title)).toEqual(["Come Alive"]);
    expect(filterSavedFindings(list, "FORSAKEN").map((f) => f.title)).toEqual(["Forsaken"]);
  });

  it("matches on any artist name", () => {
    expect(filterSavedFindings(list, "logistics").map((f) => f.title)).toEqual(["Balaclava"]);
    expect(filterSavedFindings(list, "nu:tone").map((f) => f.title)).toEqual(["Balaclava"]);
  });

  it("returns nothing when neither artist nor title matches", () => {
    expect(filterSavedFindings(list, "zzz nothing")).toEqual([]);
  });
});

describe("sortSavedFindings", () => {
  it("returns the server order untouched for 'saved' (same reference)", () => {
    expect(sortSavedFindings(list, "saved")).toBe(list);
  });

  it("sorts A→Z by title for 'title', case-insensitively, without mutating the input", () => {
    const sorted = sortSavedFindings(list, "title");

    expect(sorted.map((f) => f.title)).toEqual(["Balaclava", "Come Alive", "Forsaken"]);
    // The input array is not reordered — the toggle back to 'saved' still has it.
    expect(list.map((f) => f.title)).toEqual(["Come Alive", "Balaclava", "Forsaken"]);
  });
});

describe("SAVES_POWER_SCALE", () => {
  it("is the ~40-finding threshold the brief calls for", () => {
    expect(SAVES_POWER_SCALE).toBe(40);
  });
});
