import { useEffect, useRef, useState } from "react";

import { imageTransformSource } from "@/lib/image-transform-fallback";
import { cn } from "@/lib/utils";

export type ArtworkFailure = { src: string; stage: "eclipse" | "source" };

export type ArtworkAttempt =
  | { kind: "eclipse" }
  | { kind: "image"; sizes?: string; src: string; srcSet?: string };

export function artworkFailure(src: string, failedUrl: string): ArtworkFailure {
  const ownedSource = imageTransformSource(src);

  return { src, stage: ownedSource && failedUrl !== ownedSource ? "source" : "eclipse" };
}

export function artworkAttempt(
  src: string,
  srcSet: string | undefined,
  sizes: string | undefined,
  failure: ArtworkFailure | undefined,
): ArtworkAttempt {
  const stage = failure?.src === src ? failure.stage : undefined;
  const ownedSource = imageTransformSource(src);

  if (stage === "eclipse" || (stage === "source" && !ownedSource)) {
    return { kind: "eclipse" };
  }

  return stage === "source" && ownedSource
    ? { kind: "image", src: ownedSource }
    : { kind: "image", sizes, src, srcSet };
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

  useEffect(() => {
    const img = imgRef.current;

    if (
      src !== undefined &&
      img &&
      img.complete &&
      img.naturalWidth === 0 &&
      (img.currentSrc || img.src)
    ) {
      setFailure(artworkFailure(src, src));
    }
  }, [src, srcSet]);

  const attempt =
    src === undefined
      ? ({ kind: "eclipse" } as const)
      : artworkAttempt(src, srcSet, sizes, failure);

  return src !== undefined && attempt.kind === "image" ? (
    <img
      alt={alt ?? ""}
      className={cn("track-artwork", className)}
      data-managed-fallback=""
      decoding="async"
      fetchPriority={priority ? "high" : undefined}
      loading={priority || eager ? "eager" : "lazy"}
      onError={() => setFailure(artworkFailure(src, attempt.src))}
      ref={imgRef}
      sizes={attempt.sizes}
      src={attempt.src}
      srcSet={attempt.srcSet}
    />
  ) : (
    <span aria-hidden="true" className={cn("track-artwork track-artwork-fallback", className)} />
  );
}
