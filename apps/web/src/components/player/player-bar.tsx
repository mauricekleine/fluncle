import { CaretRightIcon, PauseIcon, PlayIcon, SkipForwardIcon, XIcon } from "@phosphor-icons/react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TrackActionsMenu } from "@/components/player/track-actions-menu";
import { TrackArtwork } from "@/components/track-artwork";
import { albumCoverAtSize } from "@/lib/media";
import { loadSimilarTracks, similarSearchHref, trackCredit } from "@/lib/player-tracks";
import {
  dismissPlayer,
  keepGoing,
  skipNext,
  skipPrevious,
  togglePlayback,
  usePlayerQueue,
  type QueueTrack,
  usePreviewProgress,
  usePreviewStatus,
  useSonicTrail,
} from "@/lib/preview-player";

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

function isActivatable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest(
      "button, a[href], summary, label, [tabindex]:not([tabindex='-1']), [role='button'], [role='checkbox'], [role='menuitem'], [role='option'], [role='radio'], [role='slider'], [role='switch'], [role='tab']",
    ) !== null
  );
}

function isInsideOverlay(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']") !==
      null
  );
}

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
        event.shiftKey ||
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

function SonicTrail({ trail }: { trail: readonly QueueTrack[] }): ReactNode {
  const here = useRouterState({
    select: (state): string | undefined => {
      const like = (state.location.search as { like?: unknown }).like;

      return state.location.pathname === "/search" && typeof like === "string" ? like : undefined;
    },
  });

  if (trail.length === 0) {
    return undefined;
  }

  const nearest = nearestSeedIndex(trail, here);

  return (
    <nav aria-label="Similar tracks trail" className="player-trail">
      <ol className="player-trail-seeds">
        {trail.map((seed, index) => (
          <li
            className="player-trail-seed"
            data-nearest={index === nearest ? "" : undefined}
            key={seed.id}
          >
            <Link
              aria-current={here === seed.id ? "page" : undefined}
              aria-label={`Similar to ${trackCredit(seed)}`}
              className="player-trail-link"
              data-discovery="similar"
              preload={false}
              to={similarSearchHref(seed) as never}
            >
              <TrackArtwork
                alt=""
                className="player-trail-cover"
                src={albumCoverAtSize(seed.coverUrl, "small")}
              />
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function nearestSeedIndex(trail: readonly QueueTrack[], here: string | undefined): number {
  for (let index = trail.length - 1; index >= 0; index -= 1) {
    if (trail[index]?.id !== here) {
      return index;
    }
  }

  return trail.length - 1;
}

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
  const trail = useSonicTrail();
  const track = queue?.tracks[queue.index];
  const status = usePreviewStatus(track?.id);
  const navigate = useNavigate();
  const mainButton = useRef<HTMLButtonElement>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => setNoWayOn(false), [queue?.tracks]);

  const docked = mounted && track !== undefined;

  usePlayerKeys(docked);

  const trailed = docked && trail.length > 0;

  useEffect(() => {
    const root = document.documentElement;

    if (trailed) {
      root.dataset.playerTrail = "";
    } else {
      delete root.dataset.playerTrail;
    }

    return () => {
      delete root.dataset.playerTrail;
    };
  }, [trailed]);

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
      .then((outcome) => {
        if (outcome === "stale") {
          return;
        }

        setNoWayOn(outcome === "none");

        mainButton.current?.focus();
      })
      .finally(() => setContinuing(false));
  };

  const onClose = () => {
    dismissPlayer();

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
        <SonicTrail trail={trail} />
        {track.href ? (
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
          <p aria-live="polite" className="player-title">
            {track.href ? (
              <Link className="player-title-link" to={track.href as never}>
                {track.title}
              </Link>
            ) : (
              track.title
            )}
          </p>

          {queue.ended && noWayOn ? (
            <output className="player-artists">Nothing else close in sound yet.</output>
          ) : (
            <p className="player-artists">
              <span className="player-artists-names">{track.artists.join(", ")}</span>
              <span aria-hidden="true" className="player-position player-position--inline">
                {position}
              </span>
            </p>
          )}
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
                aria-label="Keep going"
                className="player-keep-going"
                onClick={onKeepGoing}
                type="button"
              >
                <span className="player-keep-going-label">Keep going</span>
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
