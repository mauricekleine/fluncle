import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { type ReactNode } from "react";
import { type QueueTrack, usePreviewPlayer } from "@/lib/preview-player";

export function PreviewArtButton({ track }: { track: QueueTrack }): ReactNode {
  const preview = usePreviewPlayer(track.id, { publicPreview: true, track });

  return (
    <button
      aria-label={
        preview.isActive
          ? `Pause the preview of ${track.title}`
          : `Play the preview of ${track.title}`
      }
      aria-pressed={preview.isActive}
      className="preview-art-btn"
      onClick={preview.toggle}
      type="button"
    >
      {preview.isActive ? (
        <PauseIcon aria-hidden="true" className="size-4" weight="fill" />
      ) : (
        <PlayIcon aria-hidden="true" className="size-4" weight="fill" />
      )}
    </button>
  );
}
