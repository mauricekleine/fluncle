import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { ArtistAvatar } from "@/components/artist-avatar";
import { DiscoveryList, DiscoveryPlayableList } from "@/components/discovery-row";
import { GraphLink } from "@/components/graph-link";
import { PlayCover } from "@/components/player/playable-list";
import { TrackArtwork } from "@/components/track-artwork";
import {
  catalogueTrackToDiscoveryTrack,
  discoveryQueueTrack,
  findingToDiscoveryTrack,
} from "@/lib/discovery-tracks";
import { artistTitleLine } from "@/lib/log-prose";
import { hasTrackPageIdentity } from "@/lib/track-page";
import { albumCoverAtSize } from "@/lib/media";
import { type GraphPageTrack } from "@/lib/log-schema";
import { type ArtistChip } from "@/lib/server/artists";
import { type CatalogueTrackItem, type TrackListItem } from "@/lib/server/tracks";

export function graphPageTracks(
  findings: TrackListItem[],
  catalogue: CatalogueTrackItem[],
): GraphPageTrack[] {
  return [
    ...findings.flatMap((finding) =>
      finding.logId
        ? [
            {
              artists: finding.artists,

              durationMs: finding.durationMs,
              isrc: finding.isrc,
              logId: finding.logId,
              releaseDate: finding.releaseDate,
              title: finding.title,
            },
          ]
        : [],
    ),
    ...catalogue.map((track) => ({
      artists: track.artists,
      spotifyUrl: track.spotifyUrl,
      title: track.title,

      trackId: hasTrackPageIdentity(track) ? track.trackId : undefined,
    })),
  ];
}

export function FindingsGridList({
  className,
  coverClassName = "artist-grid-cover",
  findings,
  label,
  labelledBy,
  lineClassName = "artist-grid-line",
  priorityFirst = true,
  size,
}: {
  className: string;
  coverClassName?: string;
  findings: TrackListItem[];
  label?: string;
  labelledBy?: string;
  lineClassName?: string;
  priorityFirst?: boolean;
  size: TileSize;
}) {
  const tiles = useMemo(
    () =>
      findings
        .filter((finding) => finding.logId)
        .map((finding) => findingToDiscoveryTrack(finding)),
    [findings],
  );

  return (
    <DiscoveryPlayableList tracks={tiles}>
      <ul aria-label={label} aria-labelledby={labelledBy} className={className}>
        {findings.map((finding, index) =>
          finding.logId ? (
            <FindingGridTile
              coverClassName={coverClassName}
              finding={finding}
              key={finding.trackId}
              lineClassName={lineClassName}
              logId={finding.logId}
              priority={priorityFirst && index === 0}
              size={size}
            />
          ) : null,
        )}
      </ul>
    </DiscoveryPlayableList>
  );
}

type TileSize = "large" | "medium" | "small";

function FindingGridTile({
  coverClassName,
  finding,
  lineClassName,
  logId,
  priority,
  size,
}: {
  coverClassName: string;
  finding: TrackListItem;
  lineClassName: string;
  logId: string;
  priority: boolean;
  size: TileSize;
}) {
  const track = findingToDiscoveryTrack(finding);
  const cover = (
    <TrackArtwork
      alt=""
      className={coverClassName}
      priority={priority}
      src={albumCoverAtSize(finding.albumImageUrl, size)}
    />
  );

  return (
    <li className="finding-grid-tile">
      {track.previewable ? (
        <PlayCover className="finding-grid-play" lit track={discoveryQueueTrack(track)}>
          {cover}
        </PlayCover>
      ) : (
        <Link aria-hidden="true" params={{ logId }} tabIndex={-1} to="/log/$logId">
          {cover}
        </Link>
      )}
      <Link params={{ logId }} to="/log/$logId">
        <span className={lineClassName}>{artistTitleLine(finding)}</span>
      </Link>
    </li>
  );
}

const FINDINGS_HEADING = "Recommended by Fluncle";

export function FindingsGrid({ findings, label }: { findings: TrackListItem[]; label?: string }) {
  const grid = findings.filter((finding) => finding.logId);

  if (grid.length === 0) {
    return undefined;
  }

  return (
    <section className="artist-findings">
      {label === undefined ? (
        <h2 className="artist-similar-label" id="findings-grid-heading">
          {FINDINGS_HEADING}
        </h2>
      ) : undefined}

      <FindingsGridList
        className="artist-grid"
        findings={grid}
        label={label}
        labelledBy={label === undefined ? "findings-grid-heading" : undefined}
        priorityFirst={label === undefined}
        size="medium"
      />
    </section>
  );
}

export function ArtistChips({ artists, title }: { artists: ArtistChip[]; title: string }) {
  if (artists.length === 0) {
    return undefined;
  }

  return (
    <nav aria-label={title} className="artist-similar">
      <h2 className="artist-similar-label">{title}</h2>
      <ul className="artist-similar-list">
        {artists.map((artist) => (
          <li key={artist.slug}>
            <GraphLink
              className="artist-similar-link"
              kind="artist"
              slug={artist.slug}
              variant="chip"
            >
              <ArtistAvatar
                className="artist-similar-avatar"
                name={artist.name}
                src={albumCoverAtSize(artist.imageUrl, "small")}
              />
              <span>{artist.name}</span>
            </GraphLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function UnlitTracks({ label, tracks }: { label: string; tracks: CatalogueTrackItem[] }) {
  const rows = useMemo(() => tracks.map(catalogueTrackToDiscoveryTrack), [tracks]);

  if (tracks.length === 0) {
    return undefined;
  }

  return <DiscoveryList className="unlit-tracks" label={label} tracks={rows} />;
}
