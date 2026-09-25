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
import { Button } from "@fluncle/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@fluncle/ui/components/popover";
import { Switch } from "@fluncle/ui/components/switch";
import { fluncleEntityId, siteUrl } from "@/lib/fluncle-links";
import { jsonLdScript } from "@/lib/json-ld";
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

const title = "Fluncle, observing";
const description =
  "Drum & bass bangers from another dimension. One continuous run of Fluncle's findings, each playing under the observation he logged when he got there.";

const coverUrl = `${siteUrl}/fluncle-cover.png`;

const COPY = {
  beginSubtitle: "One continuous run of findings. You drop in mid-flight, wherever I've got to.",

  empty: "Nothing logged out here yet. Quiet sector tonight.",

  loading: "Catching up to the run.",

  tuning: "Catching up to the run…",
} as const;

const TUNING_MAX_WAIT_MS = 6_000;

const RIDE_MS = 250;
const HARD_SEEK_MS = 2000;
const SOFT_CORRECT_RATE = 1.03;

const SKEW_POLL_MS = 45_000;

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
      { content: coverUrl, property: "og:image" },
      { content: "summary_large_image", name: "twitter:card" },
      { content: coverUrl, name: "twitter:image" },
    ],

    scripts: [
      jsonLdScript({
        "@context": "https://schema.org",
        "@type": "CreativeWork",
        creator: { "@id": fluncleEntityId },
        description,
        genre: "Drum and Bass",
        image: coverUrl,
        inLanguage: "en",
        isAccessibleForFree: true,
        name: title,
        url: `${siteUrl}/radio`,
      }),
    ],
  }),
});

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function silentVideoUrl(track: Track, desktop: boolean, startSeconds?: number): string | undefined {
  if (!track.logId || !track.videoSquaredAt) {
    return undefined;
  }

  const orientation = desktop ? "landscape" : "portrait";

  const version = videoVersion(track.videoSquaredAt);

  return startSeconds && startSeconds > 0
    ? videoClipCrop(track.logId, orientation, startSeconds, undefined, 60, version)
    : videoCrop(track.logId, orientation, undefined, true, version);
}

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
  joinedMidSegment: boolean;
  offsetMs: number;

  segmentStartServerMs: number;
  track: Track;
};

function trackSegmentMs(track: Track): number {
  const raw = track.observationDurationMs;

  return typeof raw === "number" && raw >= SEGMENT_FLOOR_MS ? raw : SEGMENT_FLOOR_MS;
}

function RadioCaptions({
  segmentStartServerMs,
  serverNow,
  words,
}: {
  segmentStartServerMs: number;
  serverNow: () => number;
  words: { endMs: number; startMs: number; text: string }[];
}) {
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
      <p className="sr-only">{words.map((word) => word.text).join(" ")}</p>

      <p aria-hidden="true" className="radio-narration-line" key={view.sliceIndex}>
        {slice.words.map((word, i) => (
          <span
            className={
              i === view.activeWordInSlice
                ? "radio-narration-word is-active"
                : "radio-narration-word"
            }

            key={i}
          >
            {word.text}{" "}
          </span>
        ))}
      </p>
    </div>
  );
}

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
          icon={<ArrowsOutIcon aria-hidden="true" weight="regular" />}
          id="radio-setting-fullscreen"
          label="Fullscreen"
          onCheckedChange={onToggleFullscreen}
        />
      </PopoverContent>
    </Popover>
  );
}

