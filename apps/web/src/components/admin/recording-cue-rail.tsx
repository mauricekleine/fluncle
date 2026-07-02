import { MapPinAreaIcon, PlusIcon, TrashIcon, XIcon } from "@phosphor-icons/react";
import { type RecordingTracklistItem } from "@fluncle/contracts/orpc";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatClock } from "@/components/video";
import { type NewCue, parseArtists, recordingCueProgress } from "@/lib/recording-cues";

// The recording cue-authoring rail (RFC recording-primitive, Design B — Wave 3). Unlike
// the mixtape `StudioCueRail` (which only MARKS a pre-existing catalogue tracklist), a
// RECORDING starts EMPTY: the operator AUTHORS each cue here — type a track (artist(s) +
// title), mark it at the playhead, edit or remove it. It reuses the mixtape rail's row
// shape (numbered rows, a Mark-here button, a seekable cue time, a clear ✕) but the
// authoring (add / free-text edit / remove) is net-new. Every mutation goes through the
// pure `@/lib/recording-cues` helpers in the parent, which persists the whole array via
// `update_recording`. This tracklist drives the clip cut's changing on-screen Track-ID.

export function RecordingCueRail({
  onAdd,
  onClear,
  onEdit,
  onMark,
  onRemove,
  onSeek,
  onSelect,
  saving,
  selectedId,
  tracklist,
}: {
  /** Append a new cue (artist(s) + title), then mark it at the playhead. */
  onAdd: (cue: NewCue) => void;
  /** Clear one cue's startMs (back to unmarked), keyed by id. */
  onClear: (id: string) => void;
  /** Edit a cue's authored text (artist(s) and/or title), keyed by id. */
  onEdit: (id: string, patch: Partial<NewCue>) => void;
  /** Mark one cue at the playhead, keyed by id. */
  onMark: (id: string) => void;
  /** Remove a cue entirely, keyed by id. */
  onRemove: (id: string) => void;
  /** Seek the set to a cue's startMs. */
  onSeek: (ms: number) => void;
  /** Select a cue (drives the keyboard mark/clear target). */
  onSelect: (id: string) => void;
  /** Whether a tracklist write is in flight (the whole array persists at once). */
  saving: boolean;
  selectedId: string | null;
  tracklist: RecordingTracklistItem[];
}) {
  const progress = recordingCueProgress(tracklist);

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="flex items-center gap-1.5">
          <MapPinAreaIcon aria-hidden="true" weight="fill" />
          Cue the set
        </Label>
        <span className="studio-numeral text-xs text-muted-foreground">
          {progress.marked} / {progress.total} marked
          {saving ? " · saving…" : ""}
        </span>
      </div>

      <AddCueForm onAdd={onAdd} />

      {tracklist.length > 0 ? (
        <ol className="mt-2 divide-y divide-border rounded-lg border border-border">
          {tracklist.map((cue, index) => (
            <CueRow
              cue={cue}
              index={index}
              key={cue.id}
              onClear={onClear}
              onEdit={onEdit}
              onMark={onMark}
              onRemove={onRemove}
              onSeek={onSeek}
              onSelect={onSelect}
              saving={saving}
              selected={cue.id === selectedId}
            />
          ))}
        </ol>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          No cues yet. Add a track above, then Mark it at the playhead — the on-screen Track-ID on
          each clip changes as the set plays through your cues.
        </p>
      )}

      <p className="mt-2 text-xs text-muted-foreground">
        Type a track, scrub to its mix-in, then Mark it (or select a row and press{" "}
        <kbd className="studio-kbd">C</kbd>). Edits save automatically.
      </p>
    </div>
  );
}

