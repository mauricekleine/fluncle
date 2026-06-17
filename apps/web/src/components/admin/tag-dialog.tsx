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
// A neighbour being re-placed in the same session: its working position plus the
// label for the pinned save-card. Null = the active marker is the row being tagged.
type Editing = { artists?: string[]; pos: Pos; title: string; trackId: string };

type TagDialogProps = {
  error?: string;
  onOpenChange: (open: boolean) => void;
  onSave: (x: number, y: number) => Promise<void> | void;
  /** Re-place an already-placed neighbour: PATCH its (vibe_x, vibe_y). Throws on failure. */
  onSavePoint: (trackId: string, x: number, y: number) => Promise<void>;
  /** Already-placed findings (excluding this one), drawn faint for relative context. */
  points: Point[];
  row: BoardRow | null;
  saving: boolean;
};

export function TagDialog({
  error,
  onOpenChange,
  onSave,
  onSavePoint,
  points,
  row,
  saving,
}: TagDialogProps) {
  // The row's own placement marker. While editing a neighbour this stays put (held)
  // and the active marker becomes the neighbour — saving the neighbour reverts here.
  const [pos, setPos] = useState<Pos | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | undefined>();

  // Seed the marker from the stored placement so re-tagging shows where it sits.
  // A new row also drops any in-flight neighbour edit.
  useEffect(() => {
    setEditing(null);
    setEditError(undefined);

    if (row && row.vibeX !== undefined && row.vibeY !== undefined) {
      setPos({ x: row.vibeX, y: row.vibeY });
    } else {
      setPos(null);
    }
  }, [row]);

  const player = usePreviewPlayer(row?.trackId ?? "");
  // The active marker is the neighbour while editing, otherwise the row's marker.
  const activePos = editing ? editing.pos : pos;
  const quadrant = activePos ? galaxyForVibe(activePos.x, activePos.y) : undefined;
  // Drop both the row and the neighbour-under-edit from the faint context dots —
  // the neighbour is the active marker now, not a backdrop dot.
  const context = points.filter(
    (point) => point.trackId !== row?.trackId && point.trackId !== editing?.trackId,
  );

  const saveEdit = async () => {
    if (!editing) {
      return;
    }

    setEditSaving(true);
    setEditError(undefined);

    try {
      await onSavePoint(editing.trackId, editing.pos.x, editing.pos.y);
      setEditing(null); // revert the active marker to the row being tagged
    } catch (caught) {
      setEditError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setEditSaving(false);
    }
  };

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
          <VibeMap
            editing={editing}
            editSaving={editSaving}
            onChange={(x, y) =>
              editing ? setEditing({ ...editing, pos: { x, y } }) : setPos({ x, y })
            }
            onEditPoint={(point) =>
              setEditing({
                artists: point.artists,
                pos: { x: point.vibeX, y: point.vibeY },
                title: point.title,
                trackId: point.trackId,
              })
            }
            onSaveEdit={() => void saveEdit()}
            points={context}
            value={activePos}
          />
        </div>

        {(error ?? editError) ? (
          <p className="text-sm text-destructive">{error ?? editError}</p>
        ) : undefined}

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
            {editing ? (
              `Moving ${editing.title} — save it on the map`
            ) : quadrant ? (
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

          <Button
            disabled={saving || !pos || editing !== null}
            onClick={() => pos && void onSave(pos.x, pos.y)}
          >
            {saving ? "Saving…" : "Save placement"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
