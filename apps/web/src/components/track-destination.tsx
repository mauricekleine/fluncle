import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { useMemo } from "react";
import { siApplemusic, siBeatport, siDeezer, siSpotify, siYoutube } from "simple-icons";
import { type SimpleIcon } from "simple-icons";
import { Button, buttonVariants } from "@fluncle/ui/components/button";
import { BrandIcon } from "@/components/brand-icon";
import { DiscoveryList } from "@/components/discovery-row";
import { GraphLink } from "@/components/graph-link";
import { formatDuration, formatReleaseDate } from "@/lib/format";
import { formatKey, useKeyNotation } from "@/lib/key-notation";
import { toQueueTrack } from "@/lib/player-tracks";
import { usePreviewPlayer } from "@/lib/preview-player";
import { sonicNeighbourToDiscoveryTrack } from "@/lib/discovery-tracks";
import { cn } from "@/lib/utils";
import {
  type ListenDestination,
  type SonicNeighbour,
  type TrackDestination,
} from "@/lib/server/track-page";

const LISTEN_META: Record<ListenDestination["kind"], { icon: SimpleIcon; label: string }> = {
  apple: { icon: siApplemusic, label: "Listen on Apple Music" },

  beatport: { icon: siBeatport, label: "Buy on Beatport" },
  deezer: { icon: siDeezer, label: "Listen on Deezer" },
  spotify: { icon: siSpotify, label: "Listen on Spotify" },
  youtube: { icon: siYoutube, label: "Watch on YouTube" },
};

function TrackPreviewButton({ track }: { track: TrackDestination }) {
  const queued = useMemo(
    () =>
      toQueueTrack({
        albumImageUrl: track.albumImageUrl,
        artists: track.artists.map((artist) => artist.name),
        spotifyUrl: track.listen.find((destination) => destination.kind === "spotify")?.href,
        title: track.title,
        trackId: track.trackId,
      }),
    [track.albumImageUrl, track.artists, track.listen, track.title, track.trackId],
  );
  const preview = usePreviewPlayer(track.trackId, { publicPreview: true, track: queued });

  return (
    <Button aria-pressed={preview.isActive} onClick={preview.toggle} size="lg" variant="outline">
      {preview.isActive ? (
        <PauseIcon aria-hidden="true" weight="fill" />
      ) : (
        <PlayIcon aria-hidden="true" weight="fill" />
      )}
      {preview.isActive ? "Pause the preview" : "Play the preview"}
    </Button>
  );
}

export function TrackListenBand({ track }: { track: TrackDestination }) {
  if (!track.previewable && track.listen.length === 0) {
    return undefined;
  }

  return (
    <div className="log-actions">
      {track.previewable ? <TrackPreviewButton track={track} /> : undefined}
      {track.listen.map((destination) => {
        const meta = LISTEN_META[destination.kind];

        return (
          <a
            className={cn(buttonVariants({ size: "lg", variant: "outline" }))}
            href={destination.href}
            key={destination.kind}
            rel="noreferrer"
            target="_blank"
          >
            <BrandIcon icon={meta.icon} />
            {meta.label}
          </a>
        );
      })}
    </div>
  );
}

export function TrackFacts({ track }: { track: TrackDestination }) {
  const { notation } = useKeyNotation();
  const releaseLabel = track.releaseDate ? formatReleaseDate(track.releaseDate) : undefined;

  return (
    <dl className="log-fields">
      {releaseLabel ? (
        <div className="log-field">
          <dt>Released</dt>
          <dd>
            <time dateTime={track.releaseDate}>{releaseLabel}</time>
          </dd>
        </div>
      ) : undefined}

      {track.durationMs ? (
        <div className="log-field">
          <dt>Length</dt>
          <dd>{formatDuration(track.durationMs)}</dd>
        </div>
      ) : undefined}
      {track.bpm ? (
        <div className="log-field">
          <dt>BPM</dt>
          <dd>{Math.round(track.bpm)}</dd>
        </div>
      ) : undefined}
      {track.key ? (
        <div className="log-field">
          <dt>Key</dt>
          <dd>{formatKey(track.key, notation)}</dd>
        </div>
      ) : undefined}
      {track.album ? (
        <div className="log-field">
          <dt>Album</dt>
          <dd>
            {track.album.slug ? (
              <GraphLink kind="album" slug={track.album.slug}>
                {track.album.name}
              </GraphLink>
            ) : (
              track.album.name
            )}
          </dd>
        </div>
      ) : undefined}
      {track.label ? (
        <div className="log-field">
          <dt>Label</dt>
          <dd>
            {track.label.slug ? (
              <GraphLink kind="label" slug={track.label.slug}>
                {track.label.name}
              </GraphLink>
            ) : (
              track.label.name
            )}
          </dd>
        </div>
      ) : undefined}
      {track.isrc ? (
        <div className="log-field">
          <dt>ISRC</dt>
          <dd>{track.isrc}</dd>
        </div>
      ) : undefined}
    </dl>
  );
}

export function TrackArtistCredits({ track }: { track: TrackDestination }) {
  return (
    <p className="graph-uplink">
      {track.artists.map((artist, index) => (
        <span key={`${artist.name}-${index}`}>
          {index > 0 ? ", " : undefined}
          {artist.slug ? (
            <GraphLink kind="artist" slug={artist.slug}>
              {artist.name}
            </GraphLink>
          ) : (
            artist.name
          )}
        </span>
      ))}
    </p>
  );
}

export function SonicNeighbours({ neighbours }: { neighbours: SonicNeighbour[] }) {
  const tracks = useMemo(() => neighbours.map(sonicNeighbourToDiscoveryTrack), [neighbours]);

  if (neighbours.length === 0) {
    return undefined;
  }

  return (
    <div data-discovery="similar">
      <DiscoveryList className="track-neighbours" tracks={tracks} />
    </div>
  );
}
