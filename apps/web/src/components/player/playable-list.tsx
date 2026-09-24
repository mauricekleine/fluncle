// A list that plays. Wrap any track list in `PlayableList` with the list's tracks, in display
// order, and every `PlayCover` inside it plays the WHOLE list from its own row: the list becomes
// the player's queue (lib/preview-player.ts). A cover outside a list plays its one track.
//
// It is a player, not a transport: nothing on the page moves because the queue did. The page
// stays a scroll, the queue lives in the bar, and the listener can leave in any direction.

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
  /**
   * The next page of a paginated list. At the end of this page the player's "keep going" walks
   * there and plays it from the top; without it, "keep going" plays the last track's sonic
   * neighbours.
   */
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

  // The previous page asked to keep going into this one: play it from its first row. The claim
  // is one-shot and matches this exact URL, so a list the listener reached any other way stays
  // silent until they press play.
  useEffect(() => {
    if (tracks.length > 0 && claimPageContinuation(href)) {
      // A continuation landing, not a press: it never silences another sound.
      playQueue(tracks, 0, { continuation: value.continuation, origin: "automatic" });
    }
    // Only on arrival: a later re-render of the same page must never start the list again.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [href]);

  return <PlayableListContext.Provider value={value}>{children}</PlayableListContext.Provider>;
}

/**
 * One track's play control inside (or outside) a list: its status, whether its preview came back
 * empty, and the press that plays the list from this track, pauses it, or resumes it in place.
 */
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

/**
 * The cover IS the play button (DESIGN.md Track Row). The glyph shows on hover and focus, and
 * always, small, on a touch screen; the playing row holds a pause glyph. A track whose preview
 * came back empty dims its glyph and stays tappable (a second try is cheap and honest).
 *
 * `children` is the artwork itself, so every row keeps its own cover treatment (lit, unlit,
 * avatar fallback) and this component only adds the control around it.
 */
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

/**
 * The same control as a labelled button, for a placement that is not a cover (the front door's
 * lead finding). The caller supplies the visible label for each state; the accessible name adds
 * the track, so a screen reader hears what will play.
 */
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
