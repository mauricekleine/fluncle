import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { useRouterState } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useEffect, useMemo } from "react";
import {
  claimPageContinuation,
  pausePreview,
  playQueue,
  type PreviewStatus,
  type QueueContinuation,
  type QueueTrack,
  togglePlayback,
  usePreviewMissing,
  usePreviewStatus,
} from "@/lib/preview-player";
import { trackCredit } from "@/lib/player-tracks";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@fluncle/ui/components/button";

type PlayableListValue = {
  continuation?: QueueContinuation;
  tracks: QueueTrack[];
};

const PlayableListContext = createContext<PlayableListValue | undefined>(undefined);

export function PlayableList({
  children,
  nextPageHref,
  tracks,
}: {
  children: ReactNode;

  nextPageHref?: string;
  tracks: QueueTrack[];
}): ReactNode {
  const href = useRouterState({ select: (state) => state.location.href });
  const value = useMemo<PlayableListValue>(
    () => ({
      continuation: nextPageHref ? { href: nextPageHref, kind: "page" } : undefined,
      tracks,
    }),
    [nextPageHref, tracks],
  );

  useEffect(() => {
    if (tracks.length > 0 && claimPageContinuation(href)) {
      playQueue(tracks, 0, { continuation: value.continuation, origin: "automatic" });
    }

    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [href]);

  return <PlayableListContext.Provider value={value}>{children}</PlayableListContext.Provider>;
}

function useListPlay(track: QueueTrack): {
  active: boolean;
  missing: boolean;
  onClick: () => void;
  status: PreviewStatus;
} {
  const list = useContext(PlayableListContext);
  const status = usePreviewStatus(track.id);
  const missing = usePreviewMissing(track.id);
  const active = status === "playing" || status === "loading";

  const onClick = () => {
    if (active) {
      pausePreview();

      return;
    }

    if (status === "paused") {
      togglePlayback();

      return;
    }

    const index = list ? list.tracks.findIndex((item) => item.id === track.id) : -1;

    if (list && index >= 0) {
      playQueue(list.tracks, index, { continuation: list.continuation });

      return;
    }

    playQueue([track], 0);
  };

  return { active, missing, onClick, status };
}

export function PlayCover({
  children,
  className,
  glyphClassName,
  lit,
  track,
}: {
  children: ReactNode;
  className?: string;
  glyphClassName?: string;
  lit?: boolean;
  track: QueueTrack;
}): ReactNode {
  const { active, missing, onClick, status } = useListPlay(track);
  const credit = trackCredit(track);

  return (
    <button
      aria-label={active ? `Pause the preview of ${credit}` : `Play the preview of ${credit}`}
      className={cn("play-cover", className)}
      data-discovery-play=""
      data-lit={lit ? "" : undefined}
      data-missing={missing ? "" : undefined}
      data-status={status}
      onClick={onClick}
      type="button"
    >
      {children}
      <span aria-hidden="true" className={cn("play-cover-glyph", glyphClassName)}>
        {active ? <PauseIcon weight="fill" /> : <PlayIcon weight="fill" />}
      </span>
    </button>
  );
}

export function PlayButton({
  className,
  labels,
  track,
}: {
  className?: string;
  labels: { pause: string; play: string };
  track: QueueTrack;
}): ReactNode {
  const { active, missing, onClick, status } = useListPlay(track);
  const credit = trackCredit(track);
  const label = active ? labels.pause : labels.play;

  return (
    <button
      aria-label={`${label} of ${credit}`}
      className={cn(buttonVariants({ size: "lg" }), "min-h-11", className)}
      data-discovery-play=""
      data-missing={missing ? "" : undefined}
      data-status={status}
      onClick={onClick}
      type="button"
    >
      {active ? (
        <PauseIcon aria-hidden="true" weight="fill" />
      ) : (
        <PlayIcon aria-hidden="true" weight="fill" />
      )}
      {label}
    </button>
  );
}
