import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

export function TrackArtwork({
  alt,
  className,
  priority,
  src,
}: {
  alt?: string;
  className?: string;

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
