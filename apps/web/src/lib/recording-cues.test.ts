import { type RecordingTracklistItem } from "@fluncle/contracts/orpc";
import { describe, expect, it } from "vitest";
import {
  addCue,
  clearCue,
  editCue,
  markCue,
  parseArtists,
  recordingCueProgress,
  removeCue,
} from "./recording-cues";

// The recording cue-authoring logic (RFC recording-primitive, Design B — Wave 3), tested
// DOM-free: every array transform the add-a-cue editor drives, pure and deterministic.

const base: RecordingTracklistItem[] = [
  { artists: ["Alix Perez"], id: "a", startMs: 0, title: "Forsaken" },
  { artists: ["Monty"], id: "b", title: "Zeal" },
];

describe("parseArtists", () => {
  it("splits a comma-separated field, trimming blanks", () => {
    expect(parseArtists("Alix Perez, Monty")).toEqual(["Alix Perez", "Monty"]);
  });

  it("returns [] for an empty field", () => {
    expect(parseArtists("   ")).toEqual([]);
  });

  it("drops empty segments from trailing/duplicate commas", () => {
    expect(parseArtists("Halogenix,, ,Alix Perez,")).toEqual(["Halogenix", "Alix Perez"]);
  });
});

describe("addCue", () => {
  it("appends a cue with a fresh id and no startMs, trimming the title", () => {
    const next = addCue(base, { artists: ["Skeptical"], title: "  Blue Eyes  " }, () => "c");

    expect(next).toHaveLength(3);
    expect(next[2]).toEqual({ artists: ["Skeptical"], id: "c", title: "Blue Eyes" });
    expect(base).toHaveLength(2); // pure — original untouched
  });

  it("generates a string id by default", () => {
    const next = addCue([], { artists: [], title: "Untitled ID" });

    expect(typeof next[0]?.id).toBe("string");
    expect((next[0]?.id.length ?? 0) > 0).toBe(true);
  });

  it("is a no-op for a blank title", () => {
    expect(addCue(base, { artists: ["Nobody"], title: "   " })).toBe(base);
  });

  it("carries a findingId when the cue links a real finding", () => {
    const next = addCue(
      base,
      { artists: ["Skeptical"], findingId: "trk-1", title: "Blue Eyes" },
      () => "c",
    );

    expect(next[2]).toEqual({
      artists: ["Skeptical"],
      findingId: "trk-1",
      id: "c",
      title: "Blue Eyes",
    });
  });

  it("omits findingId for a free-text cue (no empty-string key)", () => {
    const next = addCue([], { artists: ["Free"], title: "Text Cue" }, () => "c");

    expect("findingId" in (next[0] ?? {})).toBe(false);
  });
});

describe("markCue / clearCue", () => {
  it("sets startMs at the (rounded, floored) playhead", () => {
    expect(markCue(base, "b", 90_400.7).find((c) => c.id === "b")?.startMs).toBe(90_401);
  });

  it("floors a negative playhead at 0", () => {
    expect(markCue(base, "b", -5).find((c) => c.id === "b")?.startMs).toBe(0);
  });

  it("clears startMs back to unmarked", () => {
    expect(clearCue(base, "a").find((c) => c.id === "a")?.startMs).toBeUndefined();
  });
});

describe("editCue", () => {
  it("edits artists + title, keeping startMs", () => {
    const next = editCue(base, "a", { artists: ["Alix Perez", "SpectraSoul"], title: "New Title" });
    const cue = next.find((c) => c.id === "a");

    expect(cue).toEqual({
      artists: ["Alix Perez", "SpectraSoul"],
      id: "a",
      startMs: 0,
      title: "New Title",
    });
  });

  it("ignores a blank title (a cue must keep one)", () => {
    expect(editCue(base, "b", { title: "  " }).find((c) => c.id === "b")?.title).toBe("Zeal");
  });

  it("keeps an existing finding link when only the text is edited", () => {
    const linked: RecordingTracklistItem[] = [
      { artists: ["Alix Perez"], findingId: "trk-1", id: "a", title: "Forsaken" },
    ];

    expect(editCue(linked, "a", { title: "Forsaken (VIP)" }).find((c) => c.id === "a")).toEqual({
      artists: ["Alix Perez"],
      findingId: "trk-1",
      id: "a",
      title: "Forsaken (VIP)",
    });
  });

  it("sets a finding link when the patch carries a findingId", () => {
    expect(editCue(base, "b", { findingId: "trk-2" }).find((c) => c.id === "b")?.findingId).toBe(
      "trk-2",
    );
  });

  it("clears the finding link when the patch carries an empty findingId (back to free-text)", () => {
    const linked: RecordingTracklistItem[] = [
      { artists: ["Monty"], findingId: "trk-2", id: "b", title: "Zeal" },
    ];
    const next = editCue(linked, "b", { findingId: "" }).find((c) => c.id === "b");

    expect("findingId" in (next ?? {})).toBe(false);
  });
});

describe("removeCue", () => {
  it("drops the cue by id", () => {
    expect(removeCue(base, "a").map((c) => c.id)).toEqual(["b"]);
  });
});

describe("recordingCueProgress", () => {
  it("counts marked over total", () => {
    expect(recordingCueProgress(base)).toEqual({ marked: 1, total: 2 });
  });

  it("is 0 / 0 for an empty tracklist", () => {
    expect(recordingCueProgress([])).toEqual({ marked: 0, total: 0 });
  });
});
