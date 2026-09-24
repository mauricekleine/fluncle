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
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TrackActionsMenu } from "@/components/player/track-actions-menu";
import { TrackArtwork } from "@/components/track-artwork";
import { albumCoverAtSize } from "@/lib/media";
import { loadSimilarTracks } from "@/lib/player-tracks";
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

/** A control Space already means something on (a button presses, a link follows, a switch flips). */
function isActivatable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest(
      "button, a[href], summary, label, [tabindex]:not([tabindex='-1']), [role='button'], [role='checkbox'], [role='menuitem'], [role='option'], [role='radio'], [role='slider'], [role='switch'], [role='tab']",
    ) !== null
  );
}

/** A dialog or menu owns the keyboard while it is open (Stories binds Space and the arrows). */
function isInsideOverlay(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']") !==
      null
  );
}

/**
 * The keyboard transport: Space or K plays and pauses, J and L step back and forward through the
 * playing list. Never while focus is in a field or an open dialog or menu, never with a modifier
 * held (⌘K stays search), and Space leaves any focused control to do its own job — it only
 * toggles from the page itself. Mounted only while the bar is docked, so a visit that never
 * pressed play keeps every key it had.
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
        isTypingTarget(event.target) ||
        isInsideOverlay(event.target)
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
  const mainButton = useRef<HTMLButtonElement>(null);

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
  const position = `${queue.index + 1}/${queue.tracks.length}`;
  const cover = albumCoverAtSize(track.coverUrl, "small");

  const onKeepGoing = () => {
    if (continuing) {
      return;
    }

    setContinuing(true);
    void keepGoing({
      loadSimilar: loadSimilarTracks,
      navigate: (href) => void navigate({ href }),
    })
      .then((moved) => {
        setNoWayOn(!moved);

        // The control the listener pressed is about to go (a new list, or no way on): focus
        // lands on the play button rather than falling to the page.
        mainButton.current?.focus();
      })
      .finally(() => setContinuing(false));
  };

  const onClose = () => {
    dismissPlayer();

    // The bar unmounts under the focus it held; hand focus back to the page.
    const page = document.getElementById("content") ?? document.querySelector("main");

    if (page instanceof HTMLElement) {
      if (!page.hasAttribute("tabindex")) {
        page.setAttribute("tabindex", "-1");
      }

      page.focus({ preventScroll: true });
    }
  };

  return createPortal(
    <section aria-label="Player" className="player-bar" data-lit={track.lit ? "" : undefined}>
      <ProgressLine lit={track.lit === true} />
      <div className="player-bar-inner">
        {track.href ? (
          // The same page the title opens: a mouse target only, hidden from the keyboard and from
          // assistive tech so the one link is announced once.
          <Link
            aria-hidden="true"
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
            <span aria-hidden="true" className="player-position player-position--inline">
              {position}
            </span>
          </p>
          <span className="sr-only">{`Track ${queue.index + 1} of ${queue.tracks.length}`}</span>
        </div>
        <span aria-hidden="true" className="player-position">
          {position}
        </span>
        <div className="player-controls">
          <button
            aria-label={playing ? "Pause" : "Play"}
            className="player-button player-button--main"
            onClick={togglePlayback}
            ref={mainButton}
            type="button"
          >
            {playing ? <PauseIcon weight="fill" /> : <PlayIcon weight="fill" />}
          </button>
          {queue.ended ? (
            noWayOn ? undefined : (
              <button
                aria-busy={continuing}
                aria-disabled={continuing}
                className="player-keep-going"
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
              <SkipForwardIcon />
            </button>
          )}
          <TrackActionsMenu className="player-button" side="top" track={track} />
          <button
            aria-label="Close the player"
            className="player-button player-button--close"
            onClick={onClose}
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
