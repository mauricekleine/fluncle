import { describe, expect, it } from "vitest";
import { renderLlmsFull } from "./agent-discovery";
import { type TrackListItem } from "./tracks";

function finding(overrides: Partial<TrackListItem>): TrackListItem {
  return {
    addedAt: "2026-06-15T20:00:00.000Z",
    addedToSpotify: true,
    artists: ["Camo & Krooked"],
    durationMs: 215_000,
    enrichmentStatus: "done",
    postedToTelegram: true,
    spotifyUrl: "https://open.spotify.com/track/abc",
    title: "Test Banger",
    trackId: "abc",
    ...overrides,
  };
}

describe("renderLlmsFull", () => {
  it("opens with the canonical description and the Log ID decode", () => {
    const doc = renderLlmsFull([], 0);

    expect(doc).toContain("Drum & bass bangers from another dimension.");
    expect(doc).toContain("How to read a Log ID");
    expect(doc).toContain("## The findings (0)");
  });

  it("renders a finding with its coordinate and present facts", () => {
    const doc = renderLlmsFull(
      [
        finding({
          bpm: 172.94,
          galaxy: { key: "nebular", name: "Nebular" },
          key: "F minor",
          logId: "012.8.0A",
        }),
      ],
      1,
    );

    expect(doc).toContain(
      "**Camo & Krooked — Test Banger** (found 2026-06-15, fluncle://012.8.0A)",
    );
    expect(doc).toContain(
      "173 BPM · F minor · Nebular galaxy · https://open.spotify.com/track/abc",
    );
  });

  it("omits absent facts and marks a finding without a Log ID", () => {
    const doc = renderLlmsFull([finding({})], 1);

    expect(doc).toContain("(found 2026-06-15, uncoordinated)");
    expect(doc).toContain("  https://open.spotify.com/track/abc");
    expect(doc).not.toContain("BPM");
  });

  it("notes omitted findings when the archive is truncated", () => {
    const doc = renderLlmsFull([finding({ logId: "012.8.0A" })], 30);

    expect(doc).toContain("29 older findings omitted");
  });
});
