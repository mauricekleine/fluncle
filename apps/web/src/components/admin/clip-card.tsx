import {
  ArrowSquareOutIcon,
  CalendarBlankIcon,
  CheckIcon,
  CopyIcon,
  DownloadSimpleIcon,
  PencilSimpleIcon,
  PlayIcon,
  ScissorsIcon,
  TrashIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { type ClipDTO, type RecordingDTO } from "@fluncle/contracts/orpc";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { readError } from "@/lib/read-error";
import { InstagramIcon, TiktokIcon } from "@/components/platform-icons";
import { Button } from "@fluncle/ui/components/button";
import { Checkbox } from "@fluncle/ui/components/checkbox";
import { Input } from "@fluncle/ui/components/input";
import { Label } from "@fluncle/ui/components/label";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@fluncle/ui/components/popover";
import { Textarea } from "@fluncle/ui/components/textarea";
import { formatClock, Video } from "@/components/video";
import {
  type ClipDownloadUrls,
  clipDownloadUrls,
  clipDurationMs,
  clipPosterUrl,
  clipPreviewUrl,
} from "@/lib/studio-clips";
import { videoVersion } from "@/lib/media";

type ClipCaption = {
  builtCaption: string;
  caption?: string;
  clipId: string;
  coordinates: string[];
};

export type ClipDrip = {
  postedUrl?: string;
  scheduledFor: string;
  status: "failed" | "posted" | "scheduled";
};

function useClipCaption(clip: ClipDTO, enabled: boolean) {
  return useQuery<ClipCaption>({
    enabled,
    queryFn: async () => {
      const response = await fetch(`/api/v1/admin/clips/${encodeURIComponent(clip.id)}/caption`);

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const body = (await response.json()) as ClipCaption & { ok: true };

      return {
        builtCaption: body.builtCaption,
        caption: body.caption,
        clipId: body.clipId,
        coordinates: body.coordinates,
      };
    },
    queryKey: ["admin", "clip-caption", clip.id, clip.updatedAt],
  });
}

export function ClipCard({
  clip,
  deleting,
  drip,
  onDelete,
  onToggleSelected,
  recording,
  selected,
}: {
  clip: ClipDTO;
  deleting: boolean;

  drip: ClipDrip | undefined;
  onDelete: () => void;

  onToggleSelected: () => void;

  recording: RecordingDTO | undefined;

  selected: boolean;
}) {
  const queryClient = useQueryClient();
  const isDone = clip.status === "done";
  const setTitle = recording ? recording.title : "Unknown set";
  const lengthLabel = formatClock(clipDurationMs(clip) / 1000);
  const rangeLabel = `${formatClock(clip.inMs / 1000)} – ${formatClock(clip.outMs / 1000)}`;

  const version = videoVersion(clip.updatedAt);
  const downloads = clipDownloadUrls(clip.id, version);

  const { data: built } = useClipCaption(clip, isDone);
  const coordinates = built?.coordinates ?? [];

  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);

  const saveCaption = useMutation<ClipDTO, Error, string>({
    mutationFn: async (caption: string) => {
      const response = await fetch(`/api/v1/admin/clips/${encodeURIComponent(clip.id)}`, {
        body: JSON.stringify({ caption }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const body = (await response.json()) as { clip: ClipDTO };

      return body.clip;
    },
    onSuccess: async () => {
      setEditing(false);

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin", "clips"] }),
        queryClient.invalidateQueries({ queryKey: ["admin", "clip-caption", clip.id] }),
      ]);
    },
  });

  const onCopy = () => {
    const payload = built?.builtCaption ?? clip.caption ?? "";

    if (!payload) {
      return;
    }

    void navigator.clipboard?.writeText(payload);
    setCopied(true);
  };

  useEffect(() => {
    if (!copied) {
      return;
    }

    const timer = window.setTimeout(() => setCopied(false), 2000);

    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <article className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
      {isDone ? (
        <ClipStage clipId={clip.id} title={setTitle} version={version} />
      ) : (
        <CuttingStage />
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        {recording?.id ? (
          <Link
            className="min-w-0 truncate text-sm font-medium hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
            params={{ recordingId: recording.id }}
            to="/admin/studio/$recordingId"
          >
            {setTitle}
          </Link>
        ) : (
          <span className="min-w-0 truncate text-sm font-medium">{setTitle}</span>
        )}

        <p className="flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
          <span className="font-medium text-foreground">{lengthLabel}</span>
          <span aria-hidden="true">·</span>
          <span>{rangeLabel}</span>
        </p>

        {coordinates.length > 0 ? (
          <ul className="flex list-none flex-wrap gap-x-2 gap-y-1 p-0">
            {coordinates.map((coordinate) => (
              <li
                className="font-display text-xs tabular-nums tracking-[-0.01em] text-muted-foreground"
                key={coordinate}
              >
                {coordinate}
              </li>
            ))}
          </ul>
        ) : null}

        <ClipCaption
          caption={clip.caption}
          copied={copied}
          editing={editing}
          onCancel={() => setEditing(false)}
          onCopy={onCopy}
          onEdit={() => setEditing(true)}
          onSave={(value) => saveCaption.mutate(value)}
          saving={saveCaption.isPending}
        />

        {isDone ? (
          <div className="flex items-center gap-2">
            {/* oxlint-disable-next-line jsx-a11y/label-has-associated-control -- the control IS nested: Base UI's Checkbox.Root renders a hidden <input type="checkbox"> beside its span, so this label is wired and the hit area toggles; the rule just cannot see through the component. */}
            <label className="flex shrink-0 cursor-pointer items-center">
              <Checkbox
                aria-label={selected ? "Deselect clip" : "Select clip to schedule"}
                checked={selected}
                onCheckedChange={onToggleSelected}
              />
            </label>
            <ClipDrip clipId={clip.id} drip={drip} />
          </div>
        ) : null}

        <div className="mt-auto flex items-center gap-1.5 pt-1">
          {isDone ? (
            <ClipDownloads downloads={downloads} title={setTitle} />
          ) : (
            <span className="text-xs text-muted-foreground">Cutting…</span>
          )}

          <Button
            aria-label="Delete clip"
            className="ml-auto"
            disabled={deleting}
            onClick={onDelete}
            size="icon-sm"
            variant="ghost"
          >
            <TrashIcon aria-hidden="true" />
          </Button>
        </div>
      </div>
    </article>
  );
}

function ClipDrip({ clipId, drip }: { clipId: string; drip: ClipDrip | undefined }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();

  const [when, setWhen] = useState("");

  useEffect(() => {
    if (open) {
      setWhen(drip ? toLocalInput(drip.scheduledFor) : "");
      setError(undefined);
    }
  }, [drip, open]);

  const schedule = useMutation<void, Error, string | null>({
    mutationFn: async (scheduledFor: string | null) => {
      if (scheduledFor === null) {
        const response = await fetch(`/api/v1/admin/clips/${encodeURIComponent(clipId)}/schedule`, {
          method: "DELETE",
        });

        if (!response.ok) {
          throw new Error(await readError(response));
        }

        return;
      }

      const response = await fetch(`/api/v1/admin/clips/${encodeURIComponent(clipId)}/schedule`, {
        body: JSON.stringify({ scheduledFor }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }
    },
    onError: (caught) => setError(caught.message),
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["admin", "clip-posts"] });
    },
  });

  const onSave = () => {
    if (!when) {
      setError("Pick a date and time first.");

      return;
    }

    const iso = new Date(when).toISOString();

    schedule.mutate(iso);
  };

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <button
            aria-label={dripTriggerLabel(drip)}
            className="flex items-center gap-1.5 self-start rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            type="button"
          />
        }
      >
        <DripChip drip={drip} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <PopoverHeader>
          <PopoverTitle>Drip slot</PopoverTitle>
          <PopoverDescription>
            When this clip posts to Instagram. Set it, move it, or take it off the queue.
          </PopoverDescription>
        </PopoverHeader>

        {drip?.status === "posted" && drip.postedUrl ? (
          <a
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            href={drip.postedUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            <ArrowSquareOutIcon aria-hidden="true" />
            View the post on Instagram
          </a>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor={`drip-when-${clipId}`}>Post at</Label>
          <Input
            id={`drip-when-${clipId}`}
            onChange={(event) => setWhen(event.target.value)}
            type="datetime-local"
            value={when}
          />
        </div>

        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex items-center gap-1.5">
          <Button disabled={schedule.isPending} onClick={onSave} size="sm">
            {drip ? "Move slot" : "Schedule"}
          </Button>
          {drip ? (
            <Button
              disabled={schedule.isPending}
              onClick={() => schedule.mutate(null)}
              size="sm"
              variant="ghost"
            >
              Unschedule
            </Button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function DripChip({ drip }: { drip: ClipDrip | undefined }) {
  if (!drip) {
    return (
      <>
        <CalendarBlankIcon aria-hidden="true" />
        <span>Not scheduled</span>
      </>
    );
  }

  if (drip.status === "posted") {
    return (
      <>
        <CheckIcon aria-hidden="true" className="text-primary" weight="bold" />
        <span>Posted to Instagram</span>
      </>
    );
  }

  if (drip.status === "failed") {
    return (
      <>
        <WarningCircleIcon aria-hidden="true" className="text-destructive" />
        <span>Post failed. Reschedule to retry.</span>
      </>
    );
  }

  return (
    <>
      <CalendarBlankIcon aria-hidden="true" />
      <span className="tabular-nums">Scheduled for {formatDripSlot(drip.scheduledFor)}</span>
    </>
  );
}

function dripTriggerLabel(drip: ClipDrip | undefined): string {
  if (!drip) {
    return "Not scheduled for Instagram — schedule this clip";
  }

  if (drip.status === "posted") {
    return "Posted to Instagram — reschedule this clip";
  }

  if (drip.status === "failed") {
    return "Instagram post failed — reschedule this clip";
  }

  return `Scheduled for ${formatDripSlot(drip.scheduledFor)} — change the slot`;
}

function formatDripSlot(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  return date.toLocaleString(undefined, {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  });
}

function toLocalInput(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);

  return local.toISOString().slice(0, 16);
}

function ClipCaption({
  caption,
  copied,
  editing,
  onCancel,
  onCopy,
  onEdit,
  onSave,
  saving,
}: {
  caption: string | undefined;
  copied: boolean;
  editing: boolean;
  onCancel: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onSave: (value: string) => void;
  saving: boolean;
}) {
  const [draft, setDraft] = useState(caption ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(caption ?? "");
      textareaRef.current?.focus();
    }
  }, [caption, editing]);

  if (editing) {
    return (
      <div className="flex flex-col gap-1.5">
        <Textarea
          aria-label="Clip caption"
          className="min-h-16 text-xs"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              onCancel();
            }
          }}
          ref={textareaRef}
          value={draft}
        />
        <div className="flex items-center gap-1.5">
          <Button disabled={saving} onClick={() => onSave(draft.trim())} size="sm">
            Save
          </Button>
          <Button disabled={saving} onClick={onCancel} size="sm" variant="ghost">
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start justify-between gap-1.5">
      {caption ? (
        <p className="line-clamp-2 min-w-0 text-xs leading-relaxed text-muted-foreground">
          {caption}
        </p>
      ) : (
        <p className="min-w-0 text-xs italic text-muted-foreground/70">No caption yet.</p>
      )}
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          aria-label={copied ? "Caption copied" : "Copy caption with its coordinate"}
          onClick={onCopy}
          size="icon-sm"
          title="Copy the caption + fluncle:// coordinate for Instagram"
          variant="ghost"
        >
          {copied ? (
            <CheckIcon aria-hidden="true" className="text-primary" weight="bold" />
          ) : (
            <CopyIcon aria-hidden="true" />
          )}
        </Button>
        <Button
          aria-label="Edit caption"
          onClick={onEdit}
          size="icon-sm"
          title="Edit the caption"
          variant="ghost"
        >
          <PencilSimpleIcon aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

function ClipStage({
  clipId,
  title,
  version,
}: {
  clipId: string;
  title: string;
  version?: number;
}) {
  const [previewing, setPreviewing] = useState(false);

  if (previewing) {
    return <ClipPreview clipId={clipId} title={title} version={version} />;
  }

  return (
    <button
      aria-label={`Preview the clip from ${title}`}
      className="clip-stage group"
      onClick={() => setPreviewing(true)}
      type="button"
    >
      <img
        alt=""
        className="clip-stage-media"
        loading="lazy"
        src={clipPosterUrl(clipId, undefined, version)}
      />
      <span aria-hidden="true" className="clip-stage-play">
        <PlayIcon weight="fill" />
      </span>
    </button>
  );
}

function CuttingStage() {
  return (
    <div className="clip-stage clip-stage-pending">
      <ScissorsIcon aria-hidden="true" className="size-6 text-muted-foreground/70" />
      <span className="text-xs text-muted-foreground">Cutting this clip…</span>
    </div>
  );
}

function ClipPreview({
  clipId,
  title,
  version,
}: {
  clipId: string;
  title: string;
  version?: number;
}) {
  const src = clipPreviewUrl(clipId, undefined, version);

  return (
    <Video.Root autoPlay src={src}>
      <Video.Surface className="clip-stage" mediaClassName="clip-stage-media">
        <Video.Controls overlay>
          <Video.PlayButton size="icon-sm" />
          <Video.Scrubber label={`Seek through the clip from ${title}`} />
        </Video.Controls>
      </Video.Surface>
    </Video.Root>
  );
}

function ClipDownloads({ downloads, title }: { downloads: ClipDownloadUrls; title: string }) {
  return (
    <>
      <Button
        nativeButton={false}
        render={
          <a
            aria-label={`Download the clip from ${title} with audio, for Instagram`}
            download
            href={downloads.withAudio}
            rel="noopener noreferrer"
            target="_blank"
          />
        }
        size="sm"
        variant="outline"
      >
        <DownloadSimpleIcon aria-hidden="true" />
        <InstagramIcon className="size-3.5" />
      </Button>
      <Button
        nativeButton={false}
        render={
          <a
            aria-label={`Download the silent clip from ${title}, for TikTok`}
            download
            href={downloads.silent}
            rel="noopener noreferrer"
            target="_blank"
          />
        }
        size="sm"
        variant="outline"
      >
        <DownloadSimpleIcon aria-hidden="true" />
        <TiktokIcon className="size-3.5" />
      </Button>
    </>
  );
}
