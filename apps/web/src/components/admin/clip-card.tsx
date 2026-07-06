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
import { useEffect, useRef, useState } from "react";
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

// One clip in the cross-set library grid (the Fluncle Studio clip library).
// A 9:16 poster tile that reveals an inline preview (the shared VideoScrubber +
// the radio "one clock" discipline) and the hand-off: download WITH audio (Instagram)
// or audio-STRIPPED (TikTok). A `pending` clip — minted in the editor, not yet cut by
// the box — shows a quiet "cutting" state instead of a poster (no preview/download).
//
// The card also stamps the clip's CANON: the `fluncle://` coordinate chip(s) it resolves
// to (the promoted mixtape's `.F.` if its source recording is published, else the
// finding(s) the clip window overlaps — a blend = multiple), and an inline-editable
// caption with a copy button that yields the BUILT caption (clean copy + those
// coordinate line(s)) so the operator pastes it straight into Instagram. Both read
// `get_clip_caption` (RFC plan→recording→mixtape §8 surface 4) — the one server-side
// place that resolves a cue's `finding_id` to its published Log ID.
//
// Distribution rides the Instagram DRIP-FEED (clip-drip-feed RFC §3.6): every clip
// auto-enters a queue and posts to Instagram on a jittered ~daily cadence. The old inert
// "Distribute" seam is now the DRIP STATE — a chip reading `Scheduled for <date>` /
// `Posted` (linking the permalink) / `Post failed`, with a popover to override the slot or
// unschedule the clip (the operator-tier `set_clip_schedule` op). The page's global kill
// switch pauses the whole drip. Reads `list_clip_posts` (merged onto the clip by the page).

/** The built-caption shape from `GET /admin/clips/{clipId}/caption` (drops the `ok` flag). */
type ClipCaption = {
  builtCaption: string;
  caption?: string;
  clipId: string;
  coordinates: string[];
};

/**
 * One clip's Instagram drip-feed row (`GET /admin/clips/social` → `list_clip_posts`), the
 * subset the card renders. `undefined` on the card means the clip has no schedule row yet.
 */
export type ClipDrip = {
  postedUrl?: string;
  scheduledFor: string;
  status: "failed" | "posted" | "scheduled";
};

