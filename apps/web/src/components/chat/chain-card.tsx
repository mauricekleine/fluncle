import { useMemo } from "react";
import { ArrowRightIcon, PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { type ChatFinding, FindingCard } from "@/components/chat/finding-card";
import { SpotifyIcon } from "@/components/platform-icons";
import { TrackArtwork } from "@/components/track-artwork";
import { formatKey, type KeyNotation } from "@/lib/key-notation";
import { albumCoverAtSize } from "@/lib/media";
import { toQueueTrack } from "@/lib/player-tracks";
import { usePreviewPlayer } from "@/lib/preview-player";
import { Badge } from "@fluncle/ui/components/badge";

type ChatStep = ChatFinding & { reason?: string };

export type ChatSet = {
  seed?: ChatFinding;
  setUrl?: string;
  steps?: ChatStep[];
  thin?: boolean;
};

export function ChainCard({ notation, set }: { notation: KeyNotation; set: ChatSet }) {
  const seed = set.seed;

  if (!seed) {
    return null;
  }

  const steps = set.steps ?? [];

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-card px-3 py-2.5">
      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">Start here</p>
        <FindingCard embedded finding={seed} notation={notation} />
      </div>

      {steps.length > 0 ? (
        <ol className="flex flex-col divide-y divide-border">
          {steps.map((step, index) => (
            <ChainStep
              key={step.coordinate ?? index}
              notation={notation}
              position={index + 1}
              step={step}
            />
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">
          Not enough logged near this one yet to chain a set from it.
        </p>
      )}

      {set.setUrl && steps.length > 0 ? (
        <div className="border-t border-border pt-2.5">
          <a
            aria-label="Open this set in /mix"
            className="track-log-id-link inline-flex items-center gap-1 text-xs text-muted-foreground"
            href={set.setUrl}
          >
            Open in /mix
            <ArrowRightIcon aria-hidden="true" weight="bold" />
          </a>
        </div>
      ) : null}
    </div>
  );
}

function ChainStep({
  notation,
  position,
  step,
}: {
  notation: KeyNotation;
  position: number;
  step: ChatStep;
}) {
  const logId = step.coordinate;
  const title = step.title ?? "";
  const artists = step.artists ?? [];
  const trackLine = artists.length > 0 ? `${artists.join(", ")} — ${title}` : title;
  const keyText = formatKey(step.key, notation);
  const coverSrc = albumCoverAtSize(step.albumImageUrl, "small");

  const playable = Boolean(step.hasPreview && logId);

  const queued = useMemo(
    () =>
      toQueueTrack({
        albumImageUrl: step.albumImageUrl,
        artists: step.artists ?? [],
        logId,
        spotifyUrl: step.spotifyUrl,
        title,
        trackId: logId ?? "",
      }),
    [step.albumImageUrl, step.artists, step.spotifyUrl, logId, title],
  );
  const { isActive, isLoading, toggle } = usePreviewPlayer(logId ?? "", {
    publicPreview: true,
    track: queued,
  });

  const artwork = <TrackArtwork alt={`${trackLine} cover art`} src={coverSrc} />;

  return (
    <li className="flex items-center gap-2.5 py-2 first:pt-0 last:pb-0">
      <span
        aria-hidden="true"
        className="w-4 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
      >
        {position}
      </span>

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
        <span className={logId ? "shrink-0" : "chain-step--unlit shrink-0"}>{artwork}</span>
      )}

      <div className="min-w-0 flex-1">
        <p className="track-title">{trackLine}</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          {logId ? (
            <Link
              aria-label={`Open the log page for ${trackLine}`}
              className="track-log-id track-log-id-link"
              params={{ logId }}
              to="/log/$logId"
            >
              {logId}
            </Link>
          ) : null}
          {step.reason ? <Badge variant="secondary">{step.reason}</Badge> : null}
          {keyText ? <span className="text-xs text-muted-foreground">{keyText}</span> : null}
        </div>
      </div>

      {!logId && step.spotifyUrl ? (
        <a
          aria-label={`Open ${title} on Spotify`}
          className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          href={step.spotifyUrl}
          rel="noreferrer"
          target="_blank"
        >
          <SpotifyIcon aria-hidden="true" className="size-4" />
        </a>
      ) : null}
    </li>
  );
}
