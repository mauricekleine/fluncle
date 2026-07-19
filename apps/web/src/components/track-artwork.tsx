import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

// 3.25rem album artwork with the eclipse-gradient fallback (DESIGN.md track row).
//
// The fallback covers BOTH absence and failure: a cover URL that errors (a third-party host down —
// the 2026-07-19 archive.org 503 wave put broken-image icons on public rows) degrades to the same
// eclipse gradient instead of the browser's broken glyph. Failure is tracked per URL so a later
// src change gets a fresh try, and the mount effect catches an image that already failed BEFORE
// hydration (the error event fires pre-hydration, so React's onError alone never sees it). The
// effect reads back `img.currentSrc`, which the browser absolutizes, so the comparison absolutizes
// the prop the same way.
export function TrackArtwork({
  alt,
  className,
  src,
}: {
  alt?: string;
  className?: string;
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
      loading="lazy"
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
