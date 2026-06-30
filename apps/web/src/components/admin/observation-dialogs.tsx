import { CircleNotchIcon, FileTextIcon, MicrophoneIcon } from "@phosphor-icons/react";
import { type BoardRow } from "@/components/admin/use-publish";
import { stripSsml } from "@/lib/observation-text";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

// The view dialogs for the two audio-observation columns on the admin board.
// Both are READ-ONLY first-pass overviews:
//
//   Context     — the firecrawl-derived `context_note` (internal creative fuel for
//                 the observation script). The dialog reads the note text lazily.
//   Observation — Fluncle's spoken `observation.mp3`. The dialog plays it from its
//                 R2 url.
//
// TODO(backfill): neither dialog generates anything. Authoring + rendering an
// observation needs an agent-authored, voice-gated script posted to the
// `observe` endpoint (the agent holds copywriting-fluncle). When that
// operator-trigger path exists, wire a "generate" action in here; for now the
// board surfaces status + a view.

type ContextDialogProps = {
  /** The context-note text once fetched ("" = still absent / not yet fetched). */
  contextNote: string;
  loading: boolean;
  onOpenChange: (open: boolean) => void;
  row: BoardRow | null;
};

export function ContextDialog({ contextNote, loading, onOpenChange, row }: ContextDialogProps) {
  return (
    <Dialog onOpenChange={onOpenChange} open={row !== null}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileTextIcon aria-hidden="true" className="size-4" weight="fill" />
            Context — {row?.title}
          </DialogTitle>
          <DialogDescription>
            The factual context (label, year, release) that fuels this finding's observation script.
            Internal only — never shows on its log page.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
            Reading the context note…
          </p>
        ) : contextNote ? (
          <ScrollArea className="max-h-64 rounded-lg border border-border bg-card/50 p-3">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
              {contextNote}
            </p>
          </ScrollArea>
        ) : (
          <p className="text-sm text-muted-foreground">
            No context gathered yet — the enrich agent fetches it when it authors the observation.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

type ObservationDialogProps = {
  onOpenChange: (open: boolean) => void;
  row: BoardRow | null;
  /** The spoken transcript ("" = absent / not yet read), read lazily on open. */
  script: string;
  scriptLoading: boolean;
};

export function ObservationDialog({
  onOpenChange,
  row,
  script,
  scriptLoading,
}: ObservationDialogProps) {
  const audioUrl = row?.observationAudioUrl;
  const durationMs = row?.observationDurationMs;
  const generatedAt = row?.observationGeneratedAt;
  // A legacy stored script may carry the occasional SSML tag (a `<break …/>` pause,
  // an `<emphasis>` span) from before the Cartesia migration — strip them so the
  // transcript reads as the clean prose it speaks.
  const transcript = stripSsml(script);

  return (
    <Dialog onOpenChange={onOpenChange} open={row !== null}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MicrophoneIcon aria-hidden="true" className="size-4" weight="fill" />
            Observation — {row?.title}
          </DialogTitle>
          <DialogDescription>
            Fluncle's spoken field observation — what he saw and felt arriving at this finding's
            coordinate.
          </DialogDescription>
        </DialogHeader>

        {audioUrl ? (
          <div className="flex flex-col gap-3">
            <audio
              aria-label={`Fluncle's observation — ${row?.title}`}
              className="w-full"
              controls
              preload="none"
              src={audioUrl}
            >
              <track kind="captions" />
            </audio>
            <dl className="flex items-center gap-4 text-xs text-muted-foreground">
              {typeof durationMs === "number" ? (
                <div className="flex items-center gap-1">
                  <dt>Length</dt>
                  <dd className="tabular-nums text-foreground">{Math.round(durationMs / 1000)}s</dd>
                </div>
              ) : undefined}
              {generatedAt ? (
                <div className="flex items-center gap-1">
                  <dt>Rendered</dt>
                  <dd className="text-foreground">{new Date(generatedAt).toLocaleDateString()}</dd>
                </div>
              ) : undefined}
            </dl>

            {/* The spoken transcript, below the player — what the audio says, read
                quietly (the recovered-audio voice on the page in text form). */}
            {scriptLoading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
                Reading the transcript…
              </p>
            ) : transcript ? (
              <ScrollArea className="max-h-48 rounded-lg border border-border bg-card/50 p-3">
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                  {transcript}
                </p>
              </ScrollArea>
            ) : (
              <p className="text-xs text-muted-foreground">
                No transcript stored. The back-migration recovers it from the rendered artifact.
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No observation rendered yet — the enrich agent authors and voices it after the video
            step.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
