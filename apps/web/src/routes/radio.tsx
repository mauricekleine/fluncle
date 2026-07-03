import {
  ArrowsOutIcon,
  CircleNotchIcon,
  ClosedCaptioningIcon,
  GearSixIcon,
  InfoIcon,
  SpeakerSimpleHighIcon,
  SpeakerSimpleSlashIcon,
} from "@phosphor-icons/react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { siSpotify } from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { siteUrl } from "@/lib/fluncle-links";
import { formatDateLong } from "@/lib/format";
import { activeSliceForOffset } from "@/lib/observation-slices";
import { videoClipCrop, videoCrop, videoCropPoster, videoVersion } from "@/lib/media";
import {
  breatherDimAt,
  OFFSET_SNAP_GRID_MS,
  radioBoundaryDecision,
  SEGMENT_FLOOR_MS,
  snapOffsetMs,
} from "@/lib/radio-schedule";
import { fetchRadioNowPlaying, type RadioNowPlaying, type Track } from "@/lib/tracks";
import {
  bothReadyToStart,
  type RadioPhase,
  radioPhaseOnReady,
  useScreenWakeLock,
} from "@/lib/use-radio-sync-controller";
import { DESKTOP_QUERY, useMediaQuery } from "@/lib/use-media-query";
import { useVideoStallRecovery } from "@/lib/use-video-recovery";

// radio.fluncle.com — ONE synchronized run of Fluncle's Findings (RFC
// radio-broadcast.md). Not a per-client shuffle: a single server-authoritative
// loop every listener computes their place in and drops into mid-flight. Each
// finding's CLEAN footage runs silent under its spoken observation, then on to the
// next, forever; the only sound is the recovered observation (the first HEARD
// surface). The audio IS the clock — the video loops silently underneath and is
// never seek-aligned. The host rewrite in router.tsx serves this at
// radio.fluncle.com/ (mirrors galaxy).

const title = "Fluncle, observing";
const description =
  "Drum & bass bangers from another dimension. One continuous run of Fluncle's findings, each one playing under the observation he logged when he got there.";

// Fluncle's voice, recovered-log register (copywriting-fluncle, VOICE.md §5):
// in-fiction, no banned identity words (NEVER broadcast/station/tune in/live —
// the retired radio-operator metaphor), no exclamation marks, warm and dry.
const COPY = {
  // The begin-gate. The control is "Begin"; the subtitle says what this is — one
  // continuous run you drop into mid-flight (the one UI truth synchronization
  // adds, expressed in-fiction, never as a status widget).
  beginSubtitle: "One continuous run of findings. You drop in mid-flight, wherever I've got to.",
  // Nothing radio-eligible yet (or the run gave out).
  empty: "Nothing logged out here yet. Quiet sector tonight.",
  // While the next finding's assets load, or while catching up to the run.
  loading: "Catching up to the run.",
  // The loading label on the Begin button while the stream buffers in the
  // background — the gate stays up until the picture and the observation can start
  // together, so captions never roll over a black loading screen. Reuses the
  // COPY.loading register verbatim (the two loading states speak in one voice);
  // NEVER the retired radio-operator metaphor (broadcast / station / tune in / live).
  tuning: "Catching up to the run…",
} as const;

// The hard ceiling on the "tuning" hold. The play effect opens the gate the
// instant both elements can play through (the SAME `startBoth` readiness the sync
// controller uses), so this only fires when a browser under-reports
// `canplaythrough` and the coarser `canplay` fallback never lands either. Past it
// we enter "playing" anyway — the video-stall watchdog still covers a genuinely
// wedged stream, and a slightly-early entry beats hanging on the gate forever.
const TUNING_MAX_WAIT_MS = 6_000;

// Resync ladder (RFC §2.5 / Decision #4). The audio currentTime is checked
// against the locally-computed expected offset; small drift rides (a hard seek is
// a worse glitch than the drift on a lean-back voice run), medium drift nudges the
// rate, large drift / a tab-return / a schedule change hard-seeks.
const RIDE_MS = 250; // < this: let it ride (imperceptible).
const HARD_SEEK_MS = 2000; // > this: hard-seek (treat as a fresh join).
const SOFT_CORRECT_RATE = 1.03; // the brief nudge for medium drift.
// Poll the server clock to refresh skew + catch a catalogue change. Findings are
// SHORT (some floored to 3s) and turn over far faster than this poll, so the poll
// is NOT what advances findings — the schedule-clock controller (below) is. This
// cadence only refreshes skew and catches a catalogue change between segments.
const SKEW_POLL_MS = 45_000;
// The schedule-clock controller tick (Bug A). Findings advance from the SHARED
// CLOCK, not the audio element's `ended`: every tick recomputes the boundary
// decision off the segment's shared-clock anchor. Fast enough that a short
// finding's boundary is honoured promptly, cheap enough to also drive the breather
// dim. This is the heartbeat that makes the seam clock-driven (advance), keeps it
// from flickering (hysteresis), and self-heals a wedged surface (resync).
const CONTROLLER_TICK_MS = 200;

export const Route = createFileRoute("/radio")({
  component: RadioPage,
  head: () => ({
    links: [{ href: `${siteUrl}/radio`, rel: "canonical" }],
    meta: [
      { title },
      { content: description, name: "description" },
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: `${siteUrl}/radio`, property: "og:url" },
      { content: "summary_large_image", name: "twitter:card" },
    ],
  }),
});

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Build the orientation-cropped, audio-stripped silent video URL for a finding.
 * `startSeconds` (a fresh join, mid-segment) clips the master to begin AT the
 * snapped offset (the fast offset-join); omitted (a scheduled transition from the
 * head, or the steady-state loop) requests the warm, shared looping crop.
 */