function RadioPage() {
  const [phase, setPhase] = useState<RadioPhase>("idle");

  const started = phase !== "idle";

  const [playhead, setPlayhead] = useState<Playhead | undefined>(undefined);

  const [next, setNext] = useState<Track | undefined>(undefined);

  const [exhausted, setExhausted] = useState(false);

  const [muted, setMuted] = useState(false);
  const [showCaptions, setShowCaptions] = useState(true);
  const [showMeta, setShowMeta] = useState(true);

  const [settingsOpen, setSettingsOpen] = useState(false);

  const [isFullscreen, setIsFullscreen] = useState(false);

  const isDesktop = useMediaQuery(DESKTOP_QUERY);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const skewMsRef = useRef<number>(0);

  const nextRef = useRef<Track | undefined>(undefined);
  nextRef.current = next;

  const playheadRef = useRef<Playhead | undefined>(undefined);
  playheadRef.current = playhead;

  const breatherRef = useRef<HTMLDivElement | null>(null);

  const avStartedRef = useRef(false);

  const serverNow = useCallback(() => Date.now() + skewMsRef.current, []);

  const resolveSlot = useCallback(
    async (fromHead = false): Promise<RadioNowPlaying | undefined> => {
      const sentAt = Date.now();
      const slot = await fetchRadioNowPlaying();
      const receivedAt = Date.now();

      const sample = slot.serverEpochMs + (receivedAt - sentAt) / 2 - receivedAt;

      skewMsRef.current = skewMsRef.current === 0 ? sample : skewMsRef.current * 0.7 + sample * 0.3;

      const offsetMs = fromHead ? 0 : slot.offsetMs;

      setExhausted(false);
      setPlayhead({
        joinedMidSegment: !fromHead && slot.offsetMs > 0,
        offsetMs,

        segmentStartServerMs: Date.now() + skewMsRef.current - offsetMs,
        track: slot.currentTrack,
      });
      setNext(slot.nextTrack);

      return slot;
    },
    [],
  );

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

      void resolveSlot(true).catch(() => {});

      return;
    }

    try {
      await resolveSlot();
    } catch {
      setExhausted(true);
    }
  }, [resolveSlot]);

  const begin = useCallback(() => {
    setPhase("tuning");
    void resolveSlot().catch(() => setExhausted(true));
  }, [resolveSlot]);

  const markPlaying = useCallback(() => {
    setPhase(radioPhaseOnReady);
  }, []);

  useEffect(() => {
    if (phase !== "tuning") {
      return;
    }

    const id = window.setTimeout(markPlaying, TUNING_MAX_WAIT_MS);

    return () => window.clearTimeout(id);
  }, [phase, markPlaying]);

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

  useEffect(() => {
    if (!started || !playhead) {
      return;
    }

    const id = window.setInterval(() => {
      void fetchRadioNowPlaying()
        .then((slot) => {
          const sample = slot.serverEpochMs - Date.now();
          skewMsRef.current = skewMsRef.current * 0.7 + sample * 0.3;

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
        .catch(() => {});
    }, SKEW_POLL_MS);

    return () => window.clearInterval(id);
  }, [started, playhead, resolveSlot]);

  useEffect(() => {
    const audio = audioRef.current;

    if (audio) {
      audio.muted = muted;
    }
  }, [muted, playhead]);

  useEffect(() => {
    const sync = () => setIsFullscreen(Boolean(document.fullscreenElement));

    sync();
    document.addEventListener("fullscreenchange", sync);

    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const toggleFullscreen = useCallback((wantFullscreen: boolean) => {
    if (wantFullscreen) {
      setSettingsOpen(false);
      void document.documentElement.requestFullscreen?.().catch(() => {});

      return;
    }

    void document.exitFullscreen?.().catch(() => {});
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    const video = videoRef.current;

    if (!audio || !playhead?.track.observationAudioUrl) {
      return;
    }

    const reducedMotion = prefersReducedMotion();
    const segMs = trackSegmentMs(playhead.track);

    const segmentStartServerMs = playhead.segmentStartServerMs;
    const expectedOffsetMs = () => serverNow() - segmentStartServerMs;

    audio.currentTime = Math.max(0, Math.min(playhead.offsetMs, segMs)) / 1000;
    audio.playbackRate = 1;

    let started = false;

    avStartedRef.current = false;

    const startBoth = () => {
      if (started) {
        return;
      }

      if (!bothReadyToStart({ audio, reducedMotion, video })) {
        return;
      }

      started = true;
      avStartedRef.current = true;

      markPlaying();

      if (reducedMotion) {
        video?.pause();
      } else {
        video?.play().catch(() => {});
      }

      audio.play().catch(() => {
        void resolveSlot().catch(() => setExhausted(true));
      });
    };

    const onError = () => {
      void resolveSlot().catch(() => setExhausted(true));
    };

    const onTimeUpdate = () => {
      if (!started) {
        return;
      }

      const expected = expectedOffsetMs();

      if (expected >= segMs) {
        return;
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
        audio.playbackRate = drift < 0 ? SOFT_CORRECT_RATE : 1 / SOFT_CORRECT_RATE;

        return;
      }

      audio.playbackRate = 1;
      const target = Math.min(expected, segMs) / 1000;

      if (target >= 0) {
        audio.currentTime = target;
      }
    };

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

    audio.addEventListener("canplaythrough", startBoth);
    audio.addEventListener("canplay", startBoth);
    video?.addEventListener("canplaythrough", startBoth);
    video?.addEventListener("canplay", startBoth);

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

  useEffect(() => {
    const video = videoRef.current;

    if (!video || !playhead || !avStartedRef.current) {
      return;
    }

    if (prefersReducedMotion()) {
      video.pause();

      return;
    }

    video.play().catch(() => {});
  }, [playhead, isDesktop]);

  const joinSnapSeconds =
    playhead && playhead.joinedMidSegment
      ? snapOffsetMs(playhead.offsetMs, OFFSET_SNAP_GRID_MS) / 1000
      : 0;
  const videoUrl = playhead
    ? silentVideoUrl(playhead.track, isDesktop, joinSnapSeconds)
    : undefined;

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

  useScreenWakeLock(started && !exhausted && Boolean(playhead));

  const tuning = phase === "tuning";

  if (phase === "idle") {
    return <BeginGate onBegin={begin} />;
  }

  if (exhausted) {
    return <RadioMessage wayBack>{COPY.empty}</RadioMessage>;
  }

  if (!playhead) {
    return <BeginGate loading onBegin={begin} />;
  }

  const current = playhead.track;

  const posterUrl = silentPosterUrl(current, isDesktop, joinSnapSeconds);
  const observationUrl = current.observationAudioUrl;

  const nextVideoUrl = next ? silentVideoUrl(next, isDesktop) : undefined;

  return (
    <main className="radio-stage">
      <h1 className="sr-only">{title}</h1>

      {videoUrl ? (
        <video
          aria-hidden="true"
          className="radio-footage"

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
        <RadioMessage>{COPY.loading}</RadioMessage>
      )}

      {!tuning ? (
        <>
          <div aria-hidden="true" className="radio-breather" ref={breatherRef} />

          <div aria-hidden="true" className="radio-scrim" />

          {showCaptions &&
          current.observationAlignment &&
          current.observationAlignment.words.length > 0 ? (
            <RadioCaptions
              segmentStartServerMs={playhead.segmentStartServerMs}
              serverNow={serverNow}
              words={current.observationAlignment.words}
            />
          ) : undefined}

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
                    // oxlint-disable-next-line jsx-a11y/anchor-has-content, jsx-a11y/control-has-associated-label -- Base UI's render prop merges the Button's children onto this anchor, so it ships with its label.
                    render={<a href={current.logPageUrl} />}
                    size="sm"
                    variant="outline"
                  >
                    View the log
                  </Button>
                ) : undefined}
                <Button
                  nativeButton={false}
                  // oxlint-disable-next-line jsx-a11y/anchor-has-content, jsx-a11y/control-has-associated-label -- Base UI's render prop merges the Button's children onto this anchor, so it ships with its label.
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

      {tuning ? (
        <div className="radio-gate">
          <p className="radio-gate-title">{title}</p>
          <p className="radio-gate-subtitle">{COPY.beginSubtitle}</p>
          <Button aria-busy disabled size="lg">
            <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
            {COPY.tuning}
          </Button>
        </div>
      ) : undefined}

      {observationUrl ? (
        <audio key={observationUrl} preload="auto" ref={audioRef} src={observationUrl}>
          <track kind="captions" />
        </audio>
      ) : undefined}

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

      <output className="radio-gate-subtitle">{children}</output>

      {wayBack ? (
        <div className="radio-actions">
          <Button nativeButton={false} render={<Link to="/findings" />} size="sm" variant="outline">
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
