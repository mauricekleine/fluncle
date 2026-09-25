import {
  CaretRightIcon,
  DotsThreeIcon,
  FilmStripIcon,
  ShareNetworkIcon,
  WaveformIcon,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useCallback } from "react";
import { siMixcloud, siSoundcloud, siSpotify, siTiktok, siYoutube } from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";
import { PlayCover } from "@/components/player/playable-list";
import { GraphLink } from "@/components/graph-link";
import { TrackArtwork } from "@/components/track-artwork";
import { Badge } from "@fluncle/ui/components/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@fluncle/ui/components/dropdown-menu";
import { discoveryQueueTrack, findingToDiscoveryTrack } from "@/lib/discovery-tracks";
import { siteUrl } from "@/lib/fluncle-links";
import { bangersCount, formatAlbumDuration, formatDuration } from "@/lib/format";
import { albumCoverAtSize } from "@/lib/media";
import { type FeedItem, mixtapeCoverUrl, mixtapeDisplayTitle } from "@/lib/mixtapes";
import { similarSearchHref } from "@/lib/player-tracks";
import { type QueueTrack } from "@/lib/preview-player";
import { type Track } from "@/lib/tracks";
import { cn } from "@/lib/utils";

export function TrackRow({ track, trackNumber }: { track: FeedItem; trackNumber: number }) {
  if (track.type === "mixtape") {
    const logId = track.logId as string;
    const bangersLabel = bangersCount(track.memberCount);

    return (
      <li className="track-row track-row-checkpoint">
        <Link
          aria-label={`Open the log page for ${track.title}`}
          className="track-log-id track-log-id-link"
          params={{ logId }}
          to="/log/$logId"
        >
          {logId}
        </Link>

        <TrackArtwork
          alt={`${track.title} cover art`}
          src={logId ? mixtapeCoverUrl(logId, "thumb") : track.coverImageUrl}
        />
        <span className="min-w-0">
          <Link
            aria-label={`Open the log page for ${track.title}`}
            className="track-row-link"
            params={{ logId }}
            to="/log/$logId"
          >
            <span className="track-title block text-pretty [overflow-wrap:anywhere]">
              {mixtapeDisplayTitle(track.title)}
            </span>
          </Link>
          <span className="track-label mt-1 block truncate">{bangersLabel}</span>

          {track.durationMs ? (
            <span className="mt-1.5 flex flex-wrap items-center gap-1">
              <Badge className="track-chip track-chip-numeric" variant="outline">
                {formatAlbumDuration(track.durationMs)}
              </Badge>
            </span>
          ) : null}
        </span>
        <span className="track-actions">
          <MixtapeLinksMenu track={track} />
          <CaretRightIcon aria-hidden="true" className="track-caret" size={18} weight="bold" />
        </span>
      </li>
    );
  }

  const storyLogId = track.videoUrl ? track.logId : undefined;

  const trackLine = `${track.artists.join(", ")} — ${track.title}`;
  const releaseYear = track.releaseDate?.slice(0, 4);
  const playable = findingToDiscoveryTrack(track);
  const artwork = (
    <TrackArtwork
      alt={`${trackLine} cover art`}
      src={albumCoverAtSize(track.albumImageUrl, "small")}
    />
  );

  return (
    <li className="track-row">
      {track.logId ? (
        <Link
          aria-label={`Open the log page for ${trackLine}`}
          className="track-log-id track-log-id-link"
          params={{ logId: track.logId }}
          to="/log/$logId"
        >
          {track.logId}
        </Link>
      ) : (
        <span className="track-log-id">{`#${trackNumber.toString().padStart(2, "0")}`}</span>
      )}

      {playable.previewable ? (
        <PlayCover lit track={discoveryQueueTrack(playable)}>
          {artwork}
        </PlayCover>
      ) : (
        artwork
      )}

      <span className="min-w-0">
        {track.logId ? (
          <Link
            aria-label={`Open the log page for ${trackLine}`}
            className="track-row-link"
            params={{ logId: track.logId }}
            to="/log/$logId"
          >
            <span className="track-title block text-pretty [overflow-wrap:anywhere]">
              {trackLine}
            </span>
          </Link>
        ) : (
          <a
            aria-label={`Listen to ${trackLine} on Spotify`}
            className="track-row-link"
            href={track.spotifyUrl}
            rel="noreferrer"
            target="_blank"
          >
            <span className="track-title block text-pretty [overflow-wrap:anywhere]">
              {trackLine}
            </span>
          </a>
        )}

        {track.label ? (
          <span className="track-label block truncate">
            {track.labelSlug ? (
              <GraphLink kind="label" slug={track.labelSlug}>
                {track.label}
              </GraphLink>
            ) : (
              track.label
            )}
            {releaseYear ? ` (${releaseYear})` : ""}
          </span>
        ) : null}
        <TrackChips bpm={track.bpm} durationMs={track.durationMs} musicalKey={track.key} />
      </span>

      <span className="track-actions">
        <TrackLinksMenu
          queued={discoveryQueueTrack(playable)}
          storyLogId={storyLogId}
          track={track}
          trackLine={trackLine}
        />
        <CaretRightIcon aria-hidden="true" className="track-caret" size={18} weight="bold" />
      </span>
    </li>
  );
}

