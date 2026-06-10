import { cn } from "@/lib/utils";

// 3.25rem album artwork with the eclipse-gradient fallback (DESIGN.md track row).
export function TrackArtwork({ className, src }: { className?: string; src?: string }) {
  return src ? (
    <img alt="" className={cn("track-artwork", className)} loading="lazy" src={src} />
  ) : (
    <span aria-hidden="true" className={cn("track-artwork track-artwork-fallback", className)} />
  );
}
