import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { siSpotify } from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";
import { Button } from "@/components/ui/button";
import { siteUrl } from "@/lib/fluncle-links";
import { formatDateLong } from "@/lib/format";
import { videoAudioStripped, videoCrop, videoCropPoster } from "@/lib/media";
import { fetchRandomRadioTrack, type Track } from "@/lib/tracks";
import { DESKTOP_QUERY, useMediaQuery } from "@/lib/use-media-query";

// radio.fluncle.com — the cycling observation station (RFC Unit B). A lean-back
// surface that loops Fluncle's Findings: each finding's CLEAN footage running
// silent under its spoken observation, then on to the next, forever. It plays
// ZERO commercial audio — the video is the audio-stripped square master and the
// only sound is the recovered observation (the first HEARD surface). The host
// rewrite in router.tsx serves this route at radio.fluncle.com/ (mirrors galaxy).

const title = "Fluncle, observing";
const description =
  "Drum & bass bangers from another dimension. A continuous run of Fluncle's findings, each one playing under the observation he logged when he got there.";

// Fluncle's voice, recovered-log register (copywriting-fluncle, VOICE.md §5):
// in-fiction, no banned identity words, no exclamation marks, warm and dry.
const COPY = {
  // The begin-gate (audible audio needs a gesture). The control is "Begin"
  // (decided); the subtitle says what this is.
  beginSubtitle:
    "A continuous run of findings. Each one plays under what I found when I got there.",
  // Nothing radio-eligible yet (or a run of broken assets gave out).
  empty: "Nothing logged out here yet. Quiet sector tonight.",
  // Between segments, while the next finding's assets load.
  loading: "Still listening for the next one.",
} as const;

// Give up to the empty state after this many consecutive failed picks (a dead
// endpoint or a run of broken objects) instead of hammering forever.
const MAX_SKIP_ATTEMPTS = 5;

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

/** Build the orientation-cropped, audio-stripped silent video URL for a finding. */
function silentVideoUrl(track: Track, desktop: boolean): string | undefined {
  // Radio draws its OWN chrome, so it only ever plays a finding with a clean
  // square master (the eligibility filter guarantees videoSquaredAt is set) — a
  // centre-crop to the viewport orientation, with the audio stripped so the only
  // sound on the surface is the observation.
  if (!track.logId || !track.videoSquaredAt) {
    return undefined;
  }

  return videoAudioStripped(videoCrop(track.logId, desktop ? "landscape" : "portrait"));
}

/** The cheap cropped opening frame, matching the clip's orientation. */
function silentPosterUrl(track: Track, desktop: boolean): string | undefined {
  if (!track.logId || !track.videoSquaredAt) {
    return undefined;
  }

  return videoCropPoster(track.logId, desktop ? "landscape" : "portrait");
}

