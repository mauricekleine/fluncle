import { CaretRightIcon, PauseIcon, PlayIcon, PlayCircleIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { siTiktok } from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";
import { TrackArtwork } from "@/components/track-artwork";
import { Badge } from "@/components/ui/badge";
import { formatDuration } from "@/lib/format";
import { usePreviewPlayer } from "@/lib/preview-player";
import { type Track } from "@/lib/tracks";

// The signature component (DESIGN.md): a finding, not just a row. The whole
// row still reads as one link to Spotify (a stretched link), but the artwork
// doubles as the in-place preview toggle and the actions cell links out to the
// finding's story and TikTok post — siblings of the anchor, never nested in it.
export function TrackRow({ track, trackNumber }: { track: Track; trackNumber: number }) {
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

      {track.previewUrl ? (
        <PreviewToggle track={track} trackLine={trackLine} />
      ) : (
        <TrackArtwork src={track.albumImageUrl} />
      )}

      <span className="min-w-0">
        {track.logId ? (
          // The row opens the finding's log page (we keep listeners on
          // fluncle.com); Spotify lives on the "Listen on Spotify" button there.
          // Stretched over the whole row via ::after; the preview toggle and the
          // action links sit above it as siblings.
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
        {storyLogId ? (
          // Opens the story as a dialog over the feed; the mask shows (and
          // crawlers see) the standalone /log/<id> URL, which is also what a
          // refresh or share lands on.
          <Link
            aria-label={`Watch the story for ${trackLine}`}
            className="track-action"
            mask={{ params: { logId: storyLogId }, to: "/log/$logId", unmaskOnReload: true }}
            search={{ story: storyLogId }}
            to="/"
          >
            <PlayCircleIcon aria-hidden="true" size={18} weight="fill" />
          </Link>
        ) : null}
        {track.tiktokUrl ? (
          <a
            aria-label={`Watch ${trackLine} on TikTok`}
            className="track-action"
            href={track.tiktokUrl}
            rel="noreferrer"
            target="_blank"
          >
            <BrandIcon className="size-3.5" icon={siTiktok} />
          </a>
        ) : null}
        <CaretRightIcon aria-hidden="true" className="track-caret" size={18} weight="bold" />
      </span>
    </li>
  );
}

// The artwork as the play/pause toggle for the official 30s preview.
function PreviewToggle({ track, trackLine }: { track: Track; trackLine: string }) {
  const preview = usePreviewPlayer(track.trackId);

  return (
    <button
      aria-label={
        preview.isActive ? `Stop the preview of ${trackLine}` : `Play a preview of ${trackLine}`
      }
      aria-pressed={preview.isActive}
      className="track-play"
      onClick={preview.toggle}
      type="button"
    >
      <TrackArtwork src={track.albumImageUrl} />
      <span aria-hidden="true" className="track-play-glyph">
        {preview.isActive ? <PauseIcon weight="fill" /> : <PlayIcon weight="fill" />}
      </span>
    </button>
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
