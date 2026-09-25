import { ArrowRightIcon, CircleNotchIcon, PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { HeldNotePanel } from "@/components/admin/held-note-panel";
import { type BoardRow } from "@/components/admin/use-publish";
import { Button } from "@fluncle/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@fluncle/ui/components/dialog";
import { Textarea } from "@fluncle/ui/components/textarea";
import { NOTE_MAX_LENGTH } from "@/lib/log-prose";
import { usePreviewPlayer } from "@/lib/preview-player";

type NoteDialogProps = {
  error?: string;

  hasNext: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (note: string) => Promise<void> | void;
  onSaveAndNext: (note: string) => Promise<void> | void;
  row: BoardRow | null;
  saving: boolean;
};

export function NoteDialog({ onOpenChange, row, ...rest }: NoteDialogProps) {
  return (
    <Dialog onOpenChange={onOpenChange} open={row !== null}>
      <DialogContent className="sm:max-w-lg">
        {row ? <NoteDialogBody key={row.trackId} row={row} {...rest} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function NoteDialogBody({
  error,
  hasNext,
  onSave,
  onSaveAndNext,
  row,
  saving,
}: Omit<NoteDialogProps, "onOpenChange" | "row"> & { row: BoardRow }) {
  const [note, setNote] = useState(row.note ?? "");
  const player = usePreviewPlayer(row.trackId);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Note — {row.title}</DialogTitle>
        <DialogDescription>
          A short note on this finding — the "why". It shows on its log page and feeds the prose +
          schema. Optional.
        </DialogDescription>
      </DialogHeader>

      <HeldNotePanel onUseAsDraft={setNote} trackId={row.trackId} />

      <Textarea
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog exists to write this one note; landing focus in its only field is the point of opening it, and "Save & next" walks a batch.
        autoFocus
        maxLength={NOTE_MAX_LENGTH}
        onChange={(event) => setNote(event.target.value)}
        placeholder="What makes this one a banger…"
        rows={5}
        value={note}
      />

      <div className="flex items-center justify-between gap-3">
        {error ? <p className="text-sm text-destructive">{error}</p> : <span />}
        <span className="text-xs tabular-nums text-muted-foreground">
          {note.trim().length}/{NOTE_MAX_LENGTH}
        </span>
      </div>

      <div className="flex items-center justify-between gap-3">
        <Button onClick={player.toggle} size="sm" variant="outline">
          {player.isLoading ? (
            <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
          ) : player.isActive ? (
            <PauseIcon aria-hidden="true" weight="fill" />
          ) : (
            <PlayIcon aria-hidden="true" weight="fill" />
          )}
          {player.isActive ? "Pause" : "Preview"}
        </Button>

        <div className="flex items-center gap-2">
          {hasNext ? (
            <Button disabled={saving} onClick={() => void onSaveAndNext(note)} variant="secondary">
              Save & next
              <ArrowRightIcon aria-hidden="true" weight="bold" />
            </Button>
          ) : undefined}
          <Button disabled={saving} onClick={() => void onSave(note)}>
            {saving ? "Saving…" : "Save note"}
          </Button>
        </div>
      </div>
    </>
  );
}