// Fetch the clip's BUILT caption (clean copy + resolved `fluncle://` coordinate line(s))
// once the clip is cut. A pending clip has no cut window worth resolving, so we skip the
// read until it's `done`. Keyed by clip id + its re-cut vintage so a re-cut re-resolves.
function useClipCaption(clip: ClipDTO, enabled: boolean) {
  return useQuery<ClipCaption>({
    enabled,
    queryFn: async () => {
      const response = await fetch(`/api/admin/clips/${encodeURIComponent(clip.id)}/caption`);

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
  /** This clip's Instagram drip-feed row, when it has one (merged from `list_clip_posts`). */
  drip: ClipDrip | undefined;
  onDelete: () => void;
  /** Toggle this clip in the page's batch-schedule selection (cut clips only). */
  onToggleSelected: () => void;
  /** The source recording, when it's in the loaded list (title + the Studio back-link). */
  recording: RecordingDTO | undefined;
  /** Whether this clip is in the batch-schedule selection. */
  selected: boolean;
}) {
  const queryClient = useQueryClient();
  const isDone = clip.status === "done";
  const setTitle = recording ? recording.title : "Unknown set";
  const lengthLabel = formatClock(clipDurationMs(clip) / 1000);
  const rangeLabel = `${formatClock(clip.inMs / 1000)} – ${formatClock(clip.outMs / 1000)}`;
  // The clip's re-cut vintage rides every transform URL as its `?v` token, so a
  // re-cut (which bumps updatedAt) mints new URLs and MT derives the fresh cut
  // (its internal output cache is not purgeable — media.ts).
  const version = videoVersion(clip.updatedAt);
  const downloads = clipDownloadUrls(clip.id, version);

  // The built caption (clean copy + coordinate line(s)) + the resolved coordinates for
  // the chip row. Only the cut clip has a window worth resolving; a pending clip skips it.
  const { data: built } = useClipCaption(clip, isDone);
  const coordinates = built?.coordinates ?? [];

  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);

  const saveCaption = useMutation<ClipDTO, Error, string>({
    mutationFn: async (caption: string) => {
      const response = await fetch(`/api/admin/clips/${encodeURIComponent(clip.id)}`, {
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
      // Re-read both the grid (the stored-clean caption) and this clip's built caption
      // (the copy payload + the chips fold the fresh caption in).
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin", "clips"] }),
        queryClient.invalidateQueries({ queryKey: ["admin", "clip-caption", clip.id] }),
      ]);
    },
  });

  const onCopy = () => {
    // Prefer the freshly-built caption; fall back to the stored clean caption if the
    // build hasn't landed yet (still copies something honest to paste).
    const payload = built?.builtCaption ?? clip.caption ?? "";

    if (!payload) {
      return;
    }

    void navigator.clipboard?.writeText(payload);
    setCopied(true);
  };

  // Clear the "Copied" flash after a beat.
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
          <a
            className="min-w-0 truncate text-sm font-medium hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
            href={`/admin/studio/${encodeURIComponent(recording.id)}`}
          >
            {setTitle}
          </a>
        ) : (
          <span className="min-w-0 truncate text-sm font-medium">{setTitle}</span>
        )}

        <p className="flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
          <span className="font-medium text-foreground">{lengthLabel}</span>
          <span aria-hidden="true">·</span>
          <span>{rangeLabel}</span>
        </p>

        {/* The clip's canon: the resolved `fluncle://` coordinate chip(s) — the promoted
            mixtape's `.F.` when its source recording is published, else one per finding the
            window overlaps (a blend = ≥2). Quiet Oxanium tabular (the Track-Row Log ID
            face), muted — never gold (the One-Sun budget). An un-cued/no-coordinate clip
            shows none (honest silence beats misattribution). */}
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

        {/* The Instagram drip state: a chip reading this clip's schedule/post status, with a
            popover to override the slot or unschedule; a select checkbox joins it to the page's
            batch-schedule action. Only a cut (`done`) clip is postable — a pending clip shows
            nothing here (the drip cron skips uncut clips server-side). */}
        {isDone ? (
          <div className="flex items-center gap-2">
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

// The clip's Instagram drip-feed control: at rest a quiet status chip (scheduled/posted/
// failed, or "Not scheduled" when the clip has no row yet), and a popover that sets or
// overrides the drip slot (a `datetime-local` field → the operator-tier `set_clip_schedule`
// op) or unschedules the clip. Writing the schedule invalidates the page's `clip-posts` read
// so the chip re-reads. A `posted`/`failed` row can be re-armed by re-scheduling it.
function ClipDrip({ clipId, drip }: { clipId: string; drip: ClipDrip | undefined }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();

  // The datetime-local field seed: the clip's current slot (rendered in local time) if it has
  // one, else the browser default (empty ⇒ the operator picks).
  const [when, setWhen] = useState("");

  useEffect(() => {
    if (open) {
      setWhen(drip ? toLocalInput(drip.scheduledFor) : "");
      setError(undefined);
    }
  }, [drip, open]);

  const schedule = useMutation<void, Error, string | null>({
    mutationFn: async (scheduledFor: string | null) => {
      // `null` unschedules (delete the row); a value sets/overrides the slot. Both funnel
      // through the same route pair (delete vs the operator schedule op).
      if (scheduledFor === null) {
        const response = await fetch(`/api/admin/clips/${encodeURIComponent(clipId)}/schedule`, {
          method: "DELETE",
        });

        if (!response.ok) {
          throw new Error(await readError(response));
        }

        return;
      }

      const response = await fetch(`/api/admin/clips/${encodeURIComponent(clipId)}/schedule`, {
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

    // The `datetime-local` value is local wall-clock; the op wants an ISO instant.
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

        {/* The permalink to the live post, once it's up — the one place to jump out to Instagram. */}
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

// The at-rest drip chip: an icon + a one-line status. `scheduled` is a calendar + the local
// date; `posted` a check; `failed` a warning; no row ⇒ the quiet "Not scheduled".
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

/** The accessible name for the drip trigger — states the status + that it opens the slot editor. */
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

// A drip slot for the chip: a short, local, human date (e.g. "Jul 8, 14:20"). Tabular numbers
// carry it (the copy Tabular Rule). Falls back to the raw ISO if it can't parse.
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

// An ISO instant → the `datetime-local` field value (local wall-clock, `YYYY-MM-DDTHH:mm`).
// The field has no timezone, so we shift by the local offset before slicing.
function toLocalInput(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);

  return local.toISOString().slice(0, 16);
}

// The clip's caption block: click-to-edit prose + a copy button that yields the BUILT
// caption (clean copy + the `fluncle://` coordinate line(s)) for a straight Instagram
// paste. At rest it shows the stored-clean caption (or the quiet empty state) with an
// Edit + Copy pair; editing swaps to a Textarea with Save/Cancel. An empty save clears
// the caption (the server folds "" → no caption).
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

  // Reset the draft to the stored caption whenever an edit opens (a fresh edit starts
  // from the current value, not a stale prior draft), and focus the field.
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

// The done clip's 9:16 stage: a poster that, on play, mounts the inline preview. The
// video is only loaded once the operator actually previews (lazy — a grid of many
// clips never fetches every body).
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

// A pending clip's tile: a quiet, posterless placeholder (the box hasn't cut the
// footage yet). No spinner — the cut is an async backlog beat, not a foreground load.
function CuttingStage() {
  return (
    <div className="clip-stage clip-stage-pending">
      <ScissorsIcon aria-hidden="true" className="size-6 text-muted-foreground/70" />
      <span className="text-xs text-muted-foreground">Cutting this clip…</span>
    </div>
  );
}

// The inline preview: the clip rendition over the shared `<Video>` compound, driven
// off the element's own clock (the radio "one clock" discipline). `autoPlay` force-plays
// on mount (mounted on the operator's click); the transport rides as the auto-hiding
// overlay over the 9:16 frame.
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

// The two hand-off downloads. Cross-origin (found.fluncle.com), so the `download`
// attribute can't force a Save dialog — the file opens in a new tab for the operator
// to save and post by hand (the irreducible in-app beat).
function ClipDownloads({ downloads, title }: { downloads: ClipDownloadUrls; title: string }) {
  return (
    <>
      <Button
        aria-label={`Download the clip from ${title} with audio, for Instagram`}
        nativeButton={false}
        render={<a download href={downloads.withAudio} rel="noopener noreferrer" target="_blank" />}
        size="sm"
        variant="outline"
      >
        <DownloadSimpleIcon aria-hidden="true" />
        <InstagramIcon className="size-3.5" />
      </Button>
      <Button
        aria-label={`Download the silent clip from ${title}, for TikTok`}
        nativeButton={false}
        render={<a download href={downloads.silent} rel="noopener noreferrer" target="_blank" />}
        size="sm"
        variant="outline"
      >
        <DownloadSimpleIcon aria-hidden="true" />
        <TiktokIcon className="size-3.5" />
      </Button>
    </>
  );
}

// Extract a human error from a failed clip request (mirrors the library route's reader):
// prefer a JSON `message`, fall back to text/status.
async function readError(response: Response): Promise<string> {
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
