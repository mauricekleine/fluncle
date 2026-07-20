// `/fresh` — the shared render primitives every variant leans on.
//
// The register rules live HERE, once, so no variant can break them: a lit finding leads with its
// cover and its Log ID coordinate and may heat to gold; an unlit catalogue row stays coverless,
// dust-inked, and sends you out to Spotify (DESIGN.md's Unlit Rule). A variant owns the LAYOUT
// around these; it never re-decides what a finding or a catalogue row is allowed to look like.
//
// A note on dates: this is the ONE surface whose dates are RELEASE dates, not Found dates. So the
// stamp reads "Out Jul 3", never "Found" (VOICE.md's Found Rule; lib/server/fresh.ts).

import { CaretRightIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { siSpotify } from "simple-icons";
import { ArtistAvatar } from "@/components/artist-avatar";
import { BrandIcon } from "@/components/brand-icon";
import { TrackArtwork } from "@/components/track-artwork";
import { tracksCount } from "@/lib/format";
import { albumCoverAtSize } from "@/lib/media";
import { cn } from "@/lib/utils";
import { type FreshCover, type FreshStreamEntry } from "./data";

/**
 * A lead-artist avatar sized for the slot it lands in, rather than for the DTO's og:image rung.
 * Every avatar on this page is a small round tile — 2.25–3rem — so the 300 rung covers even a 3rem
 * marquee avatar on a 2× screen with headroom, where the 640 the DTO hands out was up to 13× the
 * pixels the tile can show. An avatar that is not an owned cover master passes through untouched.
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
 * A compact list row for one release in the merged stream, with a leading date column so the
 * newest-first sort reads down the page. A finding carries its cover thumb and its Log ID (and the
 * row link opens its log page); a catalogue row stays unlit — no cover, no coordinate, dust ink,
 * out to Spotify (the Unlit Rule). `showDate` drops the column where a group header already owns it.
 */
export function FreshStreamRow({
  entry,
  showDate = true,
}: {
  entry: FreshStreamEntry;
  showDate?: boolean;
}) {
  const dateCell = showDate ? (
    <time className="fresh-row-date" dateTime={entry.releaseDate}>
      {freshDate(entry.releaseDate)}
    </time>
  ) : undefined;

  if (entry.kind === "finding") {
    const finding = entry.finding;
    const line = `${finding.artists.join(", ")} — ${finding.title}`;

    return (
      <li className="fresh-row fresh-row-lit">
        {dateCell}
        <ArtistAvatar
          className="fresh-row-avatar"
          name={finding.artists[0] ?? finding.title}
          src={freshAvatarSrc(finding.artistAvatarUrl)}
        />
        {finding.logId ? (
          <Link
            aria-label={`Open the log page for ${line}`}
            className="fresh-row-main"
            params={{ logId: finding.logId }}
            to="/log/$logId"
          >
            <span className="fresh-row-coordinate">{finding.logId}</span>
            <span className="fresh-row-title">{line}</span>
          </Link>
        ) : (
          <a
            aria-label={`Listen to ${line} on Spotify`}
            className="fresh-row-main"
            href={finding.spotifyUrl}
            rel="noreferrer"
            target="_blank"
          >
            <span className="fresh-row-title">{line}</span>
          </a>
        )}
        <CaretRightIcon aria-hidden="true" className="fresh-row-caret" size={16} weight="bold" />
      </li>
    );
  }

  const track = entry.track;
  const line = `${track.artists.join(", ")} — ${track.title}`;

  return (
    <li className="fresh-row fresh-row-unlit">
      {dateCell}
      {/* A DIMMED lead-artist avatar — identifies who without lighting the row up (the same 0.66
          dimming the catalogue grid uses on artist avatars). No album cover: the Unlit Rule holds. */}
      <ArtistAvatar
        className="fresh-row-avatar fresh-row-avatar-unlit"
        name={track.artists[0] ?? track.title}
        src={freshAvatarSrc(track.artistAvatarUrl)}
      />
      {track.spotifyUrl ? (
        <a
          aria-label={`${line} on Spotify`}
          className="fresh-row-main"
          href={track.spotifyUrl}
          rel="noreferrer"
          target="_blank"
        >
          <span className="fresh-row-title">{line}</span>
          <BrandIcon className="fresh-row-mark" icon={siSpotify} />
        </a>
      ) : (
        <span className="fresh-row-main fresh-row-plain">
          <span className="fresh-row-title">{line}</span>
        </span>
      )}
    </li>
  );
}