// The add-a-track form: an artist(s) field + a title field. Enter in either (or the Add
// button) appends the cue and clears the form. A blank title is a no-op.
function AddCueForm({ onAdd }: { onAdd: (cue: NewCue) => void }) {
  const [artists, setArtists] = useState("");
  const [title, setTitle] = useState("");

  const submit = () => {
    if (!title.trim()) {
      return;
    }

    onAdd({ artists: parseArtists(artists), title });
    setArtists("");
    setTitle("");
  };

  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <Label className="text-xs text-muted-foreground" htmlFor="recording-cue-artists">
          Artist(s)
        </Label>
        <Input
          autoComplete="off"
          id="recording-cue-artists"
          onChange={(event) => setArtists(event.target.value)}
          placeholder="Alix Perez, Monty"
          value={artists}
        />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <Label className="text-xs text-muted-foreground" htmlFor="recording-cue-title">
          Title
        </Label>
        <Input
          autoComplete="off"
          id="recording-cue-title"
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Forsaken"
          value={title}
        />
      </div>
      <Button disabled={!title.trim()} size="sm" type="submit" variant="outline">
        <PlusIcon aria-hidden="true" weight="bold" />
        Add track
      </Button>
    </form>
  );
}

// One authored cue: a numbered, selectable row with inline free-text artist + title
// fields (save on blur), a seekable cue time, and Mark / clear / remove controls.
function CueRow({
  cue,
  index,
  onClear,
  onEdit,
  onMark,
  onRemove,
  onSeek,
  onSelect,
  saving,
  selected,
}: {
  cue: RecordingTracklistItem;
  index: number;
  onClear: (id: string) => void;
  onEdit: (id: string, patch: Partial<NewCue>) => void;
  onMark: (id: string) => void;
  onRemove: (id: string) => void;
  onSeek: (ms: number) => void;
  onSelect: (id: string) => void;
  saving: boolean;
  selected: boolean;
}) {
  const cued = cue.startMs != null;
  const artistsText = cue.artists.join(", ");

  return (
    <li
      className="flex flex-wrap items-center gap-2 border-l-2 border-l-transparent px-3 py-2 transition-colors data-[selected=true]:border-l-foreground data-[selected=true]:bg-secondary"
      data-selected={selected ? "true" : undefined}
    >
      <button
        aria-label={`Select track ${index + 1}`}
        aria-pressed={selected}
        className="studio-numeral w-6 shrink-0 text-left text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => onSelect(cue.id)}
        type="button"
      >
        {index + 1}
      </button>

      <Input
        aria-label={`Artist(s) for track ${index + 1}`}
        autoComplete="off"
        className="h-8 min-w-0 flex-1"
        defaultValue={artistsText}
        onBlur={(event) => {
          const next = parseArtists(event.target.value);

          if (next.join(", ") !== artistsText) {
            onEdit(cue.id, { artists: next });
          }
        }}
        onFocus={() => onSelect(cue.id)}
        placeholder="Artist(s)"
      />
      <Input
        aria-label={`Title for track ${index + 1}`}
        autoComplete="off"
        className="h-8 min-w-0 flex-1"
        defaultValue={cue.title}
        onBlur={(event) => {
          const next = event.target.value.trim();

          if (next && next !== cue.title) {
            onEdit(cue.id, { title: next });
          }
        }}
        onFocus={() => onSelect(cue.id)}
        placeholder="Title"
      />

      {cued ? (
        <button
          aria-label={`Seek to this cue (${formatClock((cue.startMs ?? 0) / 1000)})`}
          className="studio-numeral shrink-0 text-sm tabular-nums text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => onSeek(cue.startMs ?? 0)}
          type="button"
        >
          {formatClock((cue.startMs ?? 0) / 1000)}
        </button>
      ) : (
        <span className="shrink-0 text-xs text-muted-foreground">unmarked</span>
      )}

      <Button
        disabled={saving}
        onClick={() => onMark(cue.id)}
        size="sm"
        variant={cued ? "ghost" : "outline"}
      >
        <MapPinAreaIcon aria-hidden="true" weight="bold" />
        {cued ? "Re-mark" : "Mark here"}
      </Button>
      {cued ? (
        <Button
          aria-label="Clear cue"
          disabled={saving}
          onClick={() => onClear(cue.id)}
          size="icon-sm"
          variant="ghost"
        >
          <XIcon aria-hidden="true" />
        </Button>
      ) : null}
      <Button
        aria-label={`Remove track ${index + 1}`}
        disabled={saving}
        onClick={() => onRemove(cue.id)}
        size="icon-sm"
        variant="ghost"
      >
        <TrashIcon aria-hidden="true" />
      </Button>
    </li>
  );
}
