import {
  CheckCircleIcon,
  CircleNotchIcon,
  FileVideoIcon,
  UploadSimpleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { planMultipart } from "@fluncle/contracts/util/multipart";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@fluncle/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@fluncle/ui/components/dialog";
import { Input } from "@fluncle/ui/components/input";
import { Label } from "@fluncle/ui/components/label";
import { Progress, ProgressLabel, ProgressValue } from "@fluncle/ui/components/progress";
import {
  isAbortError,
  presignRecordingUpload,
  type UploadProgress,
  uploadFileToPresign,
} from "@/lib/recording-upload";

// The browser recording uploader (admin-shell doctrine — the one primary action on the
// Recordings surface, top-right in the page header). The operator picks a captured set-video
// master and it streams straight to R2 as a multipart upload (the CLI's `recordings create`
// leg, minus ffmpeg), so a multi-GB set no longer needs the terminal. A dropped part retries;
// a cancel or a failure aborts the R2 upload AND drops the just-created recording row, so a
// failed upload never leaves a phantom recording behind. On success the new recording lands
// in the shelf without a reload (`onUploaded` invalidates the recordings query).

type Phase = "idle" | "uploading" | "done" | "error";

export function UploadRecordingDialog({ onUploaded }: { onUploaded: () => void }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [recordedAt, setRecordedAt] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState<string | undefined>();

  const abortRef = useRef<AbortController | null>(null);
  const uploading = phase === "uploading";

  // Warn on a tab close while bytes are in flight — a half-finished multi-GB upload is a lot
  // to lose. (The browser shows its own generic prompt; the string is ignored by design.)
  useEffect(() => {
    if (!uploading) {
      return;
    }

    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handler);

    return () => window.removeEventListener("beforeunload", handler);
  }, [uploading]);

  const reset = () => {
    setFile(null);
    setTitle("");
    setRecordedAt("");
    setPhase("idle");
    setProgress(null);
    setError(undefined);
  };

  const onOpenChange = (next: boolean) => {
    // Never let an outside click / Escape / X close the dialog mid-upload — the explicit
    // Cancel button is the only way to stop (it aborts + cleans up first).
    if (uploading) {
      return;
    }

    setOpen(next);

    if (!next) {
      reset();
    }
  };

  const pickFile = (picked: File | undefined) => {
    if (!picked) {
      return;
    }

    setFile(picked);
    setError(undefined);
    // Smart defaults: the title from the file name (extension stripped), the recorded date
    // from the file's own last-modified stamp (when OBS wrote the master).
    setTitle((current) => current || picked.name.replace(/\.[^.]+$/, ""));
    setRecordedAt((current) => current || toDatetimeLocal(picked.lastModified));
  };

  const start = async () => {
    if (!file || !title.trim()) {
      return;
    }

    const controller = new AbortController();

    abortRef.current = controller;
    setPhase("uploading");
    setError(undefined);
    setProgress({
      completedParts: 0,
      currentPart: 1,
      totalBytes: file.size,
      totalParts: planMultipart(file.size).partCount,
      uploadedBytes: 0,
    });

    let recordingId: string | undefined;

    try {
      const created = await createRecording(title.trim(), recordedAt);

      recordingId = created.id;

      const presign = await presignRecordingUpload(
        recordingId,
        planMultipart(file.size).partCount,
        file.type || undefined,
      );

      await uploadFileToPresign(file, presign, {
        onProgress: setProgress,
        signal: controller.signal,
      });

      setPhase("done");
      onUploaded();
    } catch (caught) {
      // A failed OR cancelled upload must never leave a phantom recording: the R2 multipart
      // was already aborted inside `uploadFileToPresign`; now drop the row too.
      if (recordingId) {
        await deleteRecording(recordingId).catch(() => {});
      }

      if (isAbortError(caught)) {
        // Operator cancelled — back to a clean picker.
        setProgress(null);
        setPhase("idle");
      } else {
        setError(caught instanceof Error ? caught.message : String(caught));
        setPhase("error");
      }
    } finally {
      abortRef.current = null;
    }
  };

  const canStart = Boolean(file && title.trim()) && !uploading;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogTrigger
        render={
          <Button size="sm">
            <UploadSimpleIcon aria-hidden="true" weight="bold" />
            Upload recording
          </Button>
        }
      />
      <DialogContent showCloseButton={!uploading}>
        <DialogHeader>
          <DialogTitle>Upload a recording</DialogTitle>
          <DialogDescription>
            Stage a captured set, ready to clip. It rides up in pieces, and a dropped one just picks
            itself back up.
          </DialogDescription>
        </DialogHeader>

        {phase === "done" ? (
          <DoneState onClose={() => onOpenChange(false)} title={title.trim()} />
        ) : (
          <div className="space-y-4">
            <FileField file={file} onPick={pickFile} uploading={uploading} />

            <div className="space-y-1.5">
              <Label htmlFor="recording-title">Title</Label>
              <Input
                disabled={uploading}
                id="recording-title"
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Friday night, Studio A"
                value={title}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="recording-recorded-at">Recorded</Label>
              <Input
                className="w-full"
                disabled={uploading}
                id="recording-recorded-at"
                onChange={(event) => setRecordedAt(event.target.value)}
                type="datetime-local"
                value={recordedAt}
              />
            </div>

            {uploading && progress ? <UploadMeter progress={progress} /> : null}

            {error ? (
              <p className="flex items-start gap-1.5 text-sm text-destructive" role="alert">
                <WarningCircleIcon aria-hidden="true" className="mt-0.5 shrink-0" weight="fill" />
                <span>{error}</span>
              </p>
            ) : null}

            <div className="flex justify-end gap-2">
              {uploading ? (
                <Button onClick={() => abortRef.current?.abort()} variant="outline">
                  Cancel upload
                </Button>
              ) : (
                <Button disabled={!canStart} onClick={() => void start()}>
                  {phase === "error" ? "Try again" : "Upload"}
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// The file picker: a native file input behind a labelled button, showing the chosen master's
// name + size once picked. `accept="video/*"` so the OS picker leads with videos.
function FileField({
  file,
  onPick,
  uploading,
}: {
  file: File | null;
  onPick: (file: File | undefined) => void;
  uploading: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const labelId = useId();
  const valueId = useId();

  return (
    <div className="space-y-1.5">
      <Label id={labelId}>Set-video master</Label>
      {/* A proxy input the visible button opens — kept out of the tab order + the a11y tree so
          keyboard users get one labelled control (the button), not a stray unlabelled tab stop. */}
      <input
        accept="video/*"
        aria-hidden="true"
        className="sr-only"
        onChange={(event) => onPick(event.target.files?.[0])}
        ref={inputRef}
        tabIndex={-1}
        type="file"
      />
      <Button
        aria-labelledby={`${labelId} ${valueId}`}
        className="h-auto w-full justify-start gap-2.5 px-3 py-2.5 font-normal"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
        type="button"
        variant="outline"
      >
        <FileVideoIcon aria-hidden="true" className="shrink-0 text-muted-foreground" />
        {file ? (
          <span className="min-w-0 flex-1 truncate text-left" id={valueId}>
            {file.name}
            <span className="text-muted-foreground"> · {formatBytes(file.size)}</span>
          </span>
        ) : (
          <span className="text-muted-foreground" id={valueId}>
            Choose a video file…
          </span>
        )}
      </Button>
    </div>
  );
}

// The live upload meter: the progress bar plus an honest byte/part read-out and a retry note.
function UploadMeter({ progress }: { progress: UploadProgress }) {
  const percent =
    progress.totalBytes > 0 ? (progress.uploadedBytes / progress.totalBytes) * 100 : 0;

  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
      {/* Drive the bar by PERCENT (0–100) so a screen reader announces "…%", not a raw byte
          count. The wrapper renders its own track+indicator after these children. */}
      <Progress
        aria-label="Upload progress"
        className="gap-2"
        max={100}
        value={Math.round(percent)}
      >
        <ProgressLabel className="flex items-center gap-1.5 text-sm font-normal text-muted-foreground">
          <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
          Uploading
        </ProgressLabel>
        <ProgressValue>{() => `${Math.floor(percent)}%`}</ProgressValue>
      </Progress>
      <p className="text-xs text-muted-foreground tabular-nums">
        {formatBytes(progress.uploadedBytes)} of {formatBytes(progress.totalBytes)} · part{" "}
        {progress.currentPart} of {progress.totalParts}
        {progress.retry
          ? ` · part dropped, retry ${progress.retry.attempt}/${progress.retry.maxAttempts}…`
          : ""}
      </p>
    </div>
  );
}

// The success state — a quiet confirmation; the recording is already in the shelf behind it.
function DoneState({ onClose, title }: { onClose: () => void; title: string }) {
  return (
    <div className="space-y-4">
      <p className="flex items-start gap-2 text-sm">
        <CheckCircleIcon
          aria-hidden="true"
          className="mt-0.5 shrink-0 text-primary"
          weight="fill"
        />
        <span>
          <span className="font-medium">{title || "The recording"}</span> is staged. It's in the
          recordings shelf, ready to clip.
        </span>
      </p>
      <div className="flex justify-end">
        <Button onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}

// Create the coordinate-less recording row the presign + upload target (same-origin admin API).
async function createRecording(
  title: string,
  recordedAtLocal: string,
): Promise<{ id: string; title: string }> {
  const recordedAt = recordedAtLocal ? new Date(recordedAtLocal).toISOString() : undefined;
  const response = await fetch("/api/admin/recordings", {
    body: JSON.stringify({ recordedAt, title }),
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  const body = (await response.json()) as { recording?: { id?: string; title?: string } };

  if (!body.recording?.id) {
    throw new Error("The new recording came back without an id.");
  }

  return { id: body.recording.id, title: body.recording.title ?? title };
}

// Drop a recording after a failed/cancelled upload — the "never a phantom recording" cleanup.
async function deleteRecording(id: string): Promise<void> {
  await fetch(`/api/admin/recordings/${encodeURIComponent(id)}`, {
    credentials: "same-origin",
    method: "DELETE",
  });
}

function toDatetimeLocal(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

async function readApiError(response: Response): Promise<string> {
  try {
    const body = (await response.clone().json()) as { message?: unknown };

    if (typeof body.message === "string" && body.message.trim()) {
      return body.message;
    }
  } catch {
    // Fall through to text/status below.
  }

  const text = await response.text().catch(() => "");

  return text.trim() || response.statusText || `Request failed (${response.status})`;
}
