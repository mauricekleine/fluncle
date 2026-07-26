import { cn } from "@/lib/utils";

// The artist's canonical avatar — a round, cover-led owned/Spotify image, with a graceful
// monogram tile when none is stored yet (image_url null). Decorative: the alt is
// empty and the fallback is aria-hidden because the artist's name always sits
// adjacent (DESIGN.md — cover-led, quiet; the name carries the meaning). Used by the
// `/artists` index cards and the artist page's "similar artists" chips.
export function ArtistAvatar({
  className,
  name,
  priority,
  src,
}: {
  className?: string;
  name: string;
  /**
   * This avatar is the page's above-the-fold lead image (the entity masthead portrait) — fetch it
   * eagerly at high priority instead of lazily. Every other avatar on a page is a grid tile or a
   * chip and stays lazy: `fetchPriority="high"` only helps while it is scarce.
   */
  priority?: boolean;
  src?: string;
}) {
  if (src) {
    return (
      <img
        alt=""
        className={cn("artist-avatar", className)}
        decoding="async"
        fetchPriority={priority ? "high" : undefined}
        loading={priority ? "eager" : "lazy"}
        src={src}
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
