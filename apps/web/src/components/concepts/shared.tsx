// The small set of primitives all three held discovery concepts share.
//
// Deliberately small. The concepts are meant to differ in product model,
// information architecture, and interaction, so anything that would smuggle one
// concept's structure into another — a row, a card, a list — is NOT here. What is
// shared is the stuff that must be identical for the comparison to be fair: the
// cover, the instrument readout, the coordinate, and the outbound destinations.
//
// Every register rule the concepts must not re-decide lives here once, on the
// precedent of `components/fresh/shared.tsx`: a certified row may heat to gold, a
// row Fluncle has not been to stays unlit and dust-inked, and both name the same
// action with the same words.

import { useEffect, useRef, useState } from "react";
import { siApplemusic, siSpotify, siYoutube } from "simple-icons";

import { Button } from "@fluncle/ui/components/button";
import { BrandIcon } from "@/components/brand-icon";
import {
  type ConceptTrack,
  formatBpm,
  formatDuration,
  listenDestinations,
  releaseYear,
} from "@/concepts/discovery/model";
import { cn } from "@/lib/utils";

const PLATFORM = {
  apple: { icon: siApplemusic, label: "Apple Music" },
  spotify: { icon: siSpotify, label: "Spotify" },
  youtube: { icon: siYoutube, label: "YouTube" },
} as const;

/**
 * Cover art with the eclipse-gradient fallback, at whatever size the concept
 * asks for. Same failure handling as the product's `TrackArtwork`: a third-party
 * host that is down degrades to the gradient rather than a broken-image glyph,
 * including when the error fired before hydration.
 */
export function Cover({
  alt,
  className,
  lit = false,
  priority,
  src,
}: {
  alt?: string;
  className?: string;
  /**
   * Whether the record is one Fluncle certified. It changes only the FALLBACK: a
   * missing cover on a certified record falls back to the eclipse, and on one he
   * has not been to falls back to the Dust Veil (DESIGN.md, The Unlit Rule).
   */
  lit?: boolean;
  priority?: boolean;
  src?: string;
}) {
  const ref = useRef<HTMLImageElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    const img = ref.current;

    if (img && img.complete && img.naturalWidth === 0 && img.src) {
      setFailed(true);
    }
  }, [src]);

  if (src === undefined || failed) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "block concept-cover-fallback",
          lit ? "concept-cover-fallback--lit" : undefined,
          className,
        )}
      />
    );
  }

  return (
    <img
      // Empty by default: the record's own name sits beside every cover in this
      // exhibit, so a described cover is the same sentence read twice. The
      // product's graph pages take the same position.
      alt={alt ?? ""}
      className={cn("block object-cover", className)}
      decoding="async"
      fetchPriority={priority ? "high" : undefined}
      loading={priority ? "eager" : "lazy"}
      onError={() => setFailed(true)}
      ref={ref}
      src={src}
    />
  );
}

/**
 * The instrument readout — duration, tempo, key, year — in the order a DJ reads a
 * record (DESIGN.md, The Readout Rule). A chip the capture cannot back is dropped
 * rather than filled: an honest gap, never a placeholder.
 */
export function Readout({ className, track }: { className?: string; track: ConceptTrack }) {
  const chips = [
    formatDuration(track.durationMs),
    formatBpm(track.bpm),
    track.key,
    releaseYear(track.releaseDate),
  ].filter((chip): chip is string => chip !== undefined);

  if (chips.length === 0) {
    return null;
  }

  return (
    <ul className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {chips.map((chip) => (
        <li
          className="rounded-sm border border-border/70 px-1.5 py-0.5 text-[0.7rem] text-muted-foreground tabular-nums"
          key={chip}
        >
          {chip}
        </li>
      ))}
    </ul>
  );
}

/**
 * Where the track can actually be heard. Every destination is a real URL the
 * capture carried; a track with none simply shows nothing, because a listening
 * link Fluncle does not hold is a link that would lie.
 *
 * The strings are the product's own, verbatim — one action, one label across
 * every surface (VOICE.md, The Chrome Rule; `/log` says the same thing).
 */
export function ListenRow({
  className,
  dense = false,
  size = "sm",
  tone = "primary",
  track,
}: {
  className?: string;
  /**
   * A row inside a LIST offers one way to listen. The alternates are rare, and a
   * list of rows each carrying three of them is a wall of controls over the
   * music (DESIGN.md, The Quiet Surface Rule). A surface given to one record
   * shows the whole set.
   */
  dense?: boolean;
  size?: "lg" | "sm";
  /**
   * `quiet` drops the gold fill AND the gold hover. A list of outbound controls
   * in gold would spend the whole One Sun budget on repetition, and a row
   * Fluncle has not certified takes no gold heat at all under any circumstances
   * (DESIGN.md, The One Sun Rule and The Unlit Rule).
   */
  tone?: "primary" | "quiet";
  track: ConceptTrack;
}) {
  const all = listenDestinations(track);
  const destinations = dense ? all.slice(0, 1) : all;

  if (destinations.length === 0) {
    return null;
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {destinations.map((destination, index) => {
        const platform = PLATFORM[destination.platform];
        const lead = index === 0 && tone === "primary";

        return (
          <Button
            className={
              tone === "quiet"
                ? "hover:border-[var(--dust-line)] hover:bg-[var(--dust-veil)] hover:text-[var(--starlight-cream)]"
                : undefined
            }
            key={destination.platform}
            nativeButton={false}
            // oxlint-disable-next-line jsx-a11y/anchor-has-content, jsx-a11y/control-has-associated-label -- Base UI's render prop merges the Button's children onto this anchor, so it ships with its label.
            render={<a href={destination.href} rel="noreferrer" target="_blank" />}
            size={size === "lg" ? "lg" : "sm"}
            variant={lead ? "default" : "outline"}
          >
            <BrandIcon icon={platform.icon} />
            Listen on {platform.label}
          </Button>
        );
      })}
    </div>
  );
}

/**
 * The coordinate. Muted at rest and heated by the row around it, exactly as the
 * product's own `.track-log-id` is: gold at rest turns a list of findings into a
 * field of suns and the page's real action stops leading (DESIGN.md, The One Sun
 * Rule). Its mere PRESENCE is the tier marker — an uncertified row has none.
 */
export function Coordinate({ className, track }: { className?: string; track: ConceptTrack }) {
  if (track.logId === undefined) {
    return null;
  }

  return (
    <span className={cn("concept-display text-[0.82rem] text-muted-foreground", className)}>
      {track.logId}
    </span>
  );
}
