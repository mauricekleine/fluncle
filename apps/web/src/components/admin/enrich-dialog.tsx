import { CircleNotchIcon, WaveformIcon } from "@phosphor-icons/react";
import { type BoardRow } from "@/components/admin/use-publish";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// The Enrich cell's dialog — kick off (or re-run) the async enrichment agent on
// Spinup for one finding. Enrichment is the audio-analysis pass: BPM, musical key,
// and the spectral features that feed tagging + the video kit. Triggering is a fast
// ENQUEUE — the work runs durably on Spinup, the agent flips the status to "done"
// when it reports back (docs/track-lifecycle.md, Phase 2), so the cell shows
// "Enriching…" in the meantime and this dialog reflects whichever state it's in.

type EnrichDialogProps = {
  error?: string;
  onOpenChange: (open: boolean) => void;
  onTrigger: () => Promise<void> | void;
  row: BoardRow | null;
  /** True while the enqueue request is in flight. */
  triggering: boolean;
};

export function EnrichDialog({
  error,
  onOpenChange,
  onTrigger,
  row,
  triggering,
}: EnrichDialogProps) {
  const status = row?.enrichmentStatus;
  const done = status === "done";
  const running = status === "processing";
  const failed = status === "failed";
  const noLogId = row !== null && !row.logId;

  return (
    <Dialog onOpenChange={onOpenChange} open={row !== null}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <WaveformIcon aria-hidden="true" className="size-4" weight="fill" />
            Enrich — {row?.title}
          </DialogTitle>
          <DialogDescription>
            Run the audio-analysis agent on Spinup: BPM, key, and the spectral features that feed
            tagging and the video kit.
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <dl className="grid grid-cols-2 gap-3 rounded-lg border border-primary/30 bg-primary/10 p-3 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">BPM</dt>
              <dd className="font-mono tabular-nums">{row?.bpm ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Key</dt>
              <dd className="font-mono">{row?.key ?? "—"}</dd>
            </div>
            <p className="col-span-2 text-xs text-muted-foreground">
              {row?.features ? "Spectral features captured." : "Analysis complete."}
            </p>
          </dl>
        ) : running ? (
          <p className="flex items-center gap-2 rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3 text-sm text-muted-foreground">
            <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
            Running on the agent — this takes a few minutes. It flips to done when the agent reports
            back.
          </p>
        ) : noLogId ? (
          <p className="text-sm text-muted-foreground">
            This finding needs a Log ID before it can be enriched. Backfill its ISRC first.
          </p>
        ) : failed ? (
          <p className="text-sm text-destructive">
            The last enrichment run failed. Re-running enqueues a fresh attempt.
          </p>
        ) : undefined}

        {error ? <p className="text-sm text-destructive">{error}</p> : undefined}

        {running || noLogId ? undefined : (
          <Button
            disabled={triggering}
            onClick={() => void onTrigger()}
            variant={done ? "outline" : "default"}
          >
            {triggering ? (
              <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
            ) : (
              <WaveformIcon aria-hidden="true" weight="fill" />
            )}
            {done ? "Re-run enrichment" : failed ? "Retry enrichment" : "Run enrichment"}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
