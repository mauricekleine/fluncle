import { describe, expect, it } from "vitest";

import {
  type Candidate,
  matchVideoIdForCandidate,
  normalizeTitle,
  predatesThumbnailSupport,
  THUMBNAIL_SUPPORT_CUTOFF,
  type UploadedVideo,
} from "../../scripts/backfill-youtube-thumbnails.helpers";

describe("normalizeTitle", () => {
  it("lowercases, strips punctuation, and collapses whitespace", () => {
    expect(normalizeTitle("Artist — Title (Remix)!")).toBe("artist title remix");
    expect(normalizeTitle("  Hello   World  ")).toBe("hello world");
    expect(normalizeTitle("A.B-C/D")).toBe("a b c d");
  });

  it("treats differently-punctuated forms of the same title as equal", () => {
    expect(normalizeTitle("Café del Mar")).toBe(normalizeTitle("cafe  del—mar"));
  });

  it("returns empty for punctuation-only input", () => {
    expect(normalizeTitle("!!! --- ???")).toBe("");
  });
});

describe("predatesThumbnailSupport", () => {
  it("is true strictly before the cutoff", () => {
    expect(predatesThumbnailSupport("2026-06-13T12:14:28+02:00")).toBe(true);
    expect(predatesThumbnailSupport("2026-06-01T00:00:00Z")).toBe(true);
  });

  it("is false at or after the cutoff", () => {
    expect(predatesThumbnailSupport(THUMBNAIL_SUPPORT_CUTOFF.toISOString())).toBe(false);
    expect(predatesThumbnailSupport("2026-06-13T12:14:30+02:00")).toBe(false);
    expect(predatesThumbnailSupport("2026-07-01T00:00:00Z")).toBe(false);
  });

  it("is false for a missing or unparseable date", () => {
    expect(predatesThumbnailSupport(undefined)).toBe(false);
    expect(predatesThumbnailSupport("")).toBe(false);
    expect(predatesThumbnailSupport("not a date")).toBe(false);
  });

  it("respects a custom cutoff", () => {
    const cutoff = new Date("2026-01-01T00:00:00Z");
    expect(predatesThumbnailSupport("2025-12-31T23:59:59Z", cutoff)).toBe(true);
    expect(predatesThumbnailSupport("2026-01-02T00:00:00Z", cutoff)).toBe(false);
  });
});

describe("matchVideoIdForCandidate", () => {
  const candidate: Candidate = {
    logId: "001.1.1",
    publishedAt: "2026-06-10T10:00:00Z",
    title: "Artist — Some Track (Edit)",
  };

  it("matches by normalized title", () => {
    const uploads: UploadedVideo[] = [
      { publishedAt: "2026-06-10T10:05:00Z", title: "artist some track edit", videoId: "vid-1" },
      { publishedAt: "2026-06-09T00:00:00Z", title: "unrelated", videoId: "vid-2" },
    ];

    expect(matchVideoIdForCandidate(candidate, uploads)).toBe("vid-1");
  });

  it("returns undefined when nothing matches", () => {
    const uploads: UploadedVideo[] = [
      { publishedAt: "2026-06-10T10:05:00Z", title: "completely different", videoId: "vid-1" },
    ];

    expect(matchVideoIdForCandidate(candidate, uploads)).toBeUndefined();
  });

  it("returns undefined for a candidate whose title normalizes to empty", () => {
    const blank: Candidate = { logId: "x", publishedAt: "2026-06-10T10:00:00Z", title: "!!!" };
    const uploads: UploadedVideo[] = [
      { publishedAt: undefined, title: "anything", videoId: "vid-1" },
    ];

    expect(matchVideoIdForCandidate(blank, uploads)).toBeUndefined();
  });

  it("breaks a title collision by publish-time proximity", () => {
    const uploads: UploadedVideo[] = [
      { publishedAt: "2026-06-01T00:00:00Z", title: "Artist Some Track Edit", videoId: "far" },
      { publishedAt: "2026-06-10T10:01:00Z", title: "artist some track edit", videoId: "near" },
      {
        publishedAt: "2026-06-20T00:00:00Z",
        title: "ARTIST  SOME  TRACK  EDIT",
        videoId: "also-far",
      },
    ];

    expect(matchVideoIdForCandidate(candidate, uploads)).toBe("near");
  });

  it("prefers a dated sibling over an undated one in a collision", () => {
    const uploads: UploadedVideo[] = [
      { publishedAt: undefined, title: "artist some track edit", videoId: "undated" },
      { publishedAt: "2026-06-10T10:02:00Z", title: "artist some track edit", videoId: "dated" },
    ];

    expect(matchVideoIdForCandidate(candidate, uploads)).toBe("dated");
  });

  it("still matches a single undated upload", () => {
    const uploads: UploadedVideo[] = [
      { publishedAt: undefined, title: "artist some track edit", videoId: "only" },
    ];

    expect(matchVideoIdForCandidate(candidate, uploads)).toBe("only");
  });
});
