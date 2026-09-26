import { cn } from "@/lib/utils";

export function ArtistAvatar({
  className,
  eager,
  name,
  priority,
  sizes,
  src,
  srcSet,
}: {
  className?: string;

  eager?: boolean;
  name: string;

  priority?: boolean;
  sizes?: string;
  src?: string;
  srcSet?: string;
}) {
  if (src) {
    return (
      <img
        alt=""
        className={cn("artist-avatar", className)}
        decoding="async"
        fetchPriority={priority ? "high" : undefined}
        loading={priority || eager ? "eager" : "lazy"}
        sizes={sizes}
        src={src}
        srcSet={srcSet}
      />
    );
  }

  const monogram = name.trim().charAt(0).toUpperCase() || "?";

  return (
    <span aria-hidden="true" className={cn("artist-avatar artist-avatar-fallback", className)}>
      {monogram}
    </span>
  );
}
