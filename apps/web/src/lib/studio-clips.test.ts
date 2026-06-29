import { type ClipDTO } from "@fluncle/contracts/orpc";
import { describe, expect, it } from "vitest";
import {
  ALL_FILTER,
  clipDownloadUrls,
  clipDurationMs,
  clipPosterUrl,
  clipPreviewUrl,
  DEFAULT_CLIP_FILTER,
  filterClips,
} from "./studio-clips";

// The clip library's pure logic (Fluncle Studio Unit G): the two-dropdown filter and
// the download/poster URL builders, tested DOM-free (no ffmpeg, no `<video>`).

function clip(overrides: Partial<ClipDTO> = {}): ClipDTO {
  return {
    caption: undefined,
    createdAt: "2026-06-29T00:00:00.000Z",
    id: "clip-1",
    inMs: 1_000,
    mixtapeId: "tape-1",
    outMs: 16_000,
    status: "done",
    updatedAt: "2026-06-29T00:00:00.000Z",
    xOffset: 0,
    ...overrides,
  };
}

describe("filterClips", () => {
  const clips = [
    clip({ id: "a", mixtapeId: "tape-1", status: "done" }),
    clip({ id: "b", mixtapeId: "tape-1", status: "pending" }),
    clip({ id: "c", mixtapeId: "tape-2", status: "done" }),
  ];

  it("returns the whole list untouched under the default (all/all) filter", () => {
    expect(filterClips(clips, DEFAULT_CLIP_FILTER)).toEqual(clips);
  });

  it("narrows by mixtape", () => {
    const result = filterClips(clips, { mixtapeId: "tape-1", status: ALL_FILTER });

    expect(result.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("narrows by status", () => {
    const result = filterClips(clips, { mixtapeId: ALL_FILTER, status: "done" });

    expect(result.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("narrows by mixtape AND status together", () => {
    const result = filterClips(clips, { mixtapeId: "tape-1", status: "pending" });

    expect(result.map((c) => c.id)).toEqual(["b"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterClips(clips, { mixtapeId: "tape-2", status: "pending" })).toEqual([]);
  });

  it("preserves the input order (server sorts newest-first)", () => {
    const result = filterClips(clips, { mixtapeId: ALL_FILTER, status: "done" });

    expect(result).toEqual([clips[0], clips[2]]);
  });
});

describe("clipDurationMs", () => {
  it("is out − in", () => {
    expect(clipDurationMs({ inMs: 1_000, outMs: 16_000 })).toBe(15_000);
  });

  it("floors a malformed (out ≤ in) window at 0", () => {
    expect(clipDurationMs({ inMs: 5_000, outMs: 1_000 })).toBe(0);
  });
});

describe("clipDownloadUrls", () => {
  const { silent, withAudio } = clipDownloadUrls("clip-xyz");

  it("with-audio is the clip's bare pseudo-finding master (footage.mp4)", () => {
    expect(withAudio).toBe("https://found.fluncle.com/clip-xyz/footage.mp4");
  });

  it("silent strips audio off that master via a Media Transformation", () => {
    expect(silent).toContain("/cdn-cgi/media/");
    expect(silent).toContain("audio=false");
    expect(silent).toContain("clip-xyz/footage.mp4");
  });

  it("encodes a clipId with unsafe characters", () => {
    expect(clipDownloadUrls("a b").withAudio).toBe("https://found.fluncle.com/a%20b/footage.mp4");
  });
});

describe("clipPosterUrl / clipPreviewUrl", () => {
  it("the poster is a portrait frame off the clip's footage", () => {
    const url = clipPosterUrl("clip-xyz");

    expect(url).toContain("/cdn-cgi/media/");
    expect(url).toContain("mode=frame");
    expect(url).toContain("clip-xyz/footage.mp4");
  });

  it("the preview is a portrait video rendition off the clip's footage", () => {
    const url = clipPreviewUrl("clip-xyz");

    expect(url).toContain("/cdn-cgi/media/");
    expect(url).toContain("fit=cover");
    expect(url).toContain("clip-xyz/footage.mp4");
  });
});
