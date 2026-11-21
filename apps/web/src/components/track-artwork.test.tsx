import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MANAGED_FALLBACK_ATTRIBUTE } from "@/lib/image-transform-fallback";
import { labelLogoUrl } from "@/lib/media";
import { type ArtworkFailure, artworkAttempt, artworkFailure, TrackArtwork } from "./track-artwork";

const transformed = labelLogoUrl("albums/drift.jpg", "2026-11-21T08:00:00.000Z", "medium") ?? "";
const ownedSource = transformed.slice(transformed.indexOf("https://", 1));
const srcSet = `${transformed} 300w`;

function renderedAfter(failedUrls: string[], src = transformed) {
  let failure: ArtworkFailure | undefined;

  for (const failedUrl of failedUrls) {
    failure = artworkFailure(src, failedUrl);
  }

  return artworkAttempt(src, srcSet, "64px", failure);
}

describe("TrackArtwork fallback sequence", () => {
  it("renders the transform first, then the owned source without a srcset, then the eclipse", () => {
    expect(renderedAfter([])).toEqual({ kind: "image", sizes: "64px", src: transformed, srcSet });
    expect(renderedAfter([transformed])).toEqual({ kind: "image", src: ownedSource });
    expect(renderedAfter([transformed, ownedSource])).toEqual({ kind: "eclipse" });
  });

  it("tries the owned source even when the same transform failure is reported twice", () => {
    expect(renderedAfter([transformed, transformed])).toEqual({ kind: "image", src: ownedSource });
  });

  it("goes straight to the eclipse for a source that is not a Cloudflare transform", () => {
    const spotify = "https://i.scdn.co/image/ab67616d0000b273abc";

    expect(renderedAfter([spotify], spotify)).toEqual({ kind: "eclipse" });
  });

  it("restarts the sequence when the requested source changes", () => {
    const exhausted = artworkFailure(transformed, ownedSource);
    const replaced = transformed.replace("width=300", "width=640");

    expect(artworkAttempt(replaced, undefined, undefined, exhausted)).toEqual({
      kind: "image",
      src: replaced,
    });
  });

  it("marks its image so the page-wide transform fallback leaves it to the component", () => {
    const html = renderToString(<TrackArtwork src={transformed} />);

    expect(html).toContain(`${MANAGED_FALLBACK_ATTRIBUTE}=""`);
  });
});
