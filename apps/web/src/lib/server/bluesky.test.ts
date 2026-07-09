import { describe, expect, it } from "vitest";
import { type TrackMetadata } from "./spotify";
import { formatBlueskyPost, linkFacet, normalizeIdentifier } from "./bluesky";

// The Bluesky finding post is built by pure functions — formatBlueskyPost
// (the text + external-card fields + the inlined-link facet), linkFacet (the
// UTF-8 byte-offset link range), and normalizeIdentifier (the stored-handle →
// createSession identifier form). No transport, no env, so these pin the SHAPE +
// the voice (the 🛸 header mirroring Telegram, the note line, the Spotify listen
// link, no hashtag spam) and the byte-offset correctness the AT Protocol needs.
// The live crew-facing copy still gets a canon (VOICE.md) review; this guards the
// machinery.

const TRACK: TrackMetadata = {
  artists: ["Aktive", "Redeyes"],
  durationMs: 300000,
  spotifyArtistIds: ["a1", "a2"],
  spotifyUri: "spotify:track:abc123",
  spotifyUrl: "https://open.spotify.com/track/abc123",
  title: "Never Not (VIP)",
  trackId: "abc123",
};

describe("formatBlueskyPost", () => {
  it("leads with the 🛸 header, the artist line, the note, and the Spotify listen link", () => {
    const post = formatBlueskyPost(TRACK, "The break flips at the drop.", "019.7.2I");

    expect(post.text).toBe(
      [
        "🛸 Fluncle's Findings",
        "",
        "Aktive, Redeyes — Never Not (VIP)",
        "Why I'm playing it: The break flips at the drop.",
        "",
        "🎧 Spotify: https://open.spotify.com/track/abc123",
      ].join("\n"),
    );
    // One banger per post, no hashtag spam.
    expect(post.text).not.toContain("#");
  });

  it("points the external card at the finding's /log home with the artist line as title", () => {
    const post = formatBlueskyPost(TRACK, "The break flips at the drop.", "019.7.2I");

    expect(post.external.uri).toBe("https://www.fluncle.com/log/019.7.2I");
    expect(post.external.title).toBe("Aktive, Redeyes — Never Not (VIP)");
    expect(post.external.description).toBe("The break flips at the drop.");
  });

  it("falls back to the tagline card description and omits the note line when there's no note", () => {
    const post = formatBlueskyPost(TRACK, undefined, "019.7.2I");

    expect(post.text).not.toContain("Why I'm playing it:");
    expect(post.external.description).toBe("Drum & bass bangers from another dimension.");
  });

  it("treats a blank/whitespace note as absent", () => {
    const post = formatBlueskyPost(TRACK, "   ", "019.7.2I");

    expect(post.text).not.toContain("Why I'm playing it:");
    expect(post.external.description).toBe("Drum & bass bangers from another dimension.");
  });

  it("falls back to the site root card when the finding predates the Log ID", () => {
    const post = formatBlueskyPost(TRACK, undefined, undefined);

    expect(post.external.uri).toBe("https://www.fluncle.com/");
  });

  it("facets the inlined Spotify URL with a byte range that decodes back to the URL", () => {
    const post = formatBlueskyPost(TRACK, "The break flips at the drop.", "019.7.2I");

    expect(post.facets).toHaveLength(1);

    const facet = post.facets[0];
    expect(facet?.features[0]).toEqual({
      $type: "app.bsky.richtext.facet#link",
      uri: "https://open.spotify.com/track/abc123",
    });

    // The 🛸 (4 UTF-8 bytes) + the em dash (3 bytes) mean the byte offsets differ
    // from the JS string indices — decode the byte slice to prove the range lands
    // exactly on the URL.
    const bytes = new TextEncoder().encode(post.text);
    const slice = bytes.slice(facet?.index.byteStart, facet?.index.byteEnd);
    expect(new TextDecoder().decode(slice)).toBe("https://open.spotify.com/track/abc123");
  });
});

describe("normalizeIdentifier", () => {
  it("strips the leading @ from the stored handle form", () => {
    expect(normalizeIdentifier("@fluncle.com")).toBe("fluncle.com");
  });

  it("passes an already-bare handle through unchanged", () => {
    expect(normalizeIdentifier("fluncle.com")).toBe("fluncle.com");
  });

  it("trims surrounding whitespace before checking for the @", () => {
    expect(normalizeIdentifier(" @fluncle.com ")).toBe("fluncle.com");
  });
});

describe("linkFacet", () => {
  it("computes UTF-8 byte offsets past a multi-byte glyph", () => {
    const facet = linkFacet("🛸 https://example.com", "https://example.com");

    // "🛸 " is 4 + 1 = 5 bytes, so the URL starts at byte 5, not char index 3.
    expect(facet?.index.byteStart).toBe(5);
    expect(facet?.index.byteEnd).toBe(5 + "https://example.com".length);
  });

  it("returns undefined when the URL is not present in the text", () => {
    expect(linkFacet("no link here", "https://example.com")).toBeUndefined();
  });
});
