import { CircleNotchIcon, WaveformIcon } from "@phosphor-icons/react";
import { type BoardRow } from "@/components/admin/use-publish";
import { Button } from "@fluncle/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@fluncle/ui/components/dialog";
import { formatKey, useKeyNotation } from "@/lib/key-notation";

type EnrichDialogProps = {
  error?: string;

  hasFeatures?: boolean;
  onOpenChange: (open: boolean) => void;
  onTrigger: () => Promise<void> | void;
  row: BoardRow | null;

  triggering: boolean;
};

export function EnrichDialog({
  error,
  hasFeatures = false,
  onOpenChange,
  onTrigger,
  row,
  triggering,
}: EnrichDialogProps) {
  const { notation } = useKeyNotation();
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
            Queue this finding for the enrichment cron: BPM, key, and the spectral features that
            fuel the video kit. Marking it pending re-runs the analysis on the box&rsquo;s next
            tick.
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
              <dd className="font-mono">{row?.key ? formatKey(row.key, notation) : "—"}</dd>
            </div>
            <p className="col-span-2 text-xs text-muted-foreground">
              {hasFeatures ? "Spectral features captured." : "Analysis complete."}
            </p>
          </dl>
        ) : running ? (
          <p className="flex items-center gap-2 rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3 text-sm text-muted-foreground">
            <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
            The box cron picked this up and is analyzing it. It flips to done when the cron writes
            back.
          </p>
        ) : noLogId ? (
          <p className="text-sm text-muted-foreground">
            This finding needs a Log ID before it can be enriched. Backfill its ISRC first.
          </p>
        ) : failed ? (
          <p className="text-sm text-destructive">
            The last enrichment run failed. Re-queuing marks it pending for a fresh pass.
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
            {done ? "Re-queue enrichment" : failed ? "Retry enrichment" : "Queue enrichment"}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
