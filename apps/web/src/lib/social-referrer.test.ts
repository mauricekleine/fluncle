import { describe, expect, it } from "vitest";
import { classifySocialReferrer } from "./social-referrer";

const ORIGIN = "https://fluncle.com";

describe("classifySocialReferrer", () => {
  it("recognises all four supported platforms", () => {
    expect(classifySocialReferrer("https://www.tiktok.com/@fluncle/video/123", ORIGIN)).toBe(
      "tiktok",
    );
    expect(classifySocialReferrer("https://www.youtube.com/watch?v=abc", ORIGIN)).toBe("youtube");
    expect(classifySocialReferrer("https://www.instagram.com/p/abc/", ORIGIN)).toBe("instagram");
    expect(classifySocialReferrer("https://bsky.app/profile/fluncle.com/post/abc", ORIGIN)).toBe(
      "bluesky",
    );
  });

  it("matches platform-owned subdomains and share hosts", () => {
    // TikTok share/shortener host, YouTube mobile + its own short domain, IG link wrapper.
    expect(classifySocialReferrer("https://vm.tiktok.com/ZM123/", ORIGIN)).toBe("tiktok");
    expect(classifySocialReferrer("https://m.youtube.com/watch?v=abc", ORIGIN)).toBe("youtube");
    expect(classifySocialReferrer("https://youtu.be/abc", ORIGIN)).toBe("youtube");
    expect(classifySocialReferrer("https://l.instagram.com/?u=abc", ORIGIN)).toBe("instagram");
  });

  it("returns null for an empty referrer (direct hit or stripped)", () => {
    expect(classifySocialReferrer("", ORIGIN)).toBeNull();
  });

  it("returns null for a same-origin (internal) referrer", () => {
    expect(classifySocialReferrer("https://fluncle.com/log/241.7.3A", ORIGIN)).toBeNull();
    // A subdomain of our own host is still internal.
    expect(classifySocialReferrer("https://www.fluncle.com/", "https://fluncle.com")).toBeNull();
  });

  it("returns null for junk / unparseable referrers", () => {
    expect(classifySocialReferrer("not a url", ORIGIN)).toBeNull();
    expect(classifySocialReferrer("javascript:void(0)", ORIGIN)).toBeNull();
    expect(classifySocialReferrer("android-app://com.example", ORIGIN)).toBeNull();
  });

  it("returns null for off-allowlist sites, including generic shorteners", () => {
    expect(classifySocialReferrer("https://example.com/x", ORIGIN)).toBeNull();
    expect(classifySocialReferrer("https://www.google.com/search?q=fluncle", ORIGIN)).toBeNull();
    // t.co-style shorteners are explicitly out of scope — they carry no platform identity.
    expect(classifySocialReferrer("https://t.co/abcdef", ORIGIN)).toBeNull();
  });

  it("does not match a lookalike domain that merely contains an allowlisted name", () => {
    // Suffix matching must be on a dot boundary: `nottiktok.com` and
    // `tiktok.com.evil.example` are not TikTok.
    expect(classifySocialReferrer("https://nottiktok.com/x", ORIGIN)).toBeNull();
    expect(classifySocialReferrer("https://tiktok.com.evil.example/x", ORIGIN)).toBeNull();
  });

  it("survives an unparseable currentOrigin without misclassifying", () => {
    expect(classifySocialReferrer("https://www.tiktok.com/@fluncle", "")).toBe("tiktok");
  });
});
