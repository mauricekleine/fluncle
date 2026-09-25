import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalShareUrl, shareLink, shareMode } from "./share-track";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("canonicalShareUrl", () => {
  it("points a finding at its log page on the canonical host", () => {
    expect(canonicalShareUrl({ href: "/log/241.7.3A" })).toBe(
      "https://www.fluncle.com/log/241.7.3A",
    );
  });

  it("points a catalogue track at its own page", () => {
    expect(canonicalShareUrl({ href: "/track/e2e-track-1", spotifyUrl: "https://x" })).toBe(
      "https://www.fluncle.com/track/e2e-track-1",
    );
  });

  it("never carries a query string or fragment", () => {
    expect(canonicalShareUrl({ href: "/track/abc?utm_source=x&ref=me#top" })).toBe(
      "https://www.fluncle.com/track/abc",
    );
  });

  it("falls back to the Spotify URL, stripped, only when there is no Fluncle page", () => {
    expect(canonicalShareUrl({ spotifyUrl: "https://open.spotify.com/track/123?si=abcdef" })).toBe(
      "https://open.spotify.com/track/123",
    );
  });

  it("has nothing to share without a page or a Spotify link", () => {
    expect(canonicalShareUrl({})).toBeUndefined();
    expect(canonicalShareUrl({ spotifyUrl: "not a url" })).toBeUndefined();
  });
});

describe("shareMode", () => {
  it("opens the native sheet only on a touch screen that has one", () => {
    expect(shareMode({ canShare: true, coarsePointer: true })).toBe("native");
    expect(shareMode({ canShare: true, coarsePointer: false })).toBe("copy");
    expect(shareMode({ canShare: false, coarsePointer: true })).toBe("copy");
  });
});

function stubBrowser(options: { coarse: boolean; share?: (data: ShareData) => Promise<void> }) {
  const writeText = vi.fn(async (_text: string) => {});

  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({ matches: query === "(pointer: coarse)" && options.coarse }),
  });
  vi.stubGlobal("navigator", { clipboard: { writeText }, share: options.share });

  return { writeText };
}

describe("shareLink", () => {
  it("copies on a desktop even when the browser has a share sheet", async () => {
    const share = vi.fn(async () => {});
    const { writeText } = stubBrowser({ coarse: false, share });

    expect(await shareLink("T", "https://www.fluncle.com/log/1")).toBe("copied");
    expect(writeText).toHaveBeenCalledWith("https://www.fluncle.com/log/1");
    expect(share).not.toHaveBeenCalled();
  });

  it("opens the sheet on a phone and treats a dismissal as nothing to announce", async () => {
    const share = vi.fn(async () => {
      throw new DOMException("cancelled", "AbortError");
    });
    const { writeText } = stubBrowser({ coarse: true, share });

    expect(await shareLink("T", "https://www.fluncle.com/log/1")).toBe("dismissed");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back to copying when the sheet fails for another reason", async () => {
    const share = vi.fn(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    const { writeText } = stubBrowser({ coarse: true, share });

    expect(await shareLink("T", "https://www.fluncle.com/log/1")).toBe("copied");
    expect(writeText).toHaveBeenCalled();
  });
});
