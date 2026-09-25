import { PauseIcon, PlayIcon, WaveformIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@fluncle/ui/components/button";

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
        setFailed(true);
      });
    } else {
      audio.pause();
    }
  };

  return (
    <section aria-label="Recovered observation" className="log-observation">
      <Button
        aria-label={playing ? "Stop the observation" : "Hear the observation"}
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
          {playing ? "Talking you through it" : "What I logged out here, in my own voice"}
          {seconds ? ` · ${seconds}s` : ""}
        </p>
      </div>

      <audio
        aria-label="Recovered observation"
        onError={() => setFailed(true)}
        preload="none"
        ref={audioRef}
        src={audioUrl}
      >
        <track kind="captions" />
      </audio>
    </section>
  );
}
