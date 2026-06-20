import { PauseIcon, PlayIcon, WaveformIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

// The log page's audio-observation control: Fluncle's recovered field
// observation, heard over the silent footage (the first HEARD surface — the
// recovered-audio register, VOICE.md §5). A quiet, dark plate under the footage
// with one play/pause control. The observation is its OWN audio artifact (not
// baked into the video), so it plays through a dedicated <audio> element.
//
// Audible audio always needs a user gesture (browsers gate autoplay-with-sound),
// so this never autoplays — it waits for the gesture regardless of motion
// preference, which also satisfies prefers-reduced-motion for free. A load error
// hides the control rather than stalling (a stale/missing R2 object).
export function LogObservation({
  audioUrl,
  durationMs,
}: {
  audioUrl: string;
  durationMs?: number;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;

    if (!audio) {
      return;
    }

    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => setPlaying(false);

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);

    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
    };
  }, []);

  if (failed) {
    return null;
  }

  const seconds = durationMs ? Math.round(durationMs / 1000) : undefined;

  const toggle = () => {
    const audio = audioRef.current;

    if (!audio) {
      return;
    }

    if (audio.paused) {
      audio.play().catch(() => {
        // Playback denied or the object died — drop the control, don't stall.
        setFailed(true);
      });
    } else {
      audio.pause();
    }
  };

  return (
    <section aria-label="Fluncle's observation" className="log-observation">
      <Button
        aria-label={playing ? "Stop the observation" : "Hear Fluncle's observation"}
        aria-pressed={playing}
        className="log-observation-toggle"
        onClick={toggle}
        size="icon"
        variant="outline"
      >
        {playing ? (
          <PauseIcon aria-hidden="true" weight="fill" />
        ) : (
          <PlayIcon aria-hidden="true" weight="fill" />
        )}
      </Button>

      <div className="log-observation-text">
        <p className="log-observation-label">
          <WaveformIcon aria-hidden="true" weight="bold" />
          Recovered observation
        </p>
        <p className="log-observation-hint">
          {playing ? "Fluncle, on the tune" : "What Fluncle logged, in his own voice"}
          {seconds ? ` · ${seconds}s` : ""}
        </p>
      </div>

      <audio onError={() => setFailed(true)} preload="none" ref={audioRef} src={audioUrl}>
        <track kind="captions" />
      </audio>
    </section>
  );
}
