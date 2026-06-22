import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { siSpotify } from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";
import { Button } from "@/components/ui/button";
import { siteUrl } from "@/lib/fluncle-links";
import { formatDateLong } from "@/lib/format";
import { videoClipCrop, videoCrop, videoCropPoster } from "@/lib/media";
import { OFFSET_SNAP_GRID_MS, SEGMENT_FLOOR_MS, snapOffsetMs } from "@/lib/radio-schedule";
import { fetchRadioNowPlaying, type RadioNowPlaying, type Track } from "@/lib/tracks";
import { DESKTOP_QUERY, useMediaQuery } from "@/lib/use-media-query";

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
} as const;

// Resync ladder (RFC §2.5 / Decision #4). The audio currentTime is checked
// against the locally-computed expected offset; small drift rides (a hard seek is
// a worse glitch than the drift on a lean-back voice run), medium drift nudges the
// rate, large drift / a tab-return / a schedule change hard-seeks.
const RIDE_MS = 250; // < this: let it ride (imperceptible).
const HARD_SEEK_MS = 2000; // > this: hard-seek (treat as a fresh join).
const SOFT_CORRECT_RATE = 1.03; // the brief nudge for medium drift.
// Poll the server clock to refresh skew + catch a catalogue change. The boundary
// re-fetch (on `ended`) doubles as a resync; this is the between-segments cadence.
const SKEW_POLL_MS = 45_000;

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

  // ONE combined transform (crop + audio-strip [+ clip]), never nested — see media.ts.
  return startSeconds && startSeconds > 0
    ? videoClipCrop(track.logId, orientation, startSeconds)
    : videoCrop(track.logId, orientation, undefined, true);
}

/** The cheap cropped poster frame at the join offset (0 for a head start). */
function silentPosterUrl(track: Track, desktop: boolean, atSeconds = 0): string | undefined {
  if (!track.logId || !track.videoSquaredAt) {
    return undefined;
  }

  return videoCropPoster(track.logId, desktop ? "landscape" : "portrait", undefined, atSeconds);
}

/** The floored, real-or-fallback segment length for a finding (ms). */
function segmentMs(track: Track): number {
  const raw = track.observationDurationMs;

  return typeof raw === "number" && raw >= SEGMENT_FLOOR_MS ? raw : SEGMENT_FLOOR_MS;
}

type Playhead = {
  // Whether this segment was JOINED mid-flight (clip at the snapped offset) or
  // entered from the head (a scheduled transition / first finding from offset 0).
  joinedMidSegment: boolean;
  offsetMs: number;
  track: Track;
};

