import { CircleNotchIcon, FingerprintIcon, PushPinIcon, XIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { Badge } from "@fluncle/ui/components/badge";
import { Button } from "@fluncle/ui/components/button";
import { Checkbox } from "@fluncle/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@fluncle/ui/components/dialog";
import { Input } from "@fluncle/ui/components/input";
import { Label } from "@fluncle/ui/components/label";
import { type BoardRow } from "@/components/admin/use-publish";
import { type CaptureSourceState } from "@/lib/server/tracks";

export function useCaptureSource(options: {
  fetchState: (trackId: string) => Promise<CaptureSourceState | null>;

  onClose: () => void;
  queryKey: readonly unknown[];
  row: BoardRow | undefined;
  trackId: string | undefined;
}) {
  const { fetchState, onClose, queryKey, row, trackId } = options;
  const queryClient = useQueryClient();
  const key = [...queryKey, trackId];
  const query = useQuery({
    enabled: trackId !== undefined,
    queryFn: () => fetchState(trackId as string),
    queryKey: key,
    refetchOnWindowFocus: true,
  });
  const mutation = useMutation<
    void,
    Error,
    { kind: "clear" } | { allowDurationMismatch: boolean; kind: "pin"; youtube: string }
  >({
    mutationFn: async (input) => {
      if (!row) {
        return;
      }

      const response = await fetch(
        `/api/v1/admin/tracks/${encodeURIComponent(row.trackId)}/capture-source`,
        input.kind === "pin"
          ? {
              body: JSON.stringify({
                allowDurationMismatch: input.allowDurationMismatch,
                youtubeVideoId: input.youtube,
              }),
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              method: "PUT",
            }
          : { credentials: "same-origin", method: "DELETE" },
      );
      const data = (await response.json()) as { message?: string; ok?: boolean };

      if (!response.ok || !data.ok) {
        throw new Error(
          data.message ?? `${input.kind === "pin" ? "Pin" : "Clear"} failed (${response.status})`,
        );
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });

  return {
    busy: mutation.isPending,
    clear: () => mutation.mutateAsync({ kind: "clear" }).then(() => undefined),
    error: mutation.error?.message,
    loading: query.isFetching && query.data === undefined,

    onOpenChange: (open: boolean) => {
      if (!open) {
        onClose();
        mutation.reset();
      }
    },
    pin: (youtube: string, allowDurationMismatch: boolean) =>
      mutation.mutateAsync({ allowDurationMismatch, kind: "pin", youtube }).then(() => undefined),
    row: row ?? null,
    state: query.data,
  };
}

type CaptureSourceDialogProps = {
  state?: CaptureSourceState | null;
  loading: boolean;

  busy: boolean;
  error?: string;
  onClear: () => Promise<void> | void;
  onOpenChange: (open: boolean) => void;
  onPin: (youtube: string, allowDurationMismatch: boolean) => Promise<void> | void;
  row: BoardRow | null;
};

function captureStatusWord(status: string): string {
  switch (status) {
    case "done":
      return "CAPTURED";
    case "unmatched":
      return "UNMATCHED";
    case "failed":
      return "FAILED";
    case "wrong-audio":
      return "WRONG AUDIO";
    case "quarantine-cleared":
      return "CLEARED";
    case "duplicate-cleared":
      return "FORCED";
    default:
      return "PENDING";
  }
}

function verificationWord(verification: null | string): string | undefined {
  switch (verification) {
    case "preview-match":
      return "fingerprint MATCH";
    case "operator-verified":
      return "OPERATOR-VERIFIED";
    case "consensus-verified":
      return "CONSENSUS-VERIFIED — independent uploads agree";
    case "mismatch":
      return "fingerprint MISMATCH";
    case "unverified":
      return "UNVERIFIED — no reference";
    default:
      return undefined;
  }
}

export function CaptureSourceDialog({
  busy,
  error,
  loading,
  onClear,
  onOpenChange,
  onPin,
  row,
  state,
}: CaptureSourceDialogProps) {
  const inputId = useId();
  const hintId = useId();
  const allowId = useId();
  const [youtube, setYoutube] = useState("");

  const [allowDurationMismatch, setAllowDurationMismatch] = useState(false);

  useEffect(() => {
    if (row === null) {
      setYoutube("");
      setAllowDurationMismatch(false);
    }
  }, [row]);

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const value = youtube.trim();

      if (!value) {
        return;
      }

      await onPin(value, allowDurationMismatch);
      setYoutube("");
      setAllowDurationMismatch(false);
    },
    [allowDurationMismatch, onPin, youtube],
  );

  const pinned = state?.captureSourcePin ?? null;
  const pinnedAnyLength = pinned !== null && state?.captureSourcePinAllowDuration === true;
  const verification = state ? verificationWord(state.captureVerification) : undefined;

  return (
    <Dialog onOpenChange={(open) => !busy && onOpenChange(open)} open={row !== null}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FingerprintIcon aria-hidden="true" className="size-4" weight="fill" />
            Capture source — {row?.title}
          </DialogTitle>
          <DialogDescription>
            Where the full-song capture stands, and the one control under the fingerprint gate. Pin
            a YouTube upload and the next capture tick downloads it instead of searching — the
            duration guard still applies unless you accept a different length, the gate still runs,
            the pin wins.
          </DialogDescription>
        </DialogHeader>

        {loading || state === undefined ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
            Reading the capture state…
          </p>
        ) : state === null ? (
          <p className="text-sm text-destructive">This track is gone.</p>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg border border-border p-3 text-sm">
            <dt className="text-xs text-muted-foreground">Capture</dt>
            <dd className="flex flex-wrap items-center gap-2 font-mono text-xs">
              <Badge variant={state.captureStatus === "done" ? "default" : "secondary"}>
                {captureStatusWord(state.captureStatus)}
              </Badge>
              {state.hasCapturedAudio ? (
                <span className="text-muted-foreground">audio on file</span>
              ) : undefined}
              {state.sourceAudioFailures > 0 ? (
                <span className="text-muted-foreground">
                  {state.sourceAudioFailures} failure{state.sourceAudioFailures === 1 ? "" : "s"}
                </span>
              ) : undefined}
            </dd>
            {verification ? (
              <>
                <dt className="text-xs text-muted-foreground">Gate</dt>
                <dd className="font-mono text-xs">{verification}</dd>
              </>
            ) : undefined}
            <dt className="text-xs text-muted-foreground">Embedding</dt>
            <dd className="font-mono text-xs">{row?.hasEmbedding ? "EMBEDDED" : "PENDING"}</dd>
            <dt className="text-xs text-muted-foreground">Source</dt>
            <dd className="flex flex-wrap items-center gap-2 font-mono text-xs">
              {pinned ? (
                <>
                  <PushPinIcon aria-hidden="true" className="size-3.5 text-primary" weight="fill" />
                  <a
                    className="underline-offset-2 hover:underline"
                    href={`https://www.youtube.com/watch?v=${encodeURIComponent(pinned)}`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    youtube {pinned}
                  </a>
                  <span className="text-muted-foreground">
                    {pinnedAnyLength ? "PINNED — any length" : "PINNED"}
                  </span>
                </>
              ) : state.youtubeVideoId ? (
                <>
                  <a
                    className="underline-offset-2 hover:underline"
                    href={`https://www.youtube.com/watch?v=${encodeURIComponent(state.youtubeVideoId)}`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    youtube {state.youtubeVideoId}
                  </a>
                  <span className="text-muted-foreground">from the ladder</span>
                </>
              ) : (
                <span className="text-muted-foreground">the ladder searches</span>
              )}
            </dd>
          </dl>
        )}

        <form className="space-y-3" onSubmit={(event) => void submit(event)}>
          <div className="space-y-1.5">
            <Label htmlFor={inputId}>{pinned ? "Re-pin to" : "Pin a YouTube upload"}</Label>
            <div className="flex gap-2">
              <Input
                aria-describedby={hintId}
                autoComplete="off"
                disabled={busy || state === null}
                id={inputId}
                inputMode="url"
                onChange={(event) => setYoutube(event.target.value)}
                placeholder="https://youtu.be/… or the 11-char id"
                spellCheck={false}
                value={youtube}
              />
              <Button disabled={busy || state === null || !youtube.trim()} type="submit">
                {busy ? (
                  <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
                ) : (
                  <PushPinIcon aria-hidden="true" weight="fill" />
                )}
                Pin
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                checked={allowDurationMismatch}
                disabled={busy || state === null}
                id={allowId}
                onCheckedChange={(checked) => setAllowDurationMismatch(checked === true)}
              />
              <Label className="text-xs font-normal" htmlFor={allowId}>
                Accept a different length — a chosen edit of the same recording; the finding keeps
                its store length
              </Label>
            </div>
            <p className="text-xs text-muted-foreground" id={hintId}>
              Re-queues the capture and clears the rejection memory — the sweep downloads this
              upload, refuses it only if the length is off (unless accepted above), and records the
              capture OPERATOR-VERIFIED. Flag wrong audio first if a bad capture is already on file.
            </p>
          </div>

          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : undefined}

          {pinned ? (
            <Button
              className="w-full"
              disabled={busy}
              onClick={() => void onClear()}
              type="button"
              variant="outline"
            >
              <XIcon aria-hidden="true" weight="bold" />
              Clear the pin — the ladder searches again; capture untouched
            </Button>
          ) : undefined}
        </form>
      </DialogContent>
    </Dialog>
  );
}
