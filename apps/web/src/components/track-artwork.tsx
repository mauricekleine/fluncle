import { useEffect, useRef, useState } from "react";

import { imageTransformSource } from "@/lib/image-transform-fallback";
import { cn } from "@/lib/utils";

export type ArtworkFailure = { src: string; stage: "eclipse" | "source" };

export function nextArtworkFailure(
  previous: ArtworkFailure | undefined,
  src: string,
): ArtworkFailure {
  const sourceAlreadyTried = previous?.src === src && previous.stage === "source";

  return {
    src,
    stage: sourceAlreadyTried || !imageTransformSource(src) ? "eclipse" : "source",
  };
}

export function TrackArtwork({
  alt,
  className,
  eager,
  priority,
  sizes,
  src,
  srcSet,
}: {
  alt?: string;
  className?: string;
  eager?: boolean;

  priority?: boolean;
  sizes?: string;
  src?: string;
  srcSet?: string;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [failure, setFailure] = useState<ArtworkFailure>();

  const fail = () => {
    if (src !== undefined) {
      setFailure((previous) => nextArtworkFailure(previous, src));
    }
  };

  useEffect(() => {
    const img = imgRef.current;

    if (
      src !== undefined &&
      img &&
      img.complete &&
      img.naturalWidth === 0 &&
      (img.currentSrc || img.src)
    ) {
      setFailure((previous) => nextArtworkFailure(previous, src));
    }
  }, [src, srcSet]);

  const stage = src !== undefined && failure?.src === src ? failure.stage : undefined;
  const fallbackSource = stage === "source" ? imageTransformSource(src) : undefined;

  return src !== undefined && stage !== "eclipse" ? (
    <img
      alt={alt ?? ""}
      className={cn("track-artwork", className)}
      data-managed-fallback=""
      decoding="async"
      fetchPriority={priority ? "high" : undefined}
      loading={priority || eager ? "eager" : "lazy"}
      onError={fail}
      ref={imgRef}
      sizes={fallbackSource ? undefined : sizes}
      src={fallbackSource ?? src}
      srcSet={fallbackSource ? undefined : srcSet}
    />
  ) : (
    <span aria-hidden="true" className={cn("track-artwork track-artwork-fallback", className)} />
  );
}
