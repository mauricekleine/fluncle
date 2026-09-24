// THE PLAYER BAR — the persistent preview player of the public chrome (DESIGN.md §5, Player Bar).
//
// Hidden until the first play; from then on it docks to the bottom of every public page for the
// rest of the visit, playing or paused, until the listener closes it. It shows the one thing that
// is sounding (cover, `Artist — Title`), its place in the list (`4/30`, Oxanium tabular), the
// transport a preview needs (play/pause, next) and the playing track's actions (the same ⋮ menu a
// row carries). At the end of a list it stops and offers one way on: "Keep going".
//
// It reads as the sleeve the liner notes print on, not a streaming app's dock: a warm near-opaque
// pane (the colophon's ground) with grain under the content, a Dust Line top edge, no shadow, and
// gold spent on one hairline — the progress of a FINDING. A catalogue track's progress catches
// Stardust instead (The Unlit Rule).
//
// Mounted once by the public chrome. It portals to document.body so no ancestor's
// backdrop-filter becomes its containing block (the plate trap), and renders nothing on the
// server: there is no queue before the first click, so hydration never sees it.

import { CaretRightIcon, PauseIcon, PlayIcon, SkipForwardIcon, XIcon } from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { TrackActionsMenu } from "@/components/player/track-actions-menu";
import { TrackArtwork } from "@/components/track-artwork";
import { albumCoverAtSize } from "@/lib/media";
import { loadSimilarTracks, trackCredit } from "@/lib/player-tracks";
import {
  dismissPlayer,
  keepGoing,
  skipNext,
  skipPrevious,
  togglePlayback,
  usePlayerQueue,
  usePreviewProgress,
  usePreviewStatus,
} from "@/lib/preview-player";

/** A field the keyboard belongs to: typing there is never a transport command. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.getAttribute("role") === "combobox"
  );
}

/** A control Space already means something on (a button presses, a link follows). */
function isActivatable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest(
      "button, a[href], summary, [role='button'], [role='menuitem'], [role='option']",
    ) !== null
  );
}

/**
 * The keyboard transport: Space or K plays and pauses, J and L step back and forward through the
 * playing list. Never while focus is in a field, never with a modifier held (⌘K stays search),
 * and Space leaves a focused button or link to do its own job.
 */
function usePlayerKeys(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isTypingTarget(event.target)
      ) {
        return;
      }

      const key = event.key.toLowerCase();

      if (key === " " && isActivatable(event.target)) {
        return;
      }

      const action =
        key === " " || key === "k"
          ? togglePlayback
          : key === "j"
            ? skipPrevious
            : key === "l"
              ? skipNext
              : undefined;

      if (action) {
        event.preventDefault();
        action();
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}

/** A thin hairline for progress: light placed, not a scrubber (the /mix bar's grammar). */
function ProgressLine({ lit }: { lit: boolean }): ReactNode {
  const { currentTime, duration } = usePreviewProgress();
  const fraction = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  return (
    <div aria-hidden="true" className="player-progress" data-lit={lit ? "" : undefined}>
      <div className="player-progress-fill" style={{ transform: `scaleX(${fraction})` }} />
    </div>
  );
}

export function PlayerBar(): ReactNode {
  const [mounted, setMounted] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [noWayOn, setNoWayOn] = useState(false);
  const queue = usePlayerQueue();
  const track = queue?.tracks[queue.index];
  const status = usePreviewStatus(track?.id);
  const navigate = useNavigate();

  useEffect(() => setMounted(true), []);

  // A fresh list clears the last list's dead end.
  useEffect(() => setNoWayOn(false), [queue?.tracks]);

  // The page leaves room for the bar while it is docked, so the last row and the colophon are
  // never trapped under it.
  const docked = mounted && track !== undefined;

  usePlayerKeys(docked);

  useEffect(() => {
    const root = document.documentElement;

    if (docked) {
      root.dataset.playerDocked = "";
    } else {
      delete root.dataset.playerDocked;
    }

    return () => {
      delete root.dataset.playerDocked;
    };
  }, [docked]);

  if (!docked || !queue || !track) {
    return null;
  }

  const playing = status === "playing" || status === "loading";
  const credit = trackCredit(track);
  const position = `${queue.index + 1}/${queue.tracks.length}`;
  const cover = albumCoverAtSize(track.coverUrl, "small");

  const onKeepGoing = () => {
    setContinuing(true);
    void keepGoing({
      loadSimilar: loadSimilarTracks,
      navigate: (href) => void navigate({ href }),
    })
      .then((moved) => setNoWayOn(!moved))
      .finally(() => setContinuing(false));
  };

  return createPortal(
    <section aria-label="Player" className="player-bar" data-lit={track.lit ? "" : undefined}>
      <ProgressLine lit={track.lit === true} />
      <div className="player-bar-inner">
        {track.href ? (
          <Link
            aria-label={`Open ${credit}`}
            className="player-cover-link"
            tabIndex={-1}
            to={track.href as never}
          >
            <TrackArtwork alt="" className="player-cover" src={cover} />
          </Link>
        ) : (
          <TrackArtwork alt="" className="player-cover" src={cover} />
        )}
        <div className="player-text">
          {/* Announces the track on change; the ticking progress lives outside it. */}
          <p aria-live="polite" className="player-title">
            {track.href ? (
              <Link className="player-title-link" to={track.href as never}>
                {track.title}
              </Link>
            ) : (
              track.title
            )}
          </p>
          <p className="player-artists">
            {track.artists.join(", ")}
            <span className="player-position player-position--inline">{position}</span>
          </p>
        </div>
        <span className="player-position">
          <span aria-hidden="true">{position}</span>
          <span className="sr-only">{`Track ${queue.index + 1} of ${queue.tracks.length}`}</span>
        </span>
        <div className="player-controls">
          <button
            aria-label={playing ? "Pause" : "Play"}
            className="player-button player-button--main"
            onClick={togglePlayback}
            type="button"
          >
            {playing ? <PauseIcon weight="fill" /> : <PlayIcon weight="fill" />}
          </button>
          {queue.ended ? (
            noWayOn ? undefined : (
              <button
                className="player-keep-going"
                disabled={continuing}
                onClick={onKeepGoing}
                type="button"
              >
                Keep going
                <CaretRightIcon aria-hidden="true" weight="bold" />
              </button>
            )
          ) : (
            <button
              aria-label="Next track"
              className="player-button"
              onClick={skipNext}
              type="button"
            >
              <SkipForwardIcon weight="fill" />
            </button>
          )}
          <TrackActionsMenu className="player-button" side="top" track={track} />
          <button
            aria-label="Close the player"
            className="player-button player-button--close"
            onClick={dismissPlayer}
            type="button"
          >
            <XIcon weight="bold" />
          </button>
        </div>
      </div>
    </section>,
    document.body,
  );
}
