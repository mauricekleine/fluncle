import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { type ReactNode } from "react";
import { Button } from "@fluncle/ui/components/button";
import {
  pausePreview,
  playQueue,
  type QueueTrack,
  togglePlayback,
  usePlayerQueue,
  usePreviewStatus,
} from "@/lib/preview-player";

function sameList(a: QueueTrack[], b: QueueTrack[]): boolean {
  return a.length === b.length && a.every((track, index) => track.id === b[index]?.id);
}

export function PlayListButton({
  labels,
  tracks,
}: {
  labels: { name?: { pause: string; play: string }; pause: string; play: string };
  tracks: QueueTrack[];
}): ReactNode {
  const queue = usePlayerQueue();
  const current = queue?.tracks[queue.index];
  const status = usePreviewStatus(current?.id);
  const ours = queue !== undefined && sameList(queue.tracks, tracks);
  const active = ours && (status === "playing" || status === "loading");

  if (tracks.length === 0) {
    return undefined;
  }

  const onClick = () => {
    if (active) {
      pausePreview();

      return;
    }

    if (ours && status === "paused") {
      togglePlayback();

      return;
    }

    playQueue(tracks, 0);
  };

  return (
    <Button
      aria-label={active ? labels.name?.pause : labels.name?.play}
      className="fresh-play-list min-h-11"
      data-status={ours ? status : "idle"}
      onClick={onClick}
      type="button"
      variant="outline"
    >
      {active ? (
        <PauseIcon aria-hidden="true" weight="fill" />
      ) : (
        <PlayIcon aria-hidden="true" weight="fill" />
      )}
      {active ? labels.pause : labels.play}
    </Button>
  );
}
