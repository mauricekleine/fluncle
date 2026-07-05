import { CaretRightIcon, DotsThreeIcon, PlayIcon, ShareNetworkIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useCallback } from "react";
import { siMixcloud, siSoundcloud, siSpotify, siTiktok, siYoutube } from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";
import { TrackArtwork } from "@/components/track-artwork";
import { Badge } from "@fluncle/ui/components/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@fluncle/ui/components/dropdown-menu";
import { siteUrl } from "@/lib/fluncle-links";
import { formatAlbumDuration, formatDuration } from "@/lib/format";
import { spotifyAlbumImageAtSize } from "@/lib/media";
import { type FeedItem, mixtapeCoverUrl, mixtapeDisplayTitle } from "@/lib/mixtapes";
import { type Track } from "@/lib/tracks";

// The signature component (DESIGN.md): a finding, not just a row. The whole row
// reads as one link to its log page (a stretched link); the artwork doubles as
// the story opener (the play affordance) when there's footage, and a single
// links menu sits beside the caret — siblings of the stretched link, above it.
export function TrackRow({ track, trackNumber }: { track: FeedItem; trackNumber: number }) {
  if (track.type === "mixtape") {
    const logId = track.logId as string;
    const bangersLabel = `${track.memberCount} ${track.memberCount === 1 ? "banger" : "bangers"}`;

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
        {/* The row slot is 52px (104px @2x): request the small `thumb` rendition,
            not the 1500² `square` that backs coverImageUrl (distribution artwork). */}
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
          {/* The run time as a badge — mirrors a finding's duration chip, so a
              checkpoint row stands the same height as the rows around it. */}
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

  // The artwork opens the story only when the finding has footage; otherwise the
  // cover is inert and the stretched row link carries the click to the log page.
  const storyLogId = track.videoUrl ? track.logId : undefined;
  // Artist — Title as the primary line (the em dash disambiguates titles that
  // carry their own " - ", e.g. remixes), matching the log index and the rest
  // of the surfaces. The record label, with the release year, reads beneath.
  const trackLine = `${track.artists.join(", ")} — ${track.title}`;
  const releaseYear = track.releaseDate?.slice(0, 4);
  const labelLine = track.label
    ? releaseYear
      ? `${track.label} (${releaseYear})`
      : track.label
    : undefined;

  return (
    <li className="track-row">
      {track.logId ? (
        // The coordinate links to its log page — the crawlable exact-match
        // anchor that keeps /log/<id> pages from being orphans.
        <Link
          aria-label={`Open the log page for ${trackLine}`}
          className="track-log-id track-log-id-link"
          params={{ logId: track.logId }}
          to="/log/$logId"
        >
          {track.logId}
        </Link>
      ) : (
        // No coordinate yet (the ISRC straggler case): a bare ordinal, no log
        // page to link until it's backfilled.
        <span className="track-log-id">{`#${trackNumber.toString().padStart(2, "0")}`}</span>
      )}

      {storyLogId ? (
        // The artwork IS the play affordance: it opens the story over the feed
        // (the mask shows — and crawlers see — the standalone /log/<id> URL).
        <Link
          aria-label={`Watch the story for ${trackLine}`}
          className="track-play"
          mask={{ params: { logId: storyLogId }, to: "/log/$logId", unmaskOnReload: true }}
          search={{ story: storyLogId }}
          to="/"
        >
          <TrackArtwork
            alt={`${trackLine} cover art`}
            src={spotifyAlbumImageAtSize(track.albumImageUrl, "small")}
          />
          <span aria-hidden="true" className="track-play-glyph">
            <PlayIcon weight="fill" />
          </span>
        </Link>
      ) : (
        <TrackArtwork
          alt={`${trackLine} cover art`}
          src={spotifyAlbumImageAtSize(track.albumImageUrl, "small")}
        />
      )}

      <span className="min-w-0">
        {track.logId ? (
          // The row opens the finding's log page (we keep listeners on
          // fluncle.com). Stretched over the whole row via ::after; the artwork
          // and the links menu sit above it as siblings.
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
          // No coordinate yet (the ISRC straggler): no log page, so the row
          // still falls back to Spotify.
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
        {labelLine ? <span className="track-label block truncate">{labelLine}</span> : null}
        <TrackChips bpm={track.bpm} durationMs={track.durationMs} musicalKey={track.key} />
      </span>

      <span className="track-actions">
        <TrackLinksMenu track={track} trackLine={trackLine} />
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
      <DropdownMenuTrigger aria-label={`Links for ${track.title}`} className="track-action">
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

// The single, scalable links affordance: one overflow button (left of the caret)
// opening a menu of the platforms this finding actually has — Spotify always,
// TikTok/YouTube when a published post exists — plus Share. New platforms slot in
// here without changing the row's layout.
function TrackLinksMenu({ track, trackLine }: { track: Track; trackLine: string }) {
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
      <DropdownMenuTrigger aria-label={`Links for ${trackLine}`} className="track-action">
        <DotsThreeIcon aria-hidden="true" size={18} weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuItem
          render={
            <a aria-label="Spotify" href={track.spotifyUrl} rel="noreferrer" target="_blank" />
          }
        >
          <BrandIcon className="size-4" icon={siSpotify} />
          Spotify
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
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={share}>
          <ShareNetworkIcon aria-hidden="true" className="size-4" />
          Share
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Enrichment metadata as quiet chips: tempo and key read as instrument-panel
// numerals (Oxanium, tabular). Nothing renders until enrichment has produced
// something to show.
function TrackChips({
  bpm,
  durationMs,
  musicalKey,
}: {
  bpm?: number;
  durationMs?: number;
  musicalKey?: string;
}) {
  if (!durationMs && !bpm && !musicalKey) {
    return null;
  }

  return (
    <span className="mt-1.5 flex flex-wrap items-center gap-1">
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