function RadioPage() {
  // The begin-gate: false until the first user gesture unlocks audible audio.
  const [started, setStarted] = useState(false);
  // The finding currently on the surface (undefined until the first one loads).
  const [current, setCurrent] = useState<Track | undefined>(undefined);
  // The preloaded NEXT finding, fetched during the current segment for a smooth
  // hand-off; consumed by advance() and re-warmed each cycle.
  const [next, setNext] = useState<Track | undefined>(undefined);
  // No finding could be played (empty eligible set, or a broken-asset run).
  const [exhausted, setExhausted] = useState(false);

  // The desktop verdict drives the crop orientation: landscape full-screen on
  // desktop, portrait on mobile. `false` on the server / first paint (mobile
  // portrait default), then the live matchMedia verdict — no SSR mismatch.
  const isDesktop = useMediaQuery(DESKTOP_QUERY);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // The latest preloaded finding, read by advance() without re-subscribing it.
  const nextRef = useRef<Track | undefined>(undefined);
  nextRef.current = next;

  // Advance to the next finding: take the preloaded one if it's ready, else fetch
  // fresh, retrying a few times so a single broken object skips rather than
  // stalls. A whole run of failures (a dead endpoint) gives up to the empty
  // state. Clears the preload so the current-segment effect re-warms a fresh one.
  const advance = useCallback(async () => {
    const preloaded = nextRef.current;
    nextRef.current = undefined;
    setNext(undefined);

    if (preloaded) {
      setCurrent(preloaded);
      setExhausted(false);

      return;
    }

    for (let attempt = 0; attempt < MAX_SKIP_ATTEMPTS; attempt++) {
      try {
        const track = await fetchRandomRadioTrack();

        setCurrent(track);
        setExhausted(false);

        return;
      } catch {
        // Try again with a fresh random pick.
      }
    }

    setExhausted(true);
  }, []);

  // Begin: the first gesture unlocks audio and pulls the first finding.
  const begin = useCallback(() => {
    setStarted(true);
    void advance();
  }, [advance]);

  // Preload the NEXT finding during the current segment, so the swap on `ended`
  // paints instantly. A failed preload is harmless: advance() falls back to a
  // fresh fetch + skip.
  useEffect(() => {
    if (!started || !current) {
      return;
    }

    let cancelled = false;

    fetchRandomRadioTrack()
      .then((track) => {
        if (!cancelled) {
          setNext(track);
        }
      })
      .catch(() => {
        // Harmless — advance() re-fetches when the segment ends.
      });

    return () => {
      cancelled = true;
    };
  }, [started, current]);

  // Drive the looping silent video. It plays muted (its audio is stripped anyway),
  // loops under the observation, and pauses under reduced motion (the poster frame
  // holds; the observation stays audible — the lean-back point survives).
  useEffect(() => {
    const video = videoRef.current;

    if (!video || !current) {
      return;
    }

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      video.pause();

      return;
    }

    video.play().catch(() => {
      // Autoplay denied (muted should be fine) — the poster frame stands in.
    });
  }, [current, isDesktop]);

  // Drive the observation: play the new finding's audio once. When it ends,
  // advance. A load/play error skips to the next finding rather than stalling
  // (a stale or missing R2 object).
  useEffect(() => {
    const audio = audioRef.current;

    if (!audio || !current?.observationAudioUrl) {
      return;
    }

    const onEnded = () => void advance();
    const onError = () => void advance();

    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    audio.play().catch(() => {
      // Playback denied or the object died — skip to the next finding.
      void advance();
    });

    return () => {
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      audio.pause();
    };
  }, [current, advance]);

  if (!started) {
    return <BeginGate onBegin={begin} />;
  }

  if (exhausted) {
    return <RadioMessage>{COPY.empty}</RadioMessage>;
  }

  if (!current) {
    return <RadioMessage>{COPY.loading}</RadioMessage>;
  }

  const videoUrl = silentVideoUrl(current, isDesktop);
  const posterUrl = silentPosterUrl(current, isDesktop);
  const observationUrl = current.observationAudioUrl;
  const nextVideoUrl = next ? silentVideoUrl(next, isDesktop) : undefined;

  return (
    <main className="radio-stage">
      <h1 className="sr-only">{title}</h1>

      {videoUrl ? (
        <video
          aria-hidden="true"
          className="radio-footage"
          // A broken video skips to the next finding rather than stalling.
          key={videoUrl}
          loop
          muted
          onError={() => void advance()}
          playsInline
          poster={posterUrl}
          preload="auto"
          ref={videoRef}
          src={videoUrl}
        />
      ) : (
        // Eligibility guarantees a square master, so this is only reached if the
        // logId is somehow absent — advance rather than show a blank stage.
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

      {/* The observation: its own audio artifact, played once over the looping
          silent video. Hidden; advance() runs on its `ended`. */}
      {observationUrl ? (
        <audio key={observationUrl} preload="auto" ref={audioRef} src={observationUrl}>
          <track kind="captions" />
        </audio>
      ) : undefined}

      {/* Hidden preload of the next finding's assets for an instant hand-off. */}
      <div aria-hidden="true" className="sr-only">
        {nextVideoUrl ? <video muted playsInline preload="auto" src={nextVideoUrl} /> : undefined}
        {next?.observationAudioUrl ? (
          <audio preload="auto" src={next.observationAudioUrl} />
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

function RadioMessage({ children }: { children: React.ReactNode }) {
  return (
    <main className="radio-gate">
      <h1 className="sr-only">{title}</h1>
      <p className="radio-gate-subtitle" role="status">
        {children}
      </p>
    </main>
  );
}
