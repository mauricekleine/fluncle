import { Link } from "@tanstack/react-router";
import { DiscoveryRow } from "@/components/discovery-row";
import { TrackArtwork } from "@/components/track-artwork";
import { freshEntryToDiscoveryTrack } from "@/lib/discovery-tracks";
import { formatReleaseDate, tracksCount } from "@/lib/format";
import { albumCoverAtSize } from "@/lib/media";
import { cn } from "@/lib/utils";
import { type FreshCover, type FreshStreamEntry } from "./data";

export function freshAvatarSrc(src: string | undefined): string | undefined {
  return albumCoverAtSize(src, "medium");
}

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  weekday: "short",
});

export function freshDateParts(date: string): { day: string; month: string; weekday: string } {
  const parts = partsFormatter.formatToParts(new Date(date));
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return { day: pick("day"), month: pick("month"), weekday: pick("weekday") };
}

export function freshDate(date: string): string {
  const { day, month } = freshDateParts(date);
  return `${month} ${day}`;
}

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

export function FreshReleaseRows({
  className,
  entries,
  heading: Heading = "h3",
}: {
  className?: string;
  entries: FreshStreamEntry[];

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