function MixtapeLinksMenu({ track }: { track: Extract<FeedItem, { type: "mixtape" }> }) {
  const shareUrl = track.logId ? `${siteUrl}/log/${track.logId}` : siteUrl;
  const externalLinks = [
    track.externalUrls.mixcloud
      ? { href: track.externalUrls.mixcloud, icon: siMixcloud, label: "Mixcloud" }
      : null,
    track.externalUrls.youtube
      ? { href: track.externalUrls.youtube, icon: siYoutube, label: "YouTube" }
      : null,
    track.externalUrls.soundcloud
      ? { href: track.externalUrls.soundcloud, icon: siSoundcloud, label: "SoundCloud" }
      : null,
  ].filter((link): link is { href: string; icon: typeof siMixcloud; label: string } =>
    Boolean(link),
  );

  const share = useCallback(() => {
    if (typeof navigator === "undefined") {
      return;
    }

    if (navigator.share) {
      void navigator.share({ title: track.title, url: shareUrl }).catch(() => {});
    } else {
      void navigator.clipboard?.writeText(shareUrl);
    }
  }, [shareUrl, track.title]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Links for ${track.title}`}
        className="track-action track-action--menu"
      >
        <DotsThreeIcon aria-hidden="true" size={18} weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        {externalLinks.map((link) => (
          <DropdownMenuItem
            key={link.label}
            render={<a aria-label={link.label} href={link.href} rel="noreferrer" target="_blank" />}
          >
            <BrandIcon className="size-4" icon={link.icon} />
            {link.label}
          </DropdownMenuItem>
        ))}
        {externalLinks.length > 0 ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem onClick={share}>
          <ShareNetworkIcon aria-hidden="true" className="size-4" />
          Share
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TrackLinksMenu({
  queued,
  storyLogId,
  track,
  trackLine,
}: {
  queued: QueueTrack;
  storyLogId?: string;
  track: Track;
  trackLine: string;
}) {
  const shareUrl = track.logId ? `${siteUrl}/log/${track.logId}` : track.spotifyUrl;

  const share = useCallback(() => {
    if (typeof navigator === "undefined") {
      return;
    }

    if (navigator.share) {
      void navigator.share({ title: trackLine, url: shareUrl }).catch(() => {});
    } else {
      void navigator.clipboard?.writeText(shareUrl);
    }
  }, [shareUrl, trackLine]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Actions for ${trackLine}`}
        className="track-action track-action--menu"
      >
        <DotsThreeIcon aria-hidden="true" size={18} weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44 shadow-none">
        {storyLogId ? (
          <DropdownMenuItem
            render={
              <Link
                mask={{ params: { logId: storyLogId }, to: "/log/$logId", unmaskOnReload: true }}
                search={{ story: storyLogId }}
                to="/findings"
              />
            }
          >
            <FilmStripIcon aria-hidden="true" className="size-4" />
            Watch the story
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          render={
            <a
              aria-label="Listen on Spotify"
              href={track.spotifyUrl}
              rel="noreferrer"
              target="_blank"
            />
          }
        >
          <BrandIcon className="size-4" icon={siSpotify} />
          Listen on Spotify
        </DropdownMenuItem>
        {track.tiktokUrl ? (
          <DropdownMenuItem
            render={
              <a aria-label="TikTok" href={track.tiktokUrl} rel="noreferrer" target="_blank" />
            }
          >
            <BrandIcon className="size-4" icon={siTiktok} />
            TikTok
          </DropdownMenuItem>
        ) : null}
        {track.youtubeUrl ? (
          <DropdownMenuItem
            render={
              <a aria-label="YouTube" href={track.youtubeUrl} rel="noreferrer" target="_blank" />
            }
          >
            <BrandIcon className="size-4" icon={siYoutube} />
            YouTube
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          render={<Link data-discovery="similar" to={similarSearchHref(queued) as never} />}
        >
          <WaveformIcon aria-hidden="true" className="size-4" />
          Similar tracks
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={share}>
          <ShareNetworkIcon aria-hidden="true" className="size-4" />
          Share
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TrackChips({
  bpm,
  className,
  durationMs,
  musicalKey,
}: {
  bpm?: number;
  className?: string;
  durationMs?: number;
  musicalKey?: string;
}) {
  if (!durationMs && !bpm && !musicalKey) {
    return null;
  }

  return (
    <span className={cn("mt-1.5 flex flex-wrap items-center gap-1", className)}>
      {durationMs ? (
        <Badge className="track-chip track-chip-numeric" variant="outline">
          {formatDuration(durationMs)}
        </Badge>
      ) : null}
      {bpm ? (
        <Badge className="track-chip track-chip-numeric" variant="outline">
          {Math.round(bpm)} BPM
        </Badge>
      ) : null}
      {musicalKey ? (
        <Badge className="track-chip track-chip-numeric" variant="outline">
          {musicalKey}
        </Badge>
      ) : null}
    </span>
  );
}