function silentVideoUrl(track: Track, desktop: boolean, startSeconds?: number): string | undefined {
  // Radio draws its OWN chrome, so it only plays a finding with a clean square
  // master (eligibility guarantees videoSquaredAt is set) — a centre-crop to the
  // viewport orientation, audio stripped so the only sound is the observation.
  if (!track.logId || !track.videoSquaredAt) {
    return undefined;
  }

  const orientation = desktop ? "landscape" : "portrait";
  // The video vintage as the `?v` token — a re-render bumps videoSquaredAt, so MT
  // derives off the new master (media.ts).
  const version = videoVersion(track.videoSquaredAt);

  // ONE combined transform (crop + audio-strip [+ clip]), never nested — see media.ts.
  return startSeconds && startSeconds > 0
    ? videoClipCrop(track.logId, orientation, startSeconds, undefined, 60, version)
    : videoCrop(track.logId, orientation, undefined, true, version);
}

/** The cheap cropped poster frame at the join offset (0 for a head start). */
function silentPosterUrl(track: Track, desktop: boolean, atSeconds = 0): string | undefined {
  if (!track.logId || !track.videoSquaredAt) {
    return undefined;
  }

  return videoCropPoster(
    track.logId,
    desktop ? "landscape" : "portrait",
    undefined,
    atSeconds,
    videoVersion(track.videoSquaredAt),
  );
}

type Playhead = {
  // Whether this segment was JOINED mid-flight (clip at the snapped offset) or
  // entered from the head (a scheduled transition / first finding from offset 0).
  joinedMidSegment: boolean;
  offsetMs: number;
  // The segment's scheduled START in the (skew-corrected) SERVER clock — the single
  // anchor the controller derives the boundary decision and the breather dim from.
  // A scheduled advance sets the next segment's start to `thisStart + segMs` (NOT
  // `Date.now()`), so the shared timeline stays exact and every client agrees.
  segmentStartServerMs: number;
  track: Track;
};

/** The floored, real-or-fallback observation length for a finding (ms). */
function trackSegmentMs(track: Track): number {
  const raw = track.observationDurationMs;

  return typeof raw === "number" && raw >= SEGMENT_FLOOR_MS ? raw : SEGMENT_FLOOR_MS;
}

// Synced observation captions, redesigned as Fluncle NARRATING LIVE, center-stage
// (RFC radio-broadcast.md / the operator's center-stage ask): not the whole
// transcript as a bottom-anchored subtitle strip, but ONE slice at a time, big and
// centered over the footage. The script is split into sequential slices (sentence
// units, long sentences chunked into bounded phrase windows — see
// lib/observation-slices.ts); only the slice containing the currently-spoken word
// is on screen. Within that slice the CURRENT word is lit (the Gold heat), carried
// over verbatim from the old per-word treatment. When the spoken word reaches a
// slice's last word, the next tick swaps to the next slice with its first word lit
// — a soft cross-fade keyed on sliceIndex, instant under reduced motion. All of it
// reads off the SAME shared-clock offset the audio resyncs to (not raw
// audio.currentTime — so the captions stay aligned through resyncs and while
// muted). Absent alignment ⇒ the component renders nothing (no captions).
function RadioCaptions({
  segmentStartServerMs,
  serverNow,
  words,
}: {
  segmentStartServerMs: number;
  serverNow: () => number;
  words: { endMs: number; startMs: number; text: string }[];
}) {
  // The live slice + the lit word within it, recomputed each frame off the shared
  // clock. The whole result is derived (pure function), so a single state holds it.
  const [view, setView] = useState(() => activeSliceForOffset(words, -1));

  useEffect(() => {
    if (words.length === 0) {
      return;
    }

    let frame = 0;

    const tick = () => {
      setView(activeSliceForOffset(words, serverNow() - segmentStartServerMs));
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frame);
  }, [words, segmentStartServerMs, serverNow]);

  if (words.length === 0) {
    return undefined;
  }

  const slice = view.slices[view.sliceIndex];

  if (!slice) {
    return undefined;
  }

  return (
    <div className="radio-narration">
      {/* The full observation script, exposed once to assistive tech (the visible
          layer is a fast per-slice swap that would be noisy as a live region). Keeps
          the spoken text reachable for screen readers — it is not announced live. */}
      <p className="sr-only">{words.map((word) => word.text).join(" ")}</p>

      {/* The visible narration: aria-hidden so the per-slice/word animation never
          spams the a11y tree; the sr-only line above carries the read. Keyed on the
          slice index so React mounts a fresh node per slice — the CSS enter animation
          (a soft fade, reduced-motion → instant) plays on the swap. */}
      <p aria-hidden="true" className="radio-narration-line" key={view.sliceIndex}>
        {slice.words.map((word, i) => (
          <span
            className={
              i === view.activeWordInSlice
                ? "radio-narration-word is-active"
                : "radio-narration-word"
            }
            // The script is a fixed, ordered word list; index is a stable key here.
            // oxlint-disable-next-line no-array-index-key
            key={i}
          >
            {word.text}{" "}
          </span>
        ))}
      </p>
    </div>
  );
}

// One row of the settings popover: an interface icon + a sentence-case label that
// labels its Switch (clicking the label toggles it). The icon can track state
// (DESIGN.md Iconography) — the caller passes the glyph for the current value.
function RadioSettingRow({
  checked,
  icon,
  id,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  icon: React.ReactNode;
  id: string;
  label: string;
  onCheckedChange: (next: boolean) => void;
}) {
  return (
    <div className="radio-setting-row">
      <label className="radio-setting-label" htmlFor={id}>
        {icon}
        <span>{label}</span>
      </label>
      <Switch checked={checked} id={id} onCheckedChange={onCheckedChange} />
    </div>
  );
}

