import {
  CaretRightIcon,
  FilmStripIcon,
  PauseIcon,
  PlayIcon,
  TiktokLogoIcon,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { TrackArtwork } from "@/components/track-artwork";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatDuration } from "@/lib/format";
import { usePreviewPlayer } from "@/lib/preview-player";
import { type Track } from "@/lib/tracks";

const maxTagChips = 3;

// The signature component (DESIGN.md): a finding, not just a row. The whole
// row still reads as one link to Spotify (a stretched link), but the artwork
// doubles as the in-place preview toggle and the actions cell links out to the
// finding's story and TikTok post — siblings of the anchor, never nested in it.
export function TrackRow({ track, trackNumber }: { track: Track; trackNumber: number }) {
  const storyLogId = track.videoUrl ? track.logId : undefined;
  const trackLine = `${track.artists.join(", ")} - ${track.title}`;

  return (
    <li className="track-row">
      <span className="track-log-id">
        {track.logId ?? `#${trackNumber.toString().padStart(2, "0")}`}
      </span>

      {track.previewUrl ? (
        <PreviewToggle track={track} trackLine={trackLine} />
      ) : (
        <TrackArtwork src={track.albumImageUrl} />
      )}

      <span className="min-w-0">
        <a
          aria-label={`Open ${trackLine} on Spotify`}
          className="track-row-link"
          href={track.spotifyUrl}
          rel="noreferrer"
          target="_blank"
        >
          <span className="track-title block text-pretty [overflow-wrap:anywhere]">
            {track.title}
          </span>
        </a>
        <span className="track-artist block text-pretty [overflow-wrap:anywhere]">
          {track.artists.join(", ")}
        </span>
        {track.label ? <span className="track-label block truncate">{track.label}</span> : null}
        <TrackChips bpm={track.bpm} musicalKey={track.key} tags={track.tags} />
      </span>

      <span className="track-meta hidden justify-self-end text-right sm:grid">
        <time className="track-date" dateTime={track.addedAt}>
          {formatDate(track.addedAt)}
        </time>
        {track.durationMs ? (
          <span className="track-duration">{formatDuration(track.durationMs)}</span>
        ) : null}
      </span>

      <span className="track-actions">
        {storyLogId ? (
          <Link
            aria-label={`Watch the story for ${trackLine}`}
            className="track-action"
            params={{ logId: storyLogId }}
            to="/stories/$logId"
          >
            <FilmStripIcon aria-hidden="true" size={18} weight="bold" />
          </Link>
        ) : null}
        {track.tiktokUrl ? (
          <a
            aria-label={`Open ${trackLine} on TikTok`}
            className="track-action"
            href={track.tiktokUrl}
            rel="noreferrer"
            target="_blank"
          >
            <TiktokLogoIcon aria-hidden="true" size={18} weight="bold" />
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
// numerals (Oxanium, tabular); tags stay plain words. Nothing renders until
// enrichment has produced something to show.
function TrackChips({
  bpm,
  musicalKey,
  tags,
}: {
  bpm?: number;
  musicalKey?: string;
  tags?: string[];
}) {
  const tagChips = tags?.slice(0, maxTagChips) ?? [];

  if (!bpm && !musicalKey && tagChips.length === 0) {
    return null;
  }

  return (
    <span className="mt-1.5 flex flex-wrap items-center gap-1">
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
      {tagChips.map((tag) => (
        <Badge className="track-chip" key={tag} variant="outline">
          {tag}
        </Badge>
      ))}
    </span>
  );
}
