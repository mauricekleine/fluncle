// Concept C — The Run.
//
// The product model is travel: one track occupies the screen, there is always a
// next one, and the choice of what comes next is a small set of honest branches
// rather than a page of options. There is no list on this surface — behind the
// stop sits the trail already travelled, ahead of it sit the branches, and each
// branch shows the actual track it leads to.
//
// A workstation in every sense the Three Areas Rule means: literal labels, no
// helper paragraph, no narration, and the one line a state genuinely needs.
//
// The stop lives entirely in the URL, so every stop is shareable and the browser
// Back button walks the trail without this component knowing about it.

import { ArrowLeftIcon, ArrowRightIcon, TagIcon, WaveformIcon } from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { type RefObject, useEffect, useRef, useState } from "react";

import { RunKbd, sameStop, stopSearch } from "@/components/concepts/run-link";
import { RunStopPanel } from "@/components/concepts/run-stop";
import { Cover, Readout } from "@/components/concepts/shared";
import { type ConceptTrack, billing, trackKey } from "@/concepts/discovery/model";
import { cn } from "@/lib/utils";
import {
  type RunBranch,
  type RunBranchKind,
  type RunData,
  type RunStop,
} from "@/routes/-concepts-data";

const BRANCH_ICON: Record<RunBranchKind, typeof ArrowRightIcon> = {
  label: TagIcon,
  next: ArrowRightIcon,
  sound: WaveformIcon,
};

const POSITION_KEYS = ["1", "2", "3"];

function stopKeyOf(stop: RunStop): string {
  return `${stop.entity ?? ""}|${stop.anchor ?? ""}|${stop.step}`;
}

function litClass(track: ConceptTrack): string {
  return track.logId === undefined ? "run-unlit" : "run-lit";
}

/** The key a control answers to, or nothing when the key is not the transport's. */
function stopForKey(
  key: string,
  branches: RunBranch[],
  back: RunStop | undefined,
): RunStop | undefined {
  if (key === "ArrowLeft") {
    return back;
  }

  if (key === "ArrowRight" || key === "Enter") {
    return branches[0]?.to;
  }

  const position = POSITION_KEYS.indexOf(key);

  return position === -1 ? undefined : branches[position]?.to;
}

/**
 * Transport keys, bound to the LANE rather than to the window.
 *
 * A single-character shortcut that fires from anywhere on the page is a WCAG
 * 2.1.4 failure: `1`–`3` are a screen-reader user's own heading-navigation keys
 * in focus mode, and stealing them from the whole document is not something a
 * reader can turn off. So the digits are scoped to the surface — they answer only
 * while focus is inside the lane — and every one of them duplicates a real
 * focusable link, so the keyboard is a shortcut and never the only way through.
 * The arrow keys keep the wider scope, which 2.1.4 does not cover.
 */
function useTransport(
  branches: RunBranch[],
  back: RunStop | undefined,
  lane: RefObject<HTMLElement | null>,
) {
  const navigate = useNavigate();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }

      const target = event.target;

      if (target instanceof HTMLElement) {
        const tag = target.tagName.toLowerCase();

        if (
          target.isContentEditable ||
          tag === "input" ||
          tag === "select" ||
          tag === "textarea" ||
          (event.key === "Enter" && (tag === "a" || tag === "button"))
        ) {
          return;
        }
      }

      const positional = POSITION_KEYS.includes(event.key);
      const inside =
        target instanceof Node && lane.current !== null && lane.current.contains(target);

      if (positional && !inside) {
        return;
      }

      const to = stopForKey(event.key, branches, back);

      if (to === undefined) {
        return;
      }

      event.preventDefault();
      void navigate({ search: stopSearch(to), to: "/concepts/run" });
    }

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [back, branches, lane, navigate]);
}

/**
 * Advancing the lane remounts the stop, so the control the reader just used is
 * gone from the DOM and focus falls to `<body>` — on a surface whose whole
 * gesture is advancing, that restarts a keyboard reader at the top of the
 * document every single time. Focus is therefore moved deliberately onto the
 * arriving stop's heading, which is also what a screen reader should hear next.
 */
function useArrivalFocus(key: string, heading: RefObject<HTMLElement | null>) {
  const first = useRef(true);

  useEffect(() => {
    // Not on first paint: a page that steals focus on load is its own defect.
    if (first.current) {
      first.current = false;

      return;
    }

    heading.current?.focus();
  }, [heading, key]);
}

