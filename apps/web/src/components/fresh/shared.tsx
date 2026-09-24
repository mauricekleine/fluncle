// `/fresh` — the shared render primitives every variant leans on.
//
// The register rules live in the shared discovery row (`components/discovery-row.tsx`), once, so no
// variant can break them: a lit finding shows its cover in full colour with its Log ID coordinate
// and may heat to gold; a catalogue row shows its real cover desaturated and dimmed, carries no
// coordinate, and never catches gold (DESIGN.md's Unlit Rule). A variant owns the LAYOUT around
// these; it never re-decides what a finding or a catalogue row is allowed to look like.
//
// A note on dates: this is the ONE surface whose dates are RELEASE dates, not Found dates. So the
// stamp reads "Out Jul 3", never "Found" (VOICE.md's Found Rule; lib/server/fresh.ts).

import { Link } from "@tanstack/react-router";
import { DiscoveryRow } from "@/components/discovery-row";
import { TrackArtwork } from "@/components/track-artwork";
import { freshEntryToDiscoveryTrack } from "@/lib/discovery-tracks";
import { formatReleaseDate, tracksCount } from "@/lib/format";
import { albumCoverAtSize } from "@/lib/media";
import { cn } from "@/lib/utils";
import { type FreshCover, type FreshStreamEntry } from "./data";

/**
 * A lead-artist avatar sized for the slot it lands in, rather than for the DTO's og:image rung.
 * Every avatar on this page is a small round tile — 2.25–3rem — so the 300 rung covers even a 3rem
 * marquee avatar on a 2× screen with headroom, where the 640 the DTO hands out was up to 13× the
 * pixels the tile can show. An avatar with no owned cover master lands on Spotify's own 320 rung —
 * the nearest thing the portrait ladder publishes to this one.
 */
export function freshAvatarSrc(src: string | undefined): string | undefined {
  return albumCoverAtSize(src, "medium");
}

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  weekday: "short",
});

/** A release date broken into its display pieces (UTC, the column's own precision). */
export function freshDateParts(date: string): { day: string; month: string; weekday: string } {
  const parts = partsFormatter.formatToParts(new Date(date));
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return { day: pick("day"), month: pick("month"), weekday: pick("weekday") };
}

/** "Jul 3" — the compact release stamp used inline. */
export function freshDate(date: string): string {
  const { day, month } = freshDateParts(date);
  return `${month} ${day}`;
}

/** The cover artwork for a cover card, at a variant-controlled size (via className). */
export function FreshCoverArt({
  alt,
  className,
  src,
}: {
  alt: string;
  className?: string;
  src: string | undefined;
}) {
  return <TrackArtwork alt={alt} className={cn("fresh-cover-art", className)} src={src} />;
}

/**
 * A cover card — a cover-bearing release (a finding or an album record) rendered cover-first. The
 * whole card is one link to where the release lives: a finding's log page (its coordinate), or its
 * Spotify when it has no coordinate yet, or the album's `/album/<slug>` page. The date rides a
 * trailing "Out Jul 3" stamp. `showDate` hides the stamp where the layout carries the date elsewhere
 * (the timeline spine); `showTrackCount` adds a "4 tracks" line on an album record (the album view's
 * central grid, where the count tells an EP from an LP — a real count of a real entity).
 */
export function FreshCoverCard({
  cover,
  className,
  showDate = true,
  showTrackCount = false,
}: {
  className?: string;
  cover: FreshCover;
  showDate?: boolean;
  showTrackCount?: boolean;
}) {
  const inner = (
    <>
      <FreshCoverArt alt={`${cover.title} cover art`} src={cover.coverUrl} />
      <span className="fresh-cover-body">
        <span className="fresh-cover-title">{cover.title}</span>
        {cover.link === "album" && cover.artists.length > 0 ? (
          <span className="fresh-cover-sub">{cover.artists.join(", ")}</span>
        ) : undefined}
        {showDate ? (
          <span className="fresh-cover-date">
            Out <time dateTime={cover.releaseDate}>{freshDate(cover.releaseDate)}</time>
            {showTrackCount && cover.link === "album" && cover.trackCount !== undefined ? (
              <span className="fresh-cover-count"> · {tracksCount(cover.trackCount)}</span>
            ) : undefined}
          </span>
        ) : undefined}
      </span>
    </>
  );

  const classes = cn("fresh-cover-card", className);

  if (cover.link === "log") {
    return (
      <Link
        aria-label={`Open the log page for ${cover.title}`}
        className={classes}
        params={{ logId: cover.logId }}
        to="/log/$logId"
      >
        {inner}
      </Link>
    );
  }

  if (cover.link === "album") {
    return (
      <Link
        aria-label={`Open ${cover.title}`}
        className={classes}
        params={{ slug: cover.slug }}
        to="/album/$slug"
      >
        {inner}
      </Link>
    );
  }

  return (
    <a
      aria-label={`Listen to ${cover.title} on Spotify`}
      className={classes}
      href={cover.href}
      rel="noreferrer"
      target="_blank"
    >
      {inner}
    </a>
  );
}

/**
 * The compact release rows under their DAY: `/fresh` and the front door's release band list their
 * tracks as discovery rows (`components/discovery-row.tsx`: the cover plays, the rest opens the
 * track, no date column), grouped under one header per release day. The day is the one date that
 * matters here, so it heads its group once, in the archive's one release-date form
 * (`formatReleaseDate`), instead of repeating down a column.
 *
 * Renders rows only: the caller owns the queue boundary (`DiscoveryPlayableList`), because on
 * `/fresh` the headlines above and these rows are one list to the player.
 */
export function FreshReleaseRows({
  className,
  entries,
  heading: Heading = "h3",
}: {
  className?: string;
  entries: FreshStreamEntry[];
  /** The header level that fits the host page's outline. */
  heading?: "h2" | "h3";
}) {
  const days: { date: string; entries: FreshStreamEntry[] }[] = [];

  for (const entry of entries) {
    const date = entry.releaseDate.slice(0, 10);
    const current = days.at(-1);

    if (current && current.date === date) {
      current.entries.push(entry);
    } else {
      days.push({ date, entries: [entry] });
    }
  }

  return (
    <div className={cn("fresh-days", className)}>
      {days.map((day) => (
        <section className="fresh-day" key={day.date}>
          <Heading className="fresh-day-heading">
            <time dateTime={day.date}>{formatReleaseDate(day.date)}</time>
          </Heading>
          <ol className="discovery-list">
            {day.entries.map((entry) => (
              <DiscoveryRow
                key={entry.kind === "finding" ? entry.finding.trackId : entry.track.trackId}
                track={freshEntryToDiscoveryTrack(entry)}
              />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