// The settings cog + popover. The trigger is the quiet top-right disc (the cog);
// the popover holds the four LOCAL surface preferences. Each Switch is keyboard-
// reachable and labelled; the icons track state where it reads clearer (the speaker
// slashes when muted, the arrows fold in when fullscreen). The cog itself is hidden
// in fullscreen by the caller, so this only renders the windowed control set.
function RadioSettings({
  muted,
  onToggleCaptions,
  onToggleFullscreen,
  onToggleMeta,
  onToggleMuted,
  open,
  setOpen,
  showCaptions,
  showMeta,
}: {
  muted: boolean;
  onToggleCaptions: (next: boolean) => void;
  onToggleFullscreen: (next: boolean) => void;
  onToggleMeta: (next: boolean) => void;
  onToggleMuted: (next: boolean) => void;
  open: boolean;
  setOpen: (next: boolean) => void;
  showCaptions: boolean;
  showMeta: boolean;
}) {
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger aria-label="Surface settings" className="radio-settings-cog">
        <GearSixIcon aria-hidden="true" weight="regular" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="Surface settings"
        className="radio-settings-panel"
        side="bottom"
      >
        <RadioSettingRow
          checked={!muted}
          icon={
            muted ? (
              <SpeakerSimpleSlashIcon aria-hidden="true" weight="fill" />
            ) : (
              <SpeakerSimpleHighIcon aria-hidden="true" weight="regular" />
            )
          }
          id="radio-setting-sound"
          label="Sound"
          // The switch reads as "sound on": checked means audible, so flip mute to
          // its inverse.
          onCheckedChange={(soundOn) => onToggleMuted(!soundOn)}
        />
        <RadioSettingRow
          checked={showCaptions}
          icon={
            <ClosedCaptioningIcon aria-hidden="true" weight={showCaptions ? "fill" : "regular"} />
          }
          id="radio-setting-captions"
          label="Subtitles"
          onCheckedChange={onToggleCaptions}
        />
        <RadioSettingRow
          checked={showMeta}
          icon={<InfoIcon aria-hidden="true" weight={showMeta ? "fill" : "regular"} />}
          id="radio-setting-meta"
          label="Info box"
          onCheckedChange={onToggleMeta}
        />
        <RadioSettingRow
          checked={false}
          icon={
            // Fullscreen is event-driven elsewhere; the popover always renders in the
            // windowed state (the cog is hidden in fullscreen), so the glyph is the
            // "go fullscreen" arrows. The fold-in arrows ship for the rare in-popover
            // fullscreen state.
            <ArrowsOutIcon aria-hidden="true" weight="regular" />
          }
          id="radio-setting-fullscreen"
          label="Fullscreen"
          onCheckedChange={onToggleFullscreen}
        />
      </PopoverContent>
    </Popover>
  );
}

