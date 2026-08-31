// Concept C — the stop. One track, filling the frame, with everything the
// visitor needs to hear it and nothing else.
//
// The Unlit Rule is carried structurally: `run-lit` / `run-unlit` is set from
// whether the row has a coordinate, and every gold rule in run.css hangs off
// `run-lit`. Nothing on this surface ever SAYS which tier a stop is in — the
// coordinate renders or it does not, and the light does the rest.

import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { type RefObject, useRef, useState } from "react";

import { Button } from "@fluncle/ui/components/button";

import { Cover, Coordinate, ListenRow, Readout } from "@/components/concepts/shared";
import {
  type ConceptEntity,
  type ConceptEntityKind,
  type ConceptTrack,
  listenDestinations,
} from "@/concepts/discovery/model";
import { cn } from "@/lib/utils";

const ENTITY_WORD: Record<ConceptEntityKind, string> = {
  album: "Album",
  artist: "Artist",
  label: "Label",
};

/** Idle, sounding, or the relay had nothing for this coordinate. */
type Relay = "idle" | "playing" | "unavailable";

/**
 * The one line a state genuinely needs, and never more than one (The Three Areas
 * Rule). The relay is database-backed, so on this snapshot it usually answers
 * nothing — which is said plainly rather than hidden behind a dead control.
 */
function absenceLine(hasDestinations: boolean, relay: Relay): string | undefined {
  if (hasDestinations) {
    return relay === "unavailable" ? "No preview here." : undefined;
  }

  return relay === "unavailable" ? "Nothing to play here." : "No listen link for this track.";
}

/**
 * A bounded preview through Fluncle's own relay, started only by a real gesture.
 * An uncertified stop has no coordinate, so it has no relay path at all and goes
 * straight to the outbound destinations.
 */
function RunTransport({ track }: { track: ConceptTrack }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [relay, setRelay] = useState<Relay>("idle");
  const destinations = listenDestinations(track);
  const relaySrc =
    track.logId === undefined ? undefined : `/api/preview/${encodeURIComponent(track.logId)}`;
  const line = absenceLine(destinations.length > 0, relay);

  function toggle() {
    const element = audio.current;

    if (element === null) {
      return;
    }

    if (relay === "playing") {
      element.pause();
      setRelay("idle");

      return;
    }

    void element
      .play()
      .then(() => {
        setRelay("playing");
      })
      .catch(() => {
        setRelay("unavailable");
      });
  }

  return (
    <div className="run-transport">
      {relaySrc === undefined || relay === "unavailable" ? null : (
        <>
          <Button
            aria-pressed={relay === "playing"}
            className="run-preview"
            onClick={toggle}
            size="sm"
            variant="outline"
          >
            {relay === "playing" ? (
              <PauseIcon aria-hidden="true" weight="fill" />
            ) : (
              <PlayIcon aria-hidden="true" weight="fill" />
            )}
            {relay === "playing" ? "Pause" : "Play"}
          </Button>
          {/* A 30s instrumental preview carries no speech, so there is nothing for a
              captions track to caption and an empty one would be a lie to a screen
              reader. The control beside it is labelled and keyboard-operable. */}
          {/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
          <audio
            onEnded={() => {
              setRelay("idle");
            }}
            onError={() => {
              setRelay("unavailable");
            }}
            preload="none"
            ref={audio}
            src={relaySrc}
          />
        </>
      )}
      {/* Always quiet, on both tiers, and for two different reasons. On an
          uncertified stop gold is forbidden outright (The Unlit Rule). On a
          certified one it is a budget call: this surface's primary action is the
          transport — the lead branch — and two gold actions in one view means one
          of them is wrong (The One Sun Rule). The lead branch keeps the gold; the
          outbound link is the second thing you might do, so it reads as one. */}
      <ListenRow tone="quiet" track={track} />
      {line === undefined ? null : <p className="run-plain">{line}</p>}
    </div>
  );
}

/**
 * The stop itself. `ghost` is the stop being left behind: it sits under the
 * arriving cover for the length of the cross-fade and is inert while it is there.
 */
export function RunStopPanel({
  entered,
  ghost,
  headingRef,
  track,
}: {
  entered?: ConceptEntity;
  ghost?: ConceptTrack;
  /**
   * Where focus lands when the lane advances. The stop remounts on every step, so
   * without this the control the reader just used leaves the DOM and focus falls
   * to the body — restarting a keyboard reader at the top of the document on the
   * one gesture this surface is built around.
   */
  headingRef?: RefObject<HTMLHeadingElement | null>;
  track: ConceptTrack;
}) {
  return (
    <section
      aria-label="Current track"
      className={cn("run-stop", track.logId === undefined ? "run-unlit" : "run-lit")}
      data-run-stop=""
    >
      <div className="run-art">
        <div className="run-art-frame">
          {ghost === undefined ? null : (
            <div aria-hidden="true" className="run-cover-ghost">
              <Cover className="run-cover" lit={ghost.certified} src={ghost.coverUrl} />
            </div>
          )}
          <div className="run-cover-live" data-run-cover="">
            <Cover className="run-cover" lit={track.certified} priority src={track.coverUrl} />
          </div>
        </div>
      </div>
      <div className="run-detail">
        {entered === undefined ? null : (
          <p className="run-entered">
            <span className="run-entered-kind">{ENTITY_WORD[entered.kind]}</span>
            <span className={cn("run-entered-name", entered.certified ? "run-lit" : "run-unlit")}>
              {entered.name}
            </span>
          </p>
        )}
        <Coordinate track={track} />
        <h1 className="run-title concept-focus" ref={headingRef} tabIndex={-1}>
          {track.title}
        </h1>
        <p className="run-artists">{track.artists.join(", ")}</p>
        <Readout track={track} />
        {track.note === undefined ? null : <p className="run-note">{track.note}</p>}
        <RunTransport track={track} />
      </div>
    </section>
  );
}
