import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { TrackArtwork } from "@/components/track-artwork";
import { albumCoverAtSize } from "@/lib/media";
import { type SavedTrack, useSavedTracks } from "@/lib/saved-tracks";

export const DEVICE_SAVES_SHOWN = 5;

export function deviceSavesOverflow(count: number): string | undefined {
  const hidden = count - DEVICE_SAVES_SHOWN;

  if (hidden <= 0) {
    return undefined;
  }

  return hidden === 1
    ? "1 more track saved on this device. Join the crew to see all your saves in one place."
    : `${hidden} more tracks saved on this device. Join the crew to see all your saves in one place.`;
}

function DeviceSaveRow({ track }: { track: SavedTrack }): ReactNode {
  const credit = track.artists.join(", ");
  const body = (
    <>
      <span className="device-saves-title">{track.title}</span>
      {credit ? <span className="device-saves-credit">{credit}</span> : null}
    </>
  );

  return (
    <li className="device-saves-row" data-unlit={track.logId ? undefined : ""}>
      <TrackArtwork
        className="device-saves-cover"
        src={albumCoverAtSize(track.coverUrl, "small")}
      />
      {track.href ? (
        <Link className="device-saves-body track-row-link" to={track.href as never}>
          {body}
        </Link>
      ) : track.spotifyUrl ? (
        <a
          aria-label={`${credit ? `${track.title}, ${credit}` : track.title}, on Spotify (opens in a new tab)`}
          className="device-saves-body track-row-link"
          href={track.spotifyUrl}
          rel="noopener noreferrer"
          target="_blank"
        >
          {body}
        </a>
      ) : (
        <span className="device-saves-body">{body}</span>
      )}
    </li>
  );
}

export function DeviceSaves(): ReactNode {
  const saved = useSavedTracks();

  if (saved.length === 0) {
    return null;
  }

  const overflow = deviceSavesOverflow(saved.length);

  return (
    <section aria-labelledby="device-saves-heading" className="account-section device-saves">
      <h2 id="device-saves-heading">Saved on this device</h2>
      <p className="account-muted">
        You couldn&rsquo;t let these tracks go, so they&rsquo;re sitting on this device for now.
        Join the crew and they come with you wherever you sign in.
      </p>
      <ul className="device-saves-list">
        {saved.slice(0, DEVICE_SAVES_SHOWN).map((track) => (
          <DeviceSaveRow key={track.trackId} track={track} />
        ))}
      </ul>
      {overflow ? <p className="account-muted">{overflow}</p> : null}
    </section>
  );
}