function RadioPage() {
  // The begin-gate: false until the first user gesture unlocks audible audio.
  const [started, setStarted] = useState(false);
  // The finding on the surface + the offset it was placed at (undefined until the
  // first slot resolves).
  const [playhead, setPlayhead] = useState<Playhead | undefined>(undefined);
  // The preloaded NEXT finding (from the schedule) — always plays from its head.
  const [next, setNext] = useState<Track | undefined>(undefined);
  // No finding could be played (empty eligible set, or a broken run).
  const [exhausted, setExhausted] = useState(false);

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

  // Resolve the authoritative now-playing slot from the server, refresh the clock
  // skew (NTP-lite), and place the playhead at the returned offset. `fromHead`
  // forces a head-start (a scheduled transition rolling onto the next segment),
  // overriding the server's mid-segment offset for an already-watching client.
  const resolveSlot = useCallback(
    async (fromHead = false): Promise<RadioNowPlaying | undefined> => {
      const sentAt = Date.now();
      const slot = await fetchRadioNowPlaying();
      const receivedAt = Date.now();
      // NTP-lite: server time at response build, corrected by half the round-trip.
      const sample = slot.serverEpochMs + (receivedAt - sentAt) / 2 - receivedAt;
      // Smooth across polls to reject jitter (a light EMA; the first sample seeds it).
      skewMsRef.current = skewMsRef.current === 0 ? sample : skewMsRef.current * 0.7 + sample * 0.3;

      setExhausted(false);
      setPlayhead({
        joinedMidSegment: !fromHead && slot.offsetMs > 0,
        offsetMs: fromHead ? 0 : slot.offsetMs,
        track: slot.currentTrack,
      });
      setNext(slot.nextTrack);

      return slot;
    },
    [],
  );

  // Advance at a segment boundary: roll onto the preloaded next finding from its
  // HEAD if it's ready (the smooth scheduled transition), else re-resolve from the
  // server. A broken run gives up to the empty state. NEVER a random skip — that
  // would desync this one client forever; on trouble we resync to the schedule.
  const advance = useCallback(async () => {
    const preloaded = nextRef.current;
    nextRef.current = undefined;
    setNext(undefined);

    if (preloaded) {
      setExhausted(false);
      setPlayhead({ joinedMidSegment: false, offsetMs: 0, track: preloaded });
      // Re-resolve in the background to refresh the next preload + the skew, but
      // keep the smooth head-start we already painted.
      void resolveSlot(true).catch(() => {
        // Harmless — the boundary re-fetch already placed the head-start.
      });

      return;
    }

    try {
      await resolveSlot(true);
    } catch {
      setExhausted(true);
    }
  }, [resolveSlot]);

  // Begin: the first gesture unlocks audio and resolves the synced slot — a fresh
  // joiner lands mid-flight at the server's offset.
  const begin = useCallback(() => {
    setStarted(true);
    void resolveSlot().catch(() => setExhausted(true));
  }, [resolveSlot]);

  // Poll the server clock between segments to refresh skew and catch a catalogue
  // change (a changed scheduleVersion re-fetches the schedule). The boundary
  // re-fetch on `ended` is the other resync point.
  useEffect(() => {
    if (!started || !playhead) {
      return;
    }

    const id = window.setInterval(() => {
      const previousVersionTrack = nextRef.current;

      void fetchRadioNowPlaying()
        .then((slot) => {
          const sample = slot.serverEpochMs - Date.now();
          skewMsRef.current = skewMsRef.current * 0.7 + sample * 0.3;

          // A grown / re-observed catalogue: the schedule rolled, so hard-resync to
          // the new authoritative slot rather than drifting on the stale one.
          if (slot.currentTrack.trackId !== playhead.track.trackId && !previousVersionTrack) {
            void resolveSlot();
          }
        })
        .catch(() => {
          // A transient failure is harmless — the next poll or boundary re-syncs.
        });
    }, SKEW_POLL_MS);

    return () => window.clearInterval(id);
  }, [started, playhead, resolveSlot]);

  // Drive the looping silent video. It plays muted (its audio is stripped anyway),
  // loops under the observation, and pauses under reduced motion (the offset
  // poster holds; the observation stays audible — the lean-back point survives).
  useEffect(() => {
    const video = videoRef.current;

    if (!video || !playhead) {
      return;
    }

    if (prefersReducedMotion()) {
      video.pause();

      return;
    }

    video.play().catch(() => {
      // Autoplay denied (muted should be fine) — the poster frame stands in.
    });
  }, [playhead, isDesktop]);

  // Drive the observation: seek to the join offset BEFORE play (the audio is the
  // authoritative clock), then run the resync ladder against the locally-computed
  // expected offset. On `ended`, advance to the next scheduled segment. A
  // load/play error RESYNCS to the schedule (never a random skip — that desyncs
  // this client permanently).
  useEffect(() => {
    const audio = audioRef.current;

    if (!audio || !playhead?.track.observationAudioUrl) {
      return;
    }

    const segMs = segmentMs(playhead.track);
    // The wall-clock instant this segment started, in the (skew-corrected) server
    // clock — the anchor the local resync computes the expected offset from.
    const segmentStartServerMs = Date.now() + skewMsRef.current - playhead.offsetMs;

    const expectedOffsetMs = () => Date.now() + skewMsRef.current - segmentStartServerMs;

    // Seek to the offset before playing — the audio leads, the video follows it.
    audio.currentTime = playhead.offsetMs / 1000;
    audio.playbackRate = 1;

    const onEnded = () => void advance();
    const onError = () => {
      // RESYNC, don't skip: a random skip on a synchronized surface desyncs this
      // client forever. Re-resolve the authoritative slot.
      void resolveSlot().catch(() => setExhausted(true));
    };

    // The resync ladder: nudge toward the expected offset without audible re-seeks
    // for jitter, but guarantee convergence after a sleep.
    const onTimeUpdate = () => {
      const drift = audio.currentTime * 1000 - expectedOffsetMs();
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
      const target = Math.min(expectedOffsetMs(), segMs) / 1000;

      if (target >= 0) {
        audio.currentTime = target;
      }
    };

    // A backgrounded tab is throttled and returns seconds off → always hard-seek.
    const onVisible = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      const target = expectedOffsetMs();

      if (target >= segMs) {
        void advance();

        return;
      }

      audio.playbackRate = 1;
      audio.currentTime = Math.max(0, target) / 1000;
    };

    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    audio.addEventListener("timeupdate", onTimeUpdate);
    document.addEventListener("visibilitychange", onVisible);
    audio.play().catch(() => {
      // Playback denied or the object died — resync rather than stall.
      void resolveSlot().catch(() => setExhausted(true));
    });

    return () => {
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      document.removeEventListener("visibilitychange", onVisible);
      audio.pause();
    };
  }, [playhead, advance, resolveSlot]);

  if (!started) {
    return <BeginGate onBegin={begin} />;
  }

  if (exhausted) {
    return <RadioMessage wayBack>{COPY.empty}</RadioMessage>;
  }

  if (!playhead) {
    return <RadioMessage>{COPY.loading}</RadioMessage>;
  }

  const current = playhead.track;
  // A mid-segment join snaps the clip + poster to the cache grid (joiners share a
  // warm clip); the residual is nudged by the resync ladder. A head start (offset
  // 0 — a scheduled transition / the first finding) plays the warm looping crop.
  const joinSnapSeconds = playhead.joinedMidSegment
    ? snapOffsetMs(playhead.offsetMs, OFFSET_SNAP_GRID_MS) / 1000
    : 0;
  const videoUrl = silentVideoUrl(current, isDesktop, joinSnapSeconds);
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

      <div aria-hidden="true" className="radio-scrim" />

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

      {/* The observation: its own audio artifact, seeked to the join offset and
          played over the looping silent video. Hidden; advance() runs on `ended`. */}
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

function BeginGate({ onBegin }: { onBegin: () => void }) {
  return (
    <main className="radio-gate">
      <h1 className="radio-gate-title">{title}</h1>
      <p className="radio-gate-subtitle">{COPY.beginSubtitle}</p>
      <Button onClick={onBegin} size="lg">
        Begin
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
