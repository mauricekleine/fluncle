import { useMemo } from "react";
import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { TrackArtwork } from "@/components/track-artwork";
import { TrackChips } from "@/components/track-row";
import { formatKey, type KeyNotation } from "@/lib/key-notation";
import { albumCoverAtSize } from "@/lib/media";
import { toQueueTrack } from "@/lib/player-tracks";
import { usePreviewPlayer, usePreviewProgress } from "@/lib/preview-player";

export type ChatFinding = {
  album?: string;
  albumImageUrl?: string;
  artists?: string[];
  bpm?: number;
  coordinate?: string;
  durationMs?: number;
  found?: string;
  galaxy?: string;
  hasPreview?: boolean;
  key?: string;
  label?: string;
  note?: string;

  releaseDate?: string;
  spotifyUrl?: string;
  title?: string;
};

function ProgressHairline() {
  const { currentTime, duration } = usePreviewProgress();
  const fraction = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  return (
    <div aria-hidden="true" className="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-muted">
      <div
        className="h-full origin-left bg-primary transition-transform duration-200 ease-linear motion-reduce:transition-none"
        style={{ transform: `scaleX(${fraction})` }}
      />
    </div>
  );
}

export function FindingCard({
  embedded = false,
  finding,
  notation,
}: {
  embedded?: boolean;
  finding: ChatFinding;
  notation: KeyNotation;
}) {
  const logId = finding.coordinate;
  const title = finding.title ?? "";
  const artists = finding.artists ?? [];
  const trackLine = artists.length > 0 ? `${artists.join(", ")} — ${title}` : title;
  const keyText = formatKey(finding.key, notation);
  const coverSrc = albumCoverAtSize(finding.albumImageUrl, "small");

  const playable = Boolean(finding.hasPreview && logId);

  const queued = useMemo(
    () =>
      toQueueTrack({
        albumImageUrl: finding.albumImageUrl,
        artists: finding.artists ?? [],
        logId,
        spotifyUrl: finding.spotifyUrl,
        title,
        trackId: logId ?? "",
      }),
    [finding.albumImageUrl, finding.artists, finding.spotifyUrl, logId, title],
  );
  const { isActive, isLoading, toggle } = usePreviewPlayer(logId ?? "", {
    publicPreview: true,
    track: queued,
  });

  const artwork = <TrackArtwork alt={`${trackLine} cover art`} src={coverSrc} />;

  return (
    <div
      className={
        embedded
          ? "relative flex items-center gap-3 overflow-hidden"
          : "relative flex items-center gap-3 overflow-hidden rounded-md border border-border bg-card px-3 py-2.5"
      }
    >
      {playable && isActive ? <ProgressHairline /> : null}

      {playable ? (
        <button
          aria-label={`${isActive ? "Pause" : "Play"} preview: ${trackLine}`}
          aria-pressed={isActive}
          className="track-play shrink-0"
          onClick={toggle}
          type="button"
        >
          {artwork}
          <span aria-hidden="true" className="track-play-glyph">
            {isActive && !isLoading ? <PauseIcon weight="fill" /> : <PlayIcon weight="fill" />}
          </span>
        </button>
      ) : (
        <span className="shrink-0">{artwork}</span>
      )}

      <div className="min-w-0 flex-1">
        <p className="track-title">{trackLine}</p>

        {logId || finding.galaxy ? (
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
            {logId ? (
              <Link
                aria-label={`Open the log page for ${trackLine}`}
                className="track-log-id track-log-id-link shrink-0"
                params={{ logId }}
                to="/log/$logId"
              >
                {logId}
              </Link>
            ) : null}
            {logId && finding.galaxy ? (
              <span aria-hidden="true" className="text-xs text-muted-foreground">
                ·
              </span>
            ) : null}
            {finding.galaxy ? (
              <span className="truncate text-xs text-muted-foreground">{finding.galaxy}</span>
            ) : null}
          </div>
        ) : null}
        <TrackChips
          bpm={finding.bpm}
          durationMs={finding.durationMs}
          musicalKey={keyText || undefined}
        />
      </div>
    </div>
  );
}
