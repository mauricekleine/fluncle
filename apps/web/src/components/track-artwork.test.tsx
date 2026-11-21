import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MANAGED_FALLBACK_ATTRIBUTE } from "@/lib/image-transform-fallback";
import { labelLogoUrl } from "@/lib/media";
import { nextArtworkFailure, TrackArtwork } from "./track-artwork";

const transformed = labelLogoUrl("albums/drift.jpg", "2026-11-21T08:00:00.000Z", "medium") ?? "";

describe("TrackArtwork fallback chain", () => {
  it("retries a refused Cloudflare transform with its owned source before the eclipse", () => {
    const first = nextArtworkFailure(undefined, transformed);
    const second = nextArtworkFailure(first, transformed);

    expect(first.stage).toBe("source");
    expect(second.stage).toBe("eclipse");
  });

  it("goes straight to the eclipse for a source that is not a Cloudflare transform", () => {
    expect(nextArtworkFailure(undefined, "https://i.scdn.co/image/ab67616d0000b273abc").stage).toBe(
      "eclipse",
    );
  });

  it("restarts the chain when the requested source changes", () => {
    const exhausted = nextArtworkFailure(nextArtworkFailure(undefined, transformed), transformed);
    const replaced = transformed.replace("width=300", "width=640");

    expect(nextArtworkFailure(exhausted, replaced).stage).toBe("source");
  });

  it("marks its image so the page-wide transform fallback leaves it to the component", () => {
    const html = renderToString(<TrackArtwork src={transformed} />);

    expect(html).toContain(`${MANAGED_FALLBACK_ATTRIBUTE}=""`);
  });
});
