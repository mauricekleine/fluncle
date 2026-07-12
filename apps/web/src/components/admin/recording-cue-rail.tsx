import {
  CircleNotchIcon,
  LinkSimpleIcon,
  MapPinAreaIcon,
  PlusIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react";
import { type RecordingTracklistItem } from "@fluncle/contracts/orpc";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Badge } from "@fluncle/ui/components/badge";
import { Button } from "@fluncle/ui/components/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@fluncle/ui/components/command";
import { Input } from "@fluncle/ui/components/input";
import { Label } from "@fluncle/ui/components/label";
import { Popover, PopoverContent, PopoverTrigger } from "@fluncle/ui/components/popover";
import { formatClock } from "@/components/video";
import { albumCoverAtSize } from "@/lib/media";
import { type NewCue, parseArtists, recordingCueProgress } from "@/lib/recording-cues";

// The recording cue-authoring rail (RFC plan→recording→mixtape §8, surface 3). A TAKE's
// cues carry the tracks the operator played, each ideally LINKED to a real Fluncle finding
// (`finding_id`, the honest link to canon) so a promoted mixtape + every clip caption
// resolve to a coordinate — not fuzzy text. So the primary add path is a FINDING-PICKER
// (search canon, attach the finding); free-text stays the escape hatch for a non-finding
// track. The operator's job is then to MARK each cue at its mix-in (the `C`/`X`/↑/↓ loop,
// unchanged). This drives the clip cut's changing on-screen Log ID (`resolveClipTracks`).

// What the finding-picker search returns (a subset of the admin track row). Kept local so
// the rail stays a thin view over `/api/admin/tracks`.
type CueFinding = {
  albumImageUrl?: string;
  artists: string[];
  logId?: string;
  title: string;
  trackId: string;
};

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
  /** Append a new cue (a finding link or free text), then mark it at the playhead. */
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
  /** Whether a cue write is in flight (the whole array persists at once). */
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
          {progress.marked} of {progress.total} tracks marked
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
          No tracks cued yet. Add the findings you played, then mark each one at its mix-in. The
          on-screen Log ID follows your cues as the set plays through.
        </p>
      )}

      <p className="mt-2 text-xs text-muted-foreground">
        Add a finding, scrub to its mix-in, then Mark it (or select a row and press{" "}
        <kbd className="studio-kbd">C</kbd>). Edits save automatically.
      </p>
    </div>
  );
}

// The add-a-cue form: a FINDING-PICKER (search canon, attach a real finding) as the primary
// path, with a free-text row below as the escape hatch for a non-finding track. A finding
// carries its `trackId` as the cue's honest `finding_id`; a free-text cue omits it.
function AddCueForm({ onAdd }: { onAdd: (cue: NewCue) => void }) {
  return (
    <div className="mt-2 space-y-2">
      <FindingPicker
        onPick={(finding) =>
          onAdd({
            artists: finding.artists,
            findingId: finding.trackId,
            title: finding.title,
          })
        }
      />
      <FreeTextCueForm onAdd={onAdd} />
    </div>
  );
}

// Search a Fluncle finding by Log ID / title / artist and attach it as a cue (its `trackId`
// becomes the cue's honest `finding_id`). Mirrors the plan editor's finding search so the
// operator picks from the same canon.
function FindingPicker({ onPick }: { onPick: (finding: CueFinding) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query, 250);
  const trimmed = debounced.trim();

  const { data, isFetching } = useQuery({
    enabled: trimmed.length > 0,
    placeholderData: (prev) => prev,
    queryFn: () => searchCueFindings(trimmed),
    queryKey: ["admin", "cue-finding-search", trimmed],
    staleTime: 30_000,
  });

  const results = data ?? [];

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <Button className="w-full justify-start" variant="outline">
            <LinkSimpleIcon aria-hidden="true" weight="bold" />
            Add a finding…
          </Button>
        }
      />
      <PopoverContent align="start" className="w-(--anchor-width) p-0">
        <Command shouldFilter={false}>
          <CommandInput
            onValueChange={setQuery}
            placeholder="Search by Log ID, title, or artist"
            value={query}
          />
          <CommandList>
            {trimmed.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Type to search your findings.
              </p>
            ) : isFetching && results.length === 0 ? (
              <p className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
                Searching…
              </p>
            ) : (
              <>
                <CommandEmpty>No findings match.</CommandEmpty>
                {results.map((finding) => (
                  <CommandItem
                    key={finding.trackId}
                    onSelect={() => {
                      onPick(finding);
                      setQuery("");
                      setOpen(false);
                    }}
                    value={finding.trackId}
                  >
                    <CueThumb src={finding.albumImageUrl} />
                    <span className="min-w-0 flex-1 truncate">
                      {finding.artists.join(", ")} — {finding.title}
                    </span>
                    <span className="studio-numeral shrink-0 text-xs text-muted-foreground tabular-nums">
                      {finding.logId ?? finding.trackId}
                    </span>
                  </CommandItem>
                ))}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// The escape hatch: a track that isn't a Fluncle finding (an unreleased dubplate, a bootleg)
// still needs a cue so the clip overlay + tracklist carry it — typed as free text, no
// `finding_id`. Enter in either field (or the Add button) appends and clears; a blank title
// is a no-op.
function FreeTextCueForm({ onAdd }: { onAdd: (cue: NewCue) => void }) {
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
    <details className="rounded-lg border border-border px-3 py-2">
      <summary className="cursor-pointer text-xs text-muted-foreground">
        Not a finding? Type it in.
      </summary>
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
    </details>
  );
}

// One authored cue: a numbered, selectable row with inline free-text artist + title fields
// (save on blur), a "linked" badge when the cue carries a `finding_id`, a seekable cue time,
// and Mark / clear / remove controls.
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
  const linked = Boolean(cue.findingId);
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
        key={`artists-${artistsText}`}
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
        key={`title-${cue.title}`}
        onBlur={(event) => {
          const next = event.target.value.trim();

          if (next && next !== cue.title) {
            onEdit(cue.id, { title: next });
          }
        }}
        onFocus={() => onSelect(cue.id)}
        placeholder="Title"
      />

      {linked ? (
        <Badge className="shrink-0 gap-1" title="Linked to a Fluncle finding" variant="secondary">
          <LinkSimpleIcon aria-hidden="true" weight="bold" />
          Finding
        </Badge>
      ) : null}

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

function CueThumb({ src }: { src?: string }) {
  if (src) {
    return (
      <img
        alt=""
        className="size-8 shrink-0 rounded-sm border border-border object-cover"
        src={albumCoverAtSize(src, "small")}
      />
    );
  }

  return <div className="track-artwork-fallback size-8 shrink-0 rounded-sm border border-border" />;
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);

    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

async function searchCueFindings(q: string): Promise<CueFinding[]> {
  const response = await fetch(`/api/admin/tracks?q=${encodeURIComponent(q)}&limit=20`);

  if (!response.ok) {
    return [];
  }

  const body = (await response.json()) as { tracks?: CueFinding[] };

  return body.tracks ?? [];
}
