import { CheckCircleIcon, MapPinAreaIcon, WarningIcon, XIcon } from "@phosphor-icons/react";
import { type MixtapeMember } from "@fluncle/contracts";
import { Button } from "@fluncle/ui/components/button";
import { Label } from "@fluncle/ui/components/label";
import { formatClock } from "@/components/video";
import { cueProgress } from "@/lib/studio-clip";

// The cue rail — the mixtape's ordered tracklist, each row markable at the playhead.
// Marking the set writes the per-track `start_ms` (via `update_mixtape_cue`) that feeds
// YouTube chapters, the /log per-track times, and (later) clip auto-crediting. It is a
// supplementary surface beside the energy lane: the operator scrubs the set, selects a
// track (click or ↑/↓), and marks it (the row button, or the `c` key). Each mark saves
// instantly; the header shows progress + whether the set is chapter-ready; an
// out-of-order or non-zero-first cue is flagged, never blocked (the downstream
// tolerates a partial/transient state).

export function StudioCueRail({
  members,
  onClear,
  onMark,
  onSeek,
  onSelect,
  savingTrackId,
  selectedTrackId,
}: {
  members: MixtapeMember[];
  /** Clear one member's cue (start_ms → null). */
  onClear: (trackId: string) => void;
  /** Mark one member's cue at the (snapped) playhead. */
  onMark: (trackId: string) => void;
  /** Seek the set to a member's cue. */
  onSeek: (ms: number) => void;
  /** Select a member (drives the keyboard mark target). */
  onSelect: (trackId: string) => void;
  /** The trackId whose cue write is in flight, if any. */
  savingTrackId: string | null;
  selectedTrackId: string | null;
}) {
  const progress = cueProgress(members);
  const outOfOrder = new Set(progress.outOfOrderTrackIds);

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="flex items-center gap-1.5">
          <MapPinAreaIcon aria-hidden="true" weight="fill" />
          Cue the set
        </Label>
        <div className="flex items-center gap-2">
          <span className="studio-numeral text-xs text-muted-foreground">
            {progress.marked} / {progress.total} marked
          </span>
          {progress.complete ? (
            <span className="flex items-center gap-1 text-xs text-foreground">
              <CheckCircleIcon aria-hidden="true" weight="fill" />
              Chapter-ready
            </span>
          ) : progress.firstNotZero ? (
            <span className="flex items-center gap-1 text-xs text-destructive">
              <WarningIcon aria-hidden="true" weight="fill" />
              First track should start at 0:00
            </span>
          ) : outOfOrder.size > 0 ? (
            <span className="flex items-center gap-1 text-xs text-destructive">
              <WarningIcon aria-hidden="true" weight="fill" />
              {outOfOrder.size} out of order
            </span>
          ) : null}
        </div>
      </div>

      {members.length > 0 ? (
        <ol className="mt-2 divide-y divide-border rounded-lg border border-border">
          {members.map((member, index) => {
            const cued = member.startMs != null;
            const isSelected = member.trackId === selectedTrackId;
            const isOutOfOrder = outOfOrder.has(member.trackId);
            const saving = savingTrackId === member.trackId;

            return (
              <li
                className="flex items-center gap-2 border-l-2 border-l-transparent px-3 py-2 transition-colors data-[selected=true]:border-l-foreground data-[selected=true]:bg-secondary"
                data-selected={isSelected ? "true" : undefined}
                key={member.trackId}
              >
                <button
                  aria-pressed={isSelected}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => onSelect(member.trackId)}
                  type="button"
                >
                  <span className="studio-numeral w-6 shrink-0 text-xs text-muted-foreground">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    <span className="text-foreground">{member.artists.join(", ")}</span>
                    <span className="text-muted-foreground"> — {member.title}</span>
                  </span>
                </button>

                {cued ? (
                  <button
                    aria-label={`Seek to this cue (${formatClock((member.startMs ?? 0) / 1000)})`}
                    className={`studio-numeral shrink-0 text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-ring ${
                      isOutOfOrder ? "text-destructive" : "text-foreground"
                    }`}
                    onClick={() => onSeek(member.startMs ?? 0)}
                    type="button"
                  >
                    {isOutOfOrder ? (
                      <WarningIcon aria-hidden="true" className="mr-1 inline" weight="fill" />
                    ) : null}
                    {formatClock((member.startMs ?? 0) / 1000)}
                  </button>
                ) : (
                  <span className="shrink-0 text-xs text-muted-foreground">unmarked</span>
                )}

                <Button
                  disabled={saving}
                  onClick={() => onMark(member.trackId)}
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
                    onClick={() => onClear(member.trackId)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <XIcon aria-hidden="true" />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          This set has no tracklist yet. Add its members from the mixtape editor, then mark each
          one's start here.
        </p>
      )}

      <p className="mt-2 text-xs text-muted-foreground">
        Scrub to a track's mix-in, then Mark it here (or select a row and press{" "}
        <kbd className="studio-kbd">C</kbd>). Marks snap to the nearest drop; toggle snapping in the
        settings cog. Each mark saves instantly.
      </p>
    </div>
  );
}
