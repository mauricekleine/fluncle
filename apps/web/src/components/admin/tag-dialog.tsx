import { CircleNotchIcon, PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { type BoardRow } from "@/components/admin/use-publish";
import { VibeMap } from "@/components/admin/vibe-map";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { GALAXIES, galaxyForVibe } from "@/lib/galaxies";
import { usePreviewPlayer } from "@/lib/preview-player";

// The Tag cell's dialog — vibe-map placement for one finding. Drop it on the
// energy×mood field (relative to the others, drawn faint for context), play the
// preview to feel it, Save writes vibe_x/vibe_y. This is the board's placement
// surface (it replaced the standalone /admin/tag tool); see docs/admin-tagging.md
// for the vibe model + the four galaxies.

type Point = { artists?: string[]; title: string; trackId: string; vibeX: number; vibeY: number };
type Pos = { x: number; y: number };

type TagDialogProps = {
  error?: string;
  onOpenChange: (open: boolean) => void;
  onSave: (x: number, y: number) => Promise<void> | void;
  /** Already-placed findings (excluding this one), drawn faint for relative context. */
  points: Point[];
  row: BoardRow | null;
  saving: boolean;
};

export function TagDialog({ error, onOpenChange, onSave, points, row, saving }: TagDialogProps) {
  const [pos, setPos] = useState<Pos | null>(null);

  // Seed the marker from the stored placement so re-tagging shows where it sits.
  useEffect(() => {
    if (row && row.vibeX !== undefined && row.vibeY !== undefined) {
      setPos({ x: row.vibeX, y: row.vibeY });
    } else {
      setPos(null);
    }
  }, [row]);

  const player = usePreviewPlayer(row?.trackId ?? "");
  const quadrant = pos ? galaxyForVibe(pos.x, pos.y) : undefined;
  const context = points.filter((point) => point.trackId !== row?.trackId);

  return (
    <Dialog onOpenChange={onOpenChange} open={row !== null}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Tag — {row?.title}</DialogTitle>
          <DialogDescription>
            Drop it on the field by energy and mood, relative to the others. The quadrant is its
            galaxy.
          </DialogDescription>
        </DialogHeader>

        <div className="flex justify-center">
          <VibeMap onChange={(x, y) => setPos({ x, y })} points={context} value={pos} />
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : undefined}

        <div className="flex items-center justify-between gap-3">
          <Button disabled={!row?.previewUrl} onClick={player.toggle} size="sm" variant="outline">
            {player.isLoading ? (
              <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
            ) : player.isActive ? (
              <PauseIcon aria-hidden="true" weight="fill" />
            ) : (
              <PlayIcon aria-hidden="true" weight="fill" />
            )}
            {row?.previewUrl ? (player.isActive ? "Pause" : "Preview") : "No preview"}
          </Button>

          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {quadrant ? (
              <>
                <span
                  aria-hidden="true"
                  className="size-2.5 rounded-full"
                  style={{ background: GALAXIES[quadrant].color }}
                />
                {GALAXIES[quadrant].name}
              </>
            ) : (
              "Click to place"
            )}
          </span>

          <Button disabled={saving || !pos} onClick={() => pos && void onSave(pos.x, pos.y)}>
            {saving ? "Saving…" : "Save placement"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
