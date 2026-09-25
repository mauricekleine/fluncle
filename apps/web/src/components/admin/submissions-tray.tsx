import { CheckIcon, CircleNotchIcon, XIcon } from "@phosphor-icons/react";
import { type Submission } from "@fluncle/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@fluncle/ui/components/alert-dialog";
import { Button } from "@fluncle/ui/components/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@fluncle/ui/components/sheet";
import { Skeleton } from "@fluncle/ui/components/skeleton";
import { readError } from "@/lib/read-error";
import { formatDate } from "@/lib/format";
import { albumCoverAtSize } from "@/lib/media";
import { cn } from "@/lib/utils";

type SubmissionsTrayProps = {
  focusId?: string;
  loading: boolean;

  onChanged: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  submissions: Submission[];
};

type PendingConfirm = { action: "approve" | "reject"; submission: Submission };

export function SubmissionsTray({
  focusId,
  loading,
  onChanged,
  onOpenChange,
  open,
  submissions,
}: SubmissionsTrayProps) {
  const [busyId, setBusyId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [confirm, setConfirm] = useState<PendingConfirm | undefined>();

  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  useEffect(() => {
    if (!open || !focusId) {
      return;
    }
    rowRefs.current.get(focusId)?.scrollIntoView({ block: "center" });
  }, [focusId, open, submissions]);

  const run = useCallback(
    async (submission: Submission, fn: () => Promise<void>) => {
      setBusyId(submission.id);
      setError(undefined);

      try {
        await fn();
        onChanged();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusyId(undefined);
      }
    },
    [onChanged],
  );

  const approve = useCallback(
    (submission: Submission) =>
      run(submission, async () => {
        await publishSubmission(submission);

        const response = await fetch(
          `/api/v1/admin/submissions/${encodeURIComponent(submission.id)}/approve`,
          { credentials: "same-origin", method: "POST" },
        );

        if (!response.ok) {
          throw new Error(await readError(response));
        }
      }),
    [run],
  );

  const reject = useCallback(
    (submission: Submission) =>
      run(submission, async () => {
        const response = await fetch(
          `/api/v1/admin/submissions/${encodeURIComponent(submission.id)}/reject`,
          { credentials: "same-origin", method: "POST" },
        );

        if (!response.ok) {
          throw new Error(await readError(response));
        }
      }),
    [run],
  );

  const confirmAction = useCallback(() => {
    if (!confirm) {
      return;
    }

    void (confirm.action === "approve" ? approve : reject)(confirm.submission);
    setConfirm(undefined);
  }, [approve, confirm, reject]);

  return (
    <>
      <Sheet onOpenChange={onOpenChange} open={open}>
        <SheetContent side="right">
          <SheetHeader className="border-b border-border">
            <SheetTitle>Submissions</SheetTitle>
            <SheetDescription>
              What the crew sent in. Approving publishes it, same as adding it yourself.
            </SheetDescription>
          </SheetHeader>

          {error ? (
            <p className="px-4 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : undefined}

          {loading && submissions.length === 0 ? (
            <div className="space-y-4 px-4">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : submissions.length === 0 ? (
            <p className="px-4 text-sm text-muted-foreground">No submissions.</p>
          ) : (
            <ul className="min-h-0 flex-1 overflow-y-auto">
              {submissions.map((submission) => {
                const busy = busyId === submission.id;

                const focused = submission.id === focusId;

                return (
                  <li
                    className={cn(
                      "space-y-2.5 border-b border-border px-4 py-3.5",
                      focused && "bg-primary/5 ring-1 ring-inset ring-primary/40",
                    )}
                    key={submission.id}
                    ref={(el) => {
                      if (el) {
                        rowRefs.current.set(submission.id, el);
                      } else {
                        rowRefs.current.delete(submission.id);
                      }
                    }}
                  >
                    <div className="flex items-center gap-2.5">
                      {submission.artworkUrl ? (
                        <img
                          alt=""
                          className="size-9 shrink-0 rounded-sm border border-border object-cover"
                          src={albumCoverAtSize(submission.artworkUrl, "small")}
                        />
                      ) : (
                        <div className="track-artwork-fallback size-9 shrink-0 rounded-sm border border-border" />
                      )}
                      <div className="min-w-0 flex-1">
                        <a
                          className="block truncate text-sm font-medium hover:underline"
                          href={submission.spotifyUrl}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {submission.artists.join(", ")} — {submission.title}
                        </a>
                        <p className="truncate text-xs text-muted-foreground">
                          {submission.source} · {formatDate(submission.createdAt)}
                          {submission.contact ? ` · ${submission.contact}` : ""}
                        </p>
                      </div>
                    </div>

                    {submission.note ? (
                      <p className="text-xs text-muted-foreground">“{submission.note}”</p>
                    ) : undefined}

                    {submission.triageVerdict ? (
                      <p className="text-xs italic text-muted-foreground">
                        {submission.triageVerdict}
                      </p>
                    ) : undefined}

                    <div className="flex items-center justify-end gap-1.5">
                      <Button
                        disabled={busyId !== undefined}
                        onClick={() => setConfirm({ action: "approve", submission })}
                        size="sm"
                        variant="outline"
                      >
                        {busy ? (
                          <CircleNotchIcon
                            aria-hidden="true"
                            className="animate-spin"
                            weight="bold"
                          />
                        ) : (
                          <CheckIcon aria-hidden="true" weight="bold" />
                        )}
                        Approve
                      </Button>
                      <Button
                        className="text-muted-foreground hover:text-destructive"
                        disabled={busyId !== undefined}
                        onClick={() => setConfirm({ action: "reject", submission })}
                        size="sm"
                        variant="ghost"
                      >
                        <XIcon aria-hidden="true" weight="bold" />
                        Reject
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog onOpenChange={(next) => !next && setConfirm(undefined)} open={Boolean(confirm)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.action === "approve"
                ? "Publish this submission?"
                : "Reject this submission?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm
                ? confirm.action === "approve"
                  ? `${formatTrackLine(confirm.submission)} goes to the Spotify playlist and Telegram, with a minted Log ID.`
                  : `${formatTrackLine(confirm.submission)} leaves the tray. They can send it again.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmAction}
              variant={confirm?.action === "reject" ? "destructive" : "default"}
            >
              {confirm?.action === "approve" ? "Publish it" : "Reject it"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function formatTrackLine(submission: Submission): string {
  return `${submission.artists.join(", ")} — ${submission.title}`;
}

async function publishSubmission(submission: Submission): Promise<void> {
  const response = await fetch("/api/v1/admin/tracks", {
    body: JSON.stringify({
      note: submission.note,
      spotifyUrl: submission.spotifyUrl,
    }),
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  if (response.ok) {
    return;
  }

  const body = (await response
    .clone()
    .json()
    .catch(() => ({}))) as { code?: string; message?: string };

  if (
    response.status === 409 &&
    (body.code === "duplicate" || body.code === "incomplete_duplicate")
  ) {
    return;
  }

  throw new Error(
    typeof body.message === "string" && body.message.trim()
      ? body.message
      : await readError(response),
  );
}