type Held = { ghost?: ConceptTrack; key: string; track: ConceptTrack };

/**
 * The stop being left behind, held for the length of the cross-fade.
 *
 * Adjusted during render rather than in an effect, so the arriving stop and the
 * departing one are painted in the same frame — an effect would paint the new
 * cover first and only then start fading the old one over it.
 */
function useDeparting(key: string, track: ConceptTrack): ConceptTrack | undefined {
  const [held, setHeld] = useState<Held>({ key, track });

  if (held.key !== key) {
    setHeld({ ghost: held.track, key, track });
  }

  useEffect(() => {
    if (held.ghost === undefined) {
      return;
    }

    const timer = window.setTimeout(() => {
      setHeld((current) => ({ key: current.key, track: current.track }));
    }, 260);

    return () => {
      window.clearTimeout(timer);
    };
  }, [held]);

  return held.ghost;
}

function RunBranchControl({ branch, position }: { branch: RunBranch; position: number }) {
  const Icon = BRANCH_ICON[branch.kind];
  const shortcut = POSITION_KEYS[position];

  return (
    <Link
      aria-keyshortcuts={shortcut}
      className={cn(
        "run-branch concept-focus",
        position === 0 ? "run-branch-lead" : undefined,
        litClass(branch.track),
      )}
      data-run-branch=""
      data-run-branch-kind={branch.kind}
      search={stopSearch(branch.to)}
      to="/concepts/run"
    >
      <Icon aria-hidden="true" className="run-branch-icon size-4" />
      <div className="run-branch-body">
        <span className="run-branch-label">{branch.label}</span>
        <span className="run-branch-billing">{billing(branch.track)}</span>
        <Readout track={branch.track} />
      </div>
      <span className="run-branch-keys">
        {position === 0 ? <RunKbd hint="→" /> : null}
        {shortcut === undefined ? null : <RunKbd hint={shortcut} />}
      </span>
    </Link>
  );
}

export function Run({ data }: { data: RunData }) {
  const { branches, current, entered, stop, trail } = data;
  // A branch whose destination is the stop already showing is a control that
  // goes nowhere; the lane drops it rather than offering it.
  const lane = branches.filter((branch) => !sameStop(branch.to, stop));
  const back =
    stop.step > 0 ? { anchor: stop.anchor, entity: stop.entity, step: stop.step - 1 } : undefined;
  const key = stopKeyOf(stop);
  const ghost = useDeparting(key, current);
  const laneRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useTransport(lane, back, laneRef);
  useArrivalFocus(key, headingRef);

  return (
    <main className="run" data-run-moved={ghost === undefined ? "false" : "true"} ref={laneRef}>
      <div className="run-head">
        {back === undefined ? null : (
          <Link
            aria-keyshortcuts="ArrowLeft"
            className="run-back concept-focus"
            search={stopSearch(back)}
            to="/concepts/run"
          >
            <ArrowLeftIcon aria-hidden="true" className="size-4" />
            Back
            <RunKbd hint="←" />
          </Link>
        )}
        <nav aria-label="Previous tracks">
          <ol className="run-trail" key={key}>
            {trail.map((track, index) => (
              <li key={trackKey(track, index)}>
                <Link
                  className={cn("run-trail-item concept-focus", litClass(track))}
                  search={stopSearch({
                    anchor: stop.anchor,
                    entity: stop.entity,
                    step: stop.step - trail.length + index,
                  })}
                  to="/concepts/run"
                >
                  <Cover className="run-trail-thumb" lit={track.certified} src={track.coverUrl} />
                  <span className="sr-only">{billing(track)}</span>
                </Link>
              </li>
            ))}
            <li aria-current="true" className={cn("run-trail-now", litClass(current))}>
              <Cover className="run-trail-thumb" lit={current.certified} src={current.coverUrl} />
            </li>
          </ol>
        </nav>
      </div>

      <RunStopPanel
        entered={entered}
        ghost={ghost}
        headingRef={headingRef}
        key={key}
        track={current}
      />

      {lane.length === 0 ? (
        <p className="run-plain">Nothing more from here.</p>
      ) : (
        <nav aria-label="Next">
          <ul className="run-branches">
            {lane.map((branch, position) => (
              <li key={`${branch.kind}-${trackKey(branch.track, position)}`}>
                <RunBranchControl branch={branch} position={position} />
              </li>
            ))}
          </ul>
        </nav>
      )}

      <p aria-live="polite" className="sr-only">
        {billing(current)}
      </p>
    </main>
  );
}
