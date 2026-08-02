import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

// 3.25rem album artwork with the eclipse-gradient fallback (DESIGN.md track row).
//
// The fallback covers BOTH absence and failure: a cover URL that errors (a third-party host down —
// a failed third-party request degrades to the same
// eclipse gradient instead of the browser's broken glyph. Failure is tracked per URL so a later
// src change gets a fresh try, and the mount effect catches an image that already failed BEFORE
// hydration (the error event fires pre-hydration, so React's onError alone never sees it). The
// effect reads back `img.currentSrc`, which the browser absolutizes, so the comparison absolutizes
// the prop the same way.
export function TrackArtwork({
  alt,
  className,
  priority,
  src,
}: {
  alt?: string;
  className?: string;
  /**
   * This cover is the page's above-the-fold lead image (the first tile of the findings grid that
   * opens a graph page) — fetch it eagerly at high priority. A lazy image that happens to be in
   * the viewport still loads, but Chrome holds it at Low priority behind the render-blocking CSS
   * and defers it until layout, which is exactly the LCP an entity page waits on. Every other tile
   * stays lazy; the signal only helps while it is scarce.
   */
  priority?: boolean;
  src?: string;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [failedSrc, setFailedSrc] = useState<string>();

  useEffect(() => {
    const img = imgRef.current;

    if (img && img.complete && img.naturalWidth === 0 && img.src) {
      setFailedSrc(img.currentSrc || img.src);
    }
  }, [src]);

  const failed =
    src !== undefined &&
    failedSrc !== undefined &&
    (failedSrc === src || failedSrc === absolutized(src));

  return src !== undefined && !failed ? (
    <img
      alt={alt ?? ""}
      className={cn("track-artwork", className)}
      decoding="async"
      fetchPriority={priority ? "high" : undefined}
      loading={priority ? "eager" : "lazy"}
      onError={() => setFailedSrc(src)}
      ref={imgRef}
      src={src}
    />
  ) : (
    <span aria-hidden="true" className={cn("track-artwork track-artwork-fallback", className)} />
  );
}

function absolutized(src: string): string | undefined {
  try {
    return new URL(src, globalThis.location?.href).href;
  } catch {
    return undefined;
  }
}
