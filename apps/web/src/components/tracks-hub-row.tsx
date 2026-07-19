// The `/tracks` hub row — the two-register list row, its own component (NOT `/fresh`'s
// `FreshStreamRow`, which stays a cover-card variant). A reference-list row: dense, quiet, cover-led.
//
// Both registers lead with the ALBUM COVER through the shared `TrackArtwork` (cover-led canon). A
// LIT finding shows its real cover and links its title to `/log/<logId>`; an UNLIT catalogue row
// shows the eclipse fallback (TrackArtwork with no src), its title is plain text — it has no detail
// page and is never introduced as a tier (DESIGN.md's Unlit Rule; the split stays visual). Either
// way the artist credits link to `/artist/<slug>` and the imprint to `/label/<slug>` wherever the
// entity exists, so an uncertified row is still navigable BY ITS ENTITIES, never as a named track.

import { CaretRightIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { siSpotify } from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";
import { TrackArtwork } from "@/components/track-artwork";
import { albumCoverAtSize } from "@/lib/media";
import { type TracksHubArtistLink, type TracksHubEntry } from "@/lib/server/tracks-hub";

/** The release year the date column prints — the first four chars of an ISO release date, or a dash
    for an undated catalogue row (nothing to anchor the year lane to). */
function releaseYear(releaseDate: string): string {
  return releaseDate.slice(0, 4) || "—";
}

/** The artist credits as links: a resolved artist goes to `/artist/<slug>`, an unresolved one stays
    plain text (nowhere honest to send you). Commas between, the tracklist convention. */
function ArtistCredits({ artists }: { artists: TracksHubArtistLink[] }) {
  return (
    <>
      {artists.map((artist, index) => (
        <span key={`${artist.name}-${index}`}>
          {index > 0 ? ", " : null}
          {artist.slug ? (
            <Link
              className="tracks-hub-row-entity"
              params={{ slug: artist.slug }}
              to="/artist/$slug"
            >
              {artist.name}
            </Link>
          ) : (
            artist.name
          )}
        </span>
      ))}
    </>
  );
}

/** The imprint credit — a `/label/<slug>` link when the label has a page, plain text when it does
    not, and nothing at all when the track carries no label. Rides after the artists on the meta line. */
function LabelCredit({ label, slug }: { label?: string; slug?: string }) {
  if (!label) {
    return null;
  }

  return (
    <>
      {" · "}
      {slug ? (
        <Link className="tracks-hub-row-entity" params={{ slug }} to="/label/$slug">
          {label}
        </Link>
      ) : (
        label
      )}
    </>
  );
}

/** One row of the `/tracks` hub, in the register its entry declares. */
export function TracksHubRow({ entry }: { entry: TracksHubEntry }) {
  const year = releaseYear(entry.releaseDate);

  if (entry.kind === "finding") {
    const { finding } = entry;

    return (
      <li className="tracks-hub-row tracks-hub-row-lit">
        <span className="tracks-hub-row-year">{year}</span>
        <TrackArtwork
          alt=""
          className="tracks-hub-row-cover"
          src={albumCoverAtSize(finding.albumImageUrl, "medium")}
        />
        <div className="tracks-hub-row-body">
          {finding.logId ? (
            <Link
              aria-label={`Open the log page for ${finding.title}`}
              className="tracks-hub-row-title tracks-hub-row-title-link"
              params={{ logId: finding.logId }}
              to="/log/$logId"
            >
              {finding.title}
            </Link>
          ) : (
            <span className="tracks-hub-row-title">{finding.title}</span>
          )}
          <p className="tracks-hub-row-meta">
            <ArtistCredits artists={entry.artistLinks} />
            <LabelCredit label={finding.label} slug={finding.labelSlug} />
          </p>
        </div>
        {finding.logId ? (
          <CaretRightIcon
            aria-hidden="true"
            className="tracks-hub-row-caret"
            size={16}
            weight="bold"
          />
        ) : null}
      </li>
    );
  }

  const { track } = entry;

  return (
    <li className="tracks-hub-row tracks-hub-row-unlit">
      <span className="tracks-hub-row-year">{year}</span>
      {/* No cover on an unlit row — TrackArtwork's eclipse fallback stands in (the coverless dust
          row is half of what tells a catalogue row from a finding; the Unlit Rule holds). */}
      <TrackArtwork alt="" className="tracks-hub-row-cover" />
      <div className="tracks-hub-row-body">
        <span className="tracks-hub-row-title">{track.title}</span>
        <p className="tracks-hub-row-meta">
          <ArtistCredits artists={entry.artistLinks} />
          <LabelCredit label={entry.label} slug={entry.labelSlug} />
        </p>
      </div>
      {track.spotifyUrl ? (
        <a
          aria-label={`Listen to ${track.title} on Spotify`}
          className="tracks-hub-row-listen"
          href={track.spotifyUrl}
          rel="noreferrer"
          target="_blank"
        >
          <BrandIcon className="tracks-hub-row-mark" icon={siSpotify} />
        </a>
      ) : null}
    </li>
  );
}