function RadioPage() {
  // The entry phase (RadioPhase, shared with the sync controller). The media
  // elements mount once we leave "idle", so they buffer during "tuning"; the
  // visible radio only shows in "playing".
  const [phase, setPhase] = useState<RadioPhase>("idle");
  // The schedule clock + media effects run from the first gesture onward (both
  // "tuning" and "playing") so the slot resolves and the gated start can buffer.
  const started = phase !== "idle";
  // The finding on the surface + the offset it was placed at (undefined until the
  // first slot resolves).
  const [playhead, setPlayhead] = useState<Playhead | undefined>(undefined);
  // The preloaded NEXT finding (from the schedule) — always plays from its head.
  const [next, setNext] = useState<Track | undefined>(undefined);
  // No finding could be played (empty eligible set, or a broken run).
  const [exhausted, setExhausted] = useState(false);
  // LOCAL surface preferences (not part of the shared schedule): the top-right cog
  // opens a settings popover that flips each of these. `muted` silences the
  // observation (the audio element mirrors it); `showCaptions` / `showMeta` hide the
  // narration and the bottom-left now-playing block. They default to their current
  // visibility (audible, captioned, meta shown), so an untouched join looks exactly
  // as it did before the cog existed. The point: a clean, silent, chrome-free frame
  // to pull into a live mixtape set on a side screen.
  const [muted, setMuted] = useState(false);
  const [showCaptions, setShowCaptions] = useState(true);
  const [showMeta, setShowMeta] = useState(true);
  // Whether the settings popover is open. Closed when we enter fullscreen so the
  // frame is clean (and the cog — its trigger — unmounts there anyway).
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Are we fullscreen? Driven by the `fullscreenchange` event, never guessed — so
  // the browser's native Escape exit is the single source of truth. In fullscreen
  // the cog hides; pressing Escape exits fullscreen, which re-shows the cog.
  const [isFullscreen, setIsFullscreen] = useState(false);

  // The desktop verdict drives the crop orientation: landscape on desktop,
  // portrait on mobile. `false` on the server / first paint, then the live verdict.
  const isDesktop = useMediaQuery(DESKTOP_QUERY);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // The clock skew (serverEpochMs − clientReceiveMs, smoothed): the client
  // computes its own expected offset from `Date.now() + skew` between polls.
  const skewMsRef = useRef<number>(0);
  // The next preloaded finding, read without re-subscribing.
  const nextRef = useRef<Track | undefined>(undefined);
  nextRef.current = next;
  // The on-screen playhead, read inside the controller tick / event handlers
  // without re-subscribing the effect each advance.
  const playheadRef = useRef<Playhead | undefined>(undefined);
  playheadRef.current = playhead;
  // The current breather dim level (0 clear … 1 full black), driven by the
  // controller off the shared-clock offset. A ref so the rAF/interval tick writes
  // it cheaply; mirrored into CSS via a state-free style write on the overlay.
  const breatherRef = useRef<HTMLDivElement | null>(null);
  // Whether the gated A/V start has opened for the CURRENT segment (the audio is
  // playing). The audio effect sets it; a small video effect reads it so an
  // orientation flip (which remounts the `<video key={videoUrl}>`) re-plays the
  // fresh element without re-seeking the already-running audio. Reset per segment.
  const avStartedRef = useRef(false);

  // The client's server-clock now: Date.now() corrected by the smoothed skew. The
  // ONE source of truth the controller, the breather, and the resync ladder all
  // read — so the surface advances from the schedule clock, never the media element.
  const serverNow = useCallback(() => Date.now() + skewMsRef.current, []);

  // Resolve the authoritative now-playing slot from the server, refresh the clock
  // skew (NTP-lite), and place the playhead at the returned offset, anchoring the
  // segment's shared-clock START. `fromHead` forces a head-start (a scheduled
  // transition rolling onto the next segment), overriding the server's mid-segment
  // offset for an already-watching client.
  const resolveSlot = useCallback(
    async (fromHead = false): Promise<RadioNowPlaying | undefined> => {
      const sentAt = Date.now();
      const slot = await fetchRadioNowPlaying();
      const receivedAt = Date.now();
      // NTP-lite: server time at response build, corrected by half the round-trip.
      const sample = slot.serverEpochMs + (receivedAt - sentAt) / 2 - receivedAt;
      // Smooth across polls to reject jitter (a light EMA; the first sample seeds it).
      skewMsRef.current = skewMsRef.current === 0 ? sample : skewMsRef.current * 0.7 + sample * 0.3;

      const offsetMs = fromHead ? 0 : slot.offsetMs;

      setExhausted(false);
      setPlayhead({
        joinedMidSegment: !fromHead && slot.offsetMs > 0,
        offsetMs,
        // Anchor: where, in the shared server clock, this segment began.
        segmentStartServerMs: Date.now() + skewMsRef.current - offsetMs,
        track: slot.currentTrack,
      });
      setNext(slot.nextTrack);

      return slot;
    },
    [],
  );

  // Advance to the NEXT finding at a segment boundary (Bug A: this is called by the
  // schedule-clock controller, NOT the media element's `ended`). Roll onto the
  // preloaded next finding if it's ready (the smooth scheduled transition), else
  // re-resolve from the server. The next segment's shared-clock start is the
  // PREVIOUS start + the previous observation length — deterministic, so every
  // client lands the boundary at the same instant and no client drifts a segment.
  // NEVER a random skip — on trouble we resync to the schedule.
  const advance = useCallback(async () => {
    const current = playheadRef.current;
    const preloaded = nextRef.current;
    nextRef.current = undefined;
    setNext(undefined);

    if (current && preloaded) {
      const nextStart = current.segmentStartServerMs + trackSegmentMs(current.track);

      setExhausted(false);
      setPlayhead({
        joinedMidSegment: false,
        offsetMs: 0,
        segmentStartServerMs: nextStart,
        track: preloaded,
      });
      // Re-resolve in the background to refresh the next preload + the skew, but
      // keep the smooth head-start we already painted.
      void resolveSlot(true).catch(() => {
        // Harmless — the controller re-evaluates and the poll re-syncs.
      });

      return;
    }

    // No preloaded next (single-finding loop, or a dropped preload) → re-ask the
    // server for the authoritative current slot rather than guessing.
    try {
      await resolveSlot();
    } catch {
      setExhausted(true);
    }
  }, [resolveSlot]);

  // Begin: the first gesture unlocks audio and resolves the synced slot — a fresh
  // joiner lands mid-flight at the server's offset. It enters "tuning" (not
  // "playing"): the media elements mount and buffer in the background while the
  // gate stays up, so the full-screen radio + captions only appear once the stream
  // is genuinely ready (the gated start opens) and everything begins together.
  const begin = useCallback(() => {
    setPhase("tuning");
    void resolveSlot().catch(() => setExhausted(true));
  }, [resolveSlot]);

  // The gated start has opened (both the picture and the observation can play
  // through) → reveal the full-screen radio. Idempotent: only "tuning" advances, so
  // a later re-arm of the start (a fresh segment) never re-triggers the entry.
  const markPlaying = useCallback(() => {
    setPhase(radioPhaseOnReady);
  }, []);

  // The tuning safety net: never hang on the gate. The play effect's `startBoth`
  // flips us to "playing" the moment both elements can play through (its `canplay`
  // fallback already covers browsers that under-report `canplaythrough`); this
  // bounded timer is the last resort if even that never lands, so a wedged buffer
  // can't trap the listener on a loading gate. The video-stall watchdog still
  // covers a genuinely stuck stream once we're in.
  useEffect(() => {
    if (phase !== "tuning") {
      return;
    }

    const id = window.setTimeout(markPlaying, TUNING_MAX_WAIT_MS);

    return () => window.clearTimeout(id);
  }, [phase, markPlaying]);

  // THE SCHEDULE-CLOCK CONTROLLER (Bug A root-cause fix). Findings advance from the
  // SHARED CLOCK, not the audio element's `ended` and not a `loop`. Every tick it
  // (1) computes the boundary decision off the segment's shared-clock anchor —
  // hold / advance / resync — with hysteresis so the seam can't flicker N↔N+1 and a
  // wedge self-heals without a refresh, and (2) drives the deterministic breather
  // dim off the same offset (so every client darkens at the same instant). One
  // re-entrancy guard keeps an in-flight advance/resync from firing twice.
  const busyRef = useRef(false);
  useEffect(() => {
    if (!started || !playhead) {
      return;
    }

    const reducedMotion = prefersReducedMotion();

    const tick = () => {
      const head = playheadRef.current;
      const overlay = breatherRef.current;

      if (!head) {
        return;
      }

      const segMs = trackSegmentMs(head.track);
      const offsetMs = serverNow() - head.segmentStartServerMs;

      // The deterministic breather: opacity is a pure function of the shared-clock
      // offset, identical on every client. Reduced motion stays clear (an instant
      // cut at the same boundary — no fade, still in lockstep).
      if (overlay) {
        overlay.style.opacity = reducedMotion ? "0" : String(breatherDimAt(offsetMs, segMs));
      }

      if (busyRef.current) {
        return;
      }

      const decision = radioBoundaryDecision(head.segmentStartServerMs, segMs, serverNow());

      if (decision === "advance") {
        busyRef.current = true;
        void advance().finally(() => {
          busyRef.current = false;
        });

        return;
      }

      if (decision === "resync") {
        busyRef.current = true;
        void resolveSlot()
          .catch(() => setExhausted(true))
          .finally(() => {
            busyRef.current = false;
          });
      }
    };

    tick();
    const id = window.setInterval(tick, CONTROLLER_TICK_MS);

    return () => window.clearInterval(id);
  }, [started, playhead, advance, resolveSlot, serverNow]);

  // Poll the server clock between segments to refresh skew and catch a catalogue
  // change (a changed scheduleVersion re-fetches the schedule). Advance itself is
  // the controller's job; this poll only corrects drift and catches a rolled
  // catalogue — findings turn over far faster than this cadence.
  useEffect(() => {
    if (!started || !playhead) {
      return;
    }

    const id = window.setInterval(() => {
      void fetchRadioNowPlaying()
        .then((slot) => {
          const sample = slot.serverEpochMs - Date.now();
          skewMsRef.current = skewMsRef.current * 0.7 + sample * 0.3;

          // A grown / re-observed catalogue: the schedule rolled the current finding
          // to a different one than we (and our preload) expect → hard-resync to the
          // new authoritative slot rather than drifting on the stale one.
          const head = playheadRef.current;
          const expectedNext = nextRef.current;
          const serverMovedOn =
            head !== undefined &&
            slot.currentTrack.trackId !== head.track.trackId &&
            slot.currentTrack.trackId !== expectedNext?.trackId;

          if (serverMovedOn && !busyRef.current) {
            busyRef.current = true;
            void resolveSlot()
              .catch(() => undefined)
              .finally(() => {
                busyRef.current = false;
              });
          }
        })
        .catch(() => {
          // A transient failure is harmless — the next poll or the controller re-syncs.
        });
    }, SKEW_POLL_MS);

    return () => window.clearInterval(id);
  }, [started, playhead, resolveSlot]);

  // Mirror the LOCAL mute preference onto the observation element. Kept separate
  // from the playback effect so toggling mute never re-seeks or interrupts the run
  // — it is a volume preference, not a schedule change.
  useEffect(() => {
    const audio = audioRef.current;

    if (audio) {
      audio.muted = muted;
    }
  }, [muted, playhead]);

  // Track fullscreen off the `fullscreenchange` event — the ONE source of truth, so
  // the browser's native Escape exit (which the Fullscreen API owns) flows straight
  // back to "show the cog again". We never run a custom Escape handler that would
  // fight that. Seed from the current state so an already-fullscreen mount is right.
  useEffect(() => {
    const sync = () => setIsFullscreen(Boolean(document.fullscreenElement));

    sync();
    document.addEventListener("fullscreenchange", sync);

    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  // Toggle the whole surface in/out of fullscreen via the Fullscreen API. Entering
  // closes the popover so nothing lingers over the clean frame; the cog (the
  // popover trigger) unmounts in fullscreen and only returns when Escape exits.
  const toggleFullscreen = useCallback((wantFullscreen: boolean) => {
    if (wantFullscreen) {
      setSettingsOpen(false);
      void document.documentElement.requestFullscreen?.().catch(() => {
        // Denied or unsupported — `fullscreenchange` won't fire, so the cog stays.
      });

      return;
    }

    void document.exitFullscreen?.().catch(() => {
      // Already out, or denied — the event listener keeps state honest regardless.
    });
  }, []);

  // THE A/V SYNC + DOUBLE-START FIX. The video (silent loop) and the audio
  // (observation) are two independent elements; left to themselves the lighter
  // video reaches a playable frame first and starts while the audio is still
  // buffering → the audio lags the picture all segment. And the effect's
  // setup → cleanup → setup on a segment transition (and again under StrictMode in
  // dev) fires two overlapping `play()` promises whose race the drift ladder reads
  // as a restart. So a SINGLE gated start: both elements begin together, exactly
  // once per segment, only when BOTH are buffered to `canplaythrough`.
  //
  // The drift-correction ladder is untouched — it just can't run before the gated
  // start opens, so it never corrects against a not-yet-playing element. Advancing
  // findings stays the CONTROLLER's job (off the shared clock); the audio does NOT
  // advance on `ended` and the video never advances on `loop`.
  useEffect(() => {
    const audio = audioRef.current;
    const video = videoRef.current;

    if (!audio || !playhead?.track.observationAudioUrl) {
      return;
    }

    const reducedMotion = prefersReducedMotion();
    const segMs = trackSegmentMs(playhead.track);
    // The shared-clock anchor for this segment (the SAME value the controller and
    // the breather read), so the audio aligns to exactly the broadcast offset.
    const segmentStartServerMs = playhead.segmentStartServerMs;
    const expectedOffsetMs = () => serverNow() - segmentStartServerMs;

    // Seek to the offset before playing — align the audio to the shared offset.
    audio.currentTime = Math.max(0, Math.min(playhead.offsetMs, segMs)) / 1000;
    audio.playbackRate = 1;

    // The one-shot start guard. `play()` (video + audio) fires EXACTLY ONCE per
    // segment — this is what defeats the StrictMode/cleanup double-fire that
    // produced the "restart". Once started, the readiness listeners stand down.
    let started = false;
    // A fresh segment begins not-yet-started (the video effect reads this ref).
    avStartedRef.current = false;

    const startBoth = () => {
      if (started) {
        return;
      }

      // Hold until BOTH elements can play through (reduced motion waits on the
      // audio alone — the video won't play, the poster holds), so the picture and
      // the observation begin locked together instead of the video out-running it.
      if (!bothReadyToStart({ audio, reducedMotion, video })) {
        return;
      }

      started = true;
      avStartedRef.current = true;

      // The stream is genuinely ready — open the entry gate (a no-op once already
      // "playing"). The full-screen radio + captions appear now, locked to the
      // first frame and the first spoken word, never over a black loading screen.
      markPlaying();

      if (reducedMotion) {
        // Reduced motion holds the offset poster (no looping motion); only the
        // observation plays — the lean-back point survives.
        video?.pause();
      } else {
        video?.play().catch(() => {
          // Autoplay denied (the video is muted, so this is rare) — the poster
          // frame stands in; the audio still starts so the run is never silent.
        });
      }

      audio.play().catch(() => {
        // Playback denied or the object died — resync rather than stall.
        void resolveSlot().catch(() => setExhausted(true));
      });
    };

    const onError = () => {
      // RESYNC, don't skip: a random skip on a synchronized surface desyncs this
      // client forever. Re-resolve the authoritative slot.
      void resolveSlot().catch(() => setExhausted(true));
    };

    // The resync ladder: nudge toward the expected offset without audible re-seeks
    // for jitter, but guarantee convergence after a sleep. Past the segment end the
    // controller owns the boundary, so the ladder only corrects WITHIN the segment.
    const onTimeUpdate = () => {
      // The ladder only corrects an element that has actually started — never
      // against a not-yet-playing one (which would seek before the gate opens).
      if (!started) {
        return;
      }

      const expected = expectedOffsetMs();

      if (expected >= segMs) {
        return; // at/past the end — leave the boundary to the controller.
      }

      const drift = audio.currentTime * 1000 - expected;
      const abs = Math.abs(drift);

      if (abs <= RIDE_MS) {
        if (audio.playbackRate !== 1) {
          audio.playbackRate = 1;
        }

        return;
      }

      if (abs <= HARD_SEEK_MS) {
        // Behind the expected offset → speed up; ahead → ease down.
        audio.playbackRate = drift < 0 ? SOFT_CORRECT_RATE : 1 / SOFT_CORRECT_RATE;

        return;
      }

      // Large drift → hard-seek to the expected offset (a fresh-join correction).
      audio.playbackRate = 1;
      const target = Math.min(expected, segMs) / 1000;

      if (target >= 0) {
        audio.currentTime = target;
      }
    };

    // A backgrounded tab is throttled and returns seconds off. On return: if the
    // gated start hasn't opened yet (the tab was hidden through the buffer), try
    // it now; otherwise hard-seek the audio to the shared offset if still
    // mid-segment (past the end, leave the boundary to the controller).
    const onVisible = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      if (!started) {
        startBoth();

        return;
      }

      const target = expectedOffsetMs();

      if (target >= segMs) {
        return;
      }

      audio.playbackRate = 1;
      audio.currentTime = Math.max(0, target) / 1000;
    };

    audio.addEventListener("error", onError);
    audio.addEventListener("timeupdate", onTimeUpdate);
    document.addEventListener("visibilitychange", onVisible);
    // The readiness gate: each element signals when it can play through, and
    // `startBoth` fires the one-shot start the first tick BOTH are ready. `canplay`
    // is a coarser fallback so a browser that under-reports `canplaythrough` still
    // opens the gate once it has the current frame.
    audio.addEventListener("canplaythrough", startBoth);
    audio.addEventListener("canplay", startBoth);
    video?.addEventListener("canplaythrough", startBoth);
    video?.addEventListener("canplay", startBoth);

    // Already-warm elements (a preloaded next finding handed off at the seam) may
    // have buffered before the listeners attached and will fire no further event —
    // attempt the gated start immediately so they don't wait for one.
    startBoth();

    return () => {
      audio.removeEventListener("error", onError);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      document.removeEventListener("visibilitychange", onVisible);
      audio.removeEventListener("canplaythrough", startBoth);
      audio.removeEventListener("canplay", startBoth);
      video?.removeEventListener("canplaythrough", startBoth);
      video?.removeEventListener("canplay", startBoth);
      audio.pause();
    };
  }, [playhead, resolveSlot, serverNow, markPlaying]);

  // Orientation re-attach. An orientation flip changes `videoUrl`, which remounts
  // the `<video key={videoUrl}>` — a FRESH element the audio effect (keyed on
  // playhead, not orientation) won't re-play. So once the segment's gated start has
  // already opened, re-play the new element here, without touching the running
  // audio (no re-seek). Before the gate opens, the audio effect's listeners own the
  // start; reduced motion pauses (the poster holds). This is silent, seek-agnostic
  // loop video — re-playing it is harmless.
  useEffect(() => {
    const video = videoRef.current;

    if (!video || !playhead || !avStartedRef.current) {
      return;
    }

    if (prefersReducedMotion()) {
      video.pause();

      return;
    }

    video.play().catch(() => {
      // Autoplay denied — the poster frame stands in.
    });
  }, [playhead, isDesktop]);

  // The silent looping crop for the current playhead, derived once so both the
  // stall watchdog (an unconditional hook, above the early returns) and the render
  // read the same URL. `undefined` until a playhead resolves.
  const joinSnapSeconds =
    playhead && playhead.joinedMidSegment
      ? snapOffsetMs(playhead.offsetMs, OFFSET_SNAP_GRID_MS) / 1000
      : 0;
  const videoUrl = playhead
    ? silentVideoUrl(playhead.track, isDesktop, joinSnapSeconds)
    : undefined;

  // The video stall watchdog. The radio video carries no sound (the observation
  // is the clock), but a STUCK silent loop freezes the stage on its poster with
  // no `error` event — so the `onError` resync never fires. First wedge re-arms
  // the load (a cold-MISS clip often warms on a retry); a persistent wedge resyncs
  // to the schedule, which re-resolves to the warm steady-state crop. Reduced
  // motion intentionally holds the poster, so the watchdog stands down there.
  const videoStalledRef = useRef(false);
  const recoverStuckVideo = useCallback(() => {
    const video = videoRef.current;

    if (!videoStalledRef.current && video) {
      videoStalledRef.current = true;
      video.load();
      video.play().catch(() => {});

      return;
    }

    videoStalledRef.current = false;
    void resolveSlot().catch(() => setExhausted(true));
  }, [resolveSlot]);

  useEffect(() => {
    videoStalledRef.current = false;
  }, [videoUrl]);

  useVideoStallRecovery({
    expectsPlayback: started && Boolean(videoUrl) && !prefersReducedMotion(),
    onStall: recoverStuckVideo,
    src: videoUrl,
    videoRef,
  });

  // Keep the screen awake for the lean-back run: hold the Screen Wake Lock while a
  // finding is on the surface (the observation is audible even under reduced motion
  // and even when muted — a muted but running run still warrants the screen), and
  // drop it when the run gives out or the gate hasn't been crossed. Feature-detected
  // and self-healing across tab-backgrounding inside the hook.
  useScreenWakeLock(started && !exhausted && Boolean(playhead));

  // Whether we're still tuning in: the gesture has fired and the media is buffering
  // in the background, but the gate stays up until the gated start opens (or the
  // max-wait fallback fires). The visible radio chrome is held back until "playing".
  const tuning = phase === "tuning";

  if (phase === "idle") {
    return <BeginGate onBegin={begin} />;
  }

  // The run gave out — surface it over the gate, whatever phase we were in.
  if (exhausted) {
    return <RadioMessage wayBack>{COPY.empty}</RadioMessage>;
  }

  // Tuning before the first slot resolves: the gate stays up with its loading
  // button; no media to mount yet, so just hold the loading gate.
  if (!playhead) {
    return <BeginGate loading onBegin={begin} />;
  }

  const current = playhead.track;
  // `videoUrl` and `joinSnapSeconds` are derived above the early returns (the stall
  // watchdog reads the same URL). A mid-segment join snaps the poster to the cache
  // grid like the clip; a head start (offset 0) takes the opening frame.
  const posterUrl = silentPosterUrl(current, isDesktop, joinSnapSeconds);
  const observationUrl = current.observationAudioUrl;
  // The schedule's next finding always plays from its head, so preload the warm
  // steady-state crop (not a time= clip) — we know it WILL play and WHEN.
  const nextVideoUrl = next ? silentVideoUrl(next, isDesktop) : undefined;

  return (
    <main className="radio-stage">
      <h1 className="sr-only">{title}</h1>

      {videoUrl ? (
        <video
          aria-hidden="true"
          className="radio-footage"
          // A broken video resyncs to the schedule rather than skipping randomly.
          key={videoUrl}
          loop
          muted
          onError={() => void resolveSlot().catch(() => setExhausted(true))}
          playsInline
          poster={posterUrl}
          preload="auto"
          ref={videoRef}
          src={videoUrl}
        />
      ) : (
        // Eligibility guarantees a square master, so this is only reached if the
        // logId is somehow absent — resync rather than show a blank stage.
        <RadioMessage>{COPY.loading}</RadioMessage>
      )}

      {/* The visible radio chrome only mounts once we're PLAYING. While tuning the
          media buffers underneath (above) but the captions / meta / breather stay
          held back so nothing rolls over a black loading screen; the gate overlay
          (below) carries the loading state instead. */}
      {!tuning ? (
        <>
          {/* The deterministic breather (Feature B): a full-black overlay whose
              opacity the controller writes each tick from breatherDimAt(offset) —
              fade-out into the seam, a beat of black, fade-in on the new clip. Timed
              off the SHARED clock, so every client darkens together; instant (no
              fade) under reduced motion, still at the same boundary. */}
          <div aria-hidden="true" className="radio-breather" ref={breatherRef} />

          <div aria-hidden="true" className="radio-scrim" />

          {/* Fluncle narrating, center-stage: one slice of the observation at a
              time, big and centered over the footage, the live word lit (Gold heat).
              Reads off the shared-clock offset, so it stays aligned through resyncs
              and while muted. Absent alignment ⇒ renders nothing. */}
          {showCaptions &&
          current.observationAlignment &&
          current.observationAlignment.words.length > 0 ? (
            <RadioCaptions
              segmentStartServerMs={playhead.segmentStartServerMs}
              serverNow={serverNow}
              words={current.observationAlignment.words}
            />
          ) : undefined}

          {/* The settings cog (top-right): a single quiet disc that opens a popover
              of LOCAL surface preferences (none part of the shared schedule) — mute
              the observation, hide the captions, hide the now-playing block, and go
              fullscreen. In fullscreen the whole control unmounts, so the frame is
              just the footage; Escape exits fullscreen and the cog returns. */}
          {!isFullscreen ? (
            <RadioSettings
              muted={muted}
              onToggleFullscreen={toggleFullscreen}
              onToggleMeta={setShowMeta}
              onToggleMuted={setMuted}
              onToggleCaptions={setShowCaptions}
              open={settingsOpen}
              setOpen={setSettingsOpen}
              showCaptions={showCaptions}
              showMeta={showMeta}
            />
          ) : undefined}

          {showMeta ? (
            <div className="radio-meta">
              {current.logId ? <span className="radio-log-id">{current.logId}</span> : undefined}
              <h2 className="radio-title">{current.title}</h2>
              <p className="radio-artist">{current.artists.join(", ")}</p>
              <p className="radio-facts">
                {[
                  current.label,
                  current.releaseDate ? formatDateLong(current.releaseDate) : undefined,
                  current.bpm ? `${current.bpm} BPM` : undefined,
                  current.key,
                  current.galaxy?.name,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <div className="radio-actions">
                {current.logPageUrl ? (
                  <Button
                    nativeButton={false}
                    render={<a href={current.logPageUrl} />}
                    size="sm"
                    variant="outline"
                  >
                    View the log
                  </Button>
                ) : undefined}
                <Button
                  nativeButton={false}
                  render={<a href={current.spotifyUrl} rel="noreferrer" target="_blank" />}
                  size="sm"
                  variant="outline"
                >
                  <BrandIcon icon={siSpotify} />
                  Listen on Spotify
                </Button>
              </div>
            </div>
          ) : undefined}
        </>
      ) : undefined}

      {/* While tuning, the begin-gate stays up OVER the buffering media (a disabled
          loading button), so the listener sees we're setting things up rather than a
          black screen with captions already rolling. A presentational div (not a
          nested <main>) overlaying the stage — the .radio-gate backdrop is opaque,
          so it fully covers the buffering picture. */}
      {tuning ? (
        <div className="radio-gate">
          {/* Styled like the gate title but a <p>, not a second <h1> — the stage's
              sr-only <h1> above is the page heading. */}
          <p className="radio-gate-title">{title}</p>
          <p className="radio-gate-subtitle">{COPY.beginSubtitle}</p>
          <Button aria-busy disabled size="lg">
            <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
            {COPY.tuning}
          </Button>
        </div>
      ) : undefined}

      {/* The observation: its own audio artifact, seeked to the join offset and
          played over the looping silent video. Hidden; the schedule-clock
          controller advances at the boundary (NOT this element's `ended`). */}
      {observationUrl ? (
        <audio key={observationUrl} preload="auto" ref={audioRef} src={observationUrl}>
          <track kind="captions" />
        </audio>
      ) : undefined}

      {/* Hidden preload of the NEXT scheduled finding (from its head) for an
          instant hand-off — preload="auto" because we know it plays, and when. */}
      <div aria-hidden="true" className="sr-only">
        {nextVideoUrl ? <video muted playsInline preload="auto" src={nextVideoUrl} /> : undefined}
        {next?.observationAudioUrl ? (
          <audio preload="auto" src={next.observationAudioUrl}>
            <track kind="captions" />
          </audio>
        ) : undefined}
      </div>
    </main>
  );
}

// The begin-gate. `loading` is the tuning-in state: the gesture has fired and the
// stream is buffering, so the control shows a spinner + COPY.tuning and is disabled
// until the gated start opens (the gate then gives way to the full-screen radio).
// When tuning, it overlays the buffering media, so it owns its own backdrop (the
// .radio-gate is opaque) — the listener sees we're setting things up, never a black
// screen with captions already rolling.
function BeginGate({ loading = false, onBegin }: { loading?: boolean; onBegin: () => void }) {
  return (
    <main className="radio-gate">
      <h1 className="radio-gate-title">{title}</h1>
      <p className="radio-gate-subtitle">{COPY.beginSubtitle}</p>
      <Button aria-busy={loading} disabled={loading} onClick={onBegin} size="lg">
        {loading ? (
          <>
            <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
            {COPY.tuning}
          </>
        ) : (
          "Begin"
        )}
      </Button>
    </main>
  );
}

function RadioMessage({
  children,
  wayBack = false,
}: {
  children: React.ReactNode;
  wayBack?: boolean;
}) {
  return (
    <main className="radio-gate">
      <h1 className="sr-only">{title}</h1>
      <p className="radio-gate-subtitle" role="status">
        {children}
      </p>
      {/* A lean-back surface still needs a door out when there's nothing to
          play: back to the archive or the full log. */}
      {wayBack ? (
        <div className="radio-actions">
          <Button nativeButton={false} render={<Link to="/" />} size="sm" variant="outline">
            Back to the archive
          </Button>
          <Button nativeButton={false} render={<Link to="/log" />} size="sm" variant="outline">
            Browse the log
          </Button>
        </div>
      ) : undefined}
    </main>
  );
}
