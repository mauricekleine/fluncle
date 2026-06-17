import {
  ArrowSquareOutIcon,
  CheckIcon,
  CircleNotchIcon,
  CopyIcon,
  DownloadSimpleIcon,
  PaperPlaneTiltIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { type PlatformConfig } from "@/components/admin/platform-cell";
import { type BoardRow } from "@/components/admin/use-publish";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trackMedia } from "@/lib/media";
import { cn } from "@/lib/utils";

// The one dialog the YouTube + TikTok cells open — the whole publish loop for a
// finding on one platform, in the order the operator actually works it:
//
//   1. PREP   — copy the caption, grab the cover (what you paste into the app).
//   2. PUSH   — send it: a public YouTube Short now, or a silent TikTok draft to
//               the inbox you finish in-app.
//   3. CONFIRM— once pushed, paste the live URL (lights up the finding's public
//               row) or mark the push failed.
//
// The dialog reads the LIVE row each render (the board passes identity, not a
// snapshot), so right after a push it shows the confirm step without reopening.
// One surface instead of the old push-button + separate status dialog: the cell
// is "is this live?", and clicking it always lands you wherever the work is.

type PushDialogProps = {
  /** Lookup into the publish hook's busy map for `${trackId}:${platform}:${status}`. */
  busy: (status: string) => boolean;
  /** True while this finding's caption is freshly copied (board-owned, gesture-safe). */
  copied: boolean;
  /** Copy the caption — the board owns the gesture-safe clipboard write. */
  onCopyCaption: () => void;
  onMarkFailed: () => Promise<void> | void;
  onMarkLive: (url: string) => Promise<void> | void;
  onOpenChange: (open: boolean) => void;
  onPush: () => Promise<void> | void;
  platform: PlatformConfig | null;
  /** True while the push to this platform is in flight. */
  pushing: boolean;
  row: BoardRow | null;
  /** TikTok inbox drafts already pending (cap 5/24h) — a contextual heads-up. */
  tiktokPending: number;
};

export function PushDialog({
  busy,
  copied,
  onCopyCaption,
  onMarkFailed,
  onMarkLive,
  onOpenChange,
  onPush,
  platform,
  pushing,
  row,
  tiktokPending,
}: PushDialogProps) {
  const [url, setUrl] = useState("");
  const post = row && platform ? row.posts.find((p) => p.platform === platform.key) : undefined;

  // Re-seed the URL field on every target change (platform + finding) and on close
  // — NOT just when the recorded url value changes. Keying on `post?.url` alone
  // leaks an unsaved edit into the next dialog when both posts share the same url
  // (e.g. both have none): the effect never re-runs, so the typed-but-unsaved text
  // carries over. The identity deps reset it (platform/trackId go null on close).
  useEffect(() => {
    setUrl(post?.url ?? "");
  }, [platform?.key, row?.trackId, post?.url]);

  const open = Boolean(row && platform);
  const pushed = Boolean(post && post.status !== "failed");
  const isLive = post?.status === "published";
  const isTikTok = platform?.key === "tiktok";
  const cover = row?.logId ? trackMedia(row.logId).coverUrl : undefined;
  const capWarning = isTikTok && !pushed && tiktokPending >= 5;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {platform ? (
              <platform.Icon aria-hidden="true" className="size-4" weight="fill" />
            ) : null}
            {platform?.label} — {row?.title}
          </DialogTitle>
          <DialogDescription>
            {platform?.directPost
              ? "Posts a public Short directly. Prep the caption + cover, push, then record the watch URL."
              : "Sends a silent draft to your TikTok inbox. Prep the caption + cover, push, finish in the app, then paste the live URL back here."}
          </DialogDescription>
        </DialogHeader>

        {/* 1. PREP — the two things you paste into the app. */}
        <div className="flex flex-col gap-2">
          <Label>Prep</Label>
          <div className="flex flex-wrap gap-2">
            <Button className="flex-1" onClick={onCopyCaption} variant="outline">
              {copied ? (
                <CheckIcon aria-hidden="true" className="text-primary" weight="bold" />
              ) : (
                <CopyIcon aria-hidden="true" />
              )}
              {copied ? "Copied" : "Copy caption"}
            </Button>
            <Button
              className="flex-1"
              disabled={!cover}
              nativeButton={false}
              render={<a download href={cover} rel="noreferrer" target="_blank" />}
              variant="outline"
            >
              <DownloadSimpleIcon aria-hidden="true" />
              Download cover
            </Button>
          </div>
        </div>

        {/* 2. PUSH — send it (or re-send a failed/earlier push). */}
        <div className="flex flex-col gap-2">
          <Label>{pushed ? "Pushed" : "Push"}</Label>
          {capWarning ? (
            <p className="flex items-start gap-1.5 text-xs text-destructive">
              <WarningIcon aria-hidden="true" className="mt-px shrink-0" weight="fill" />
              {tiktokPending} drafts already pending — TikTok caps the inbox at 5 per 24h, so this
              one may bounce. Publish a few first.
            </p>
          ) : platform?.directPost && !pushed ? (
            <p className="text-xs text-muted-foreground">
              This posts publicly to {platform.label} the moment you push.
            </p>
          ) : undefined}
          <Button
            disabled={!row?.videoUrl || pushing}
            onClick={() => void onPush()}
            variant={pushed ? "outline" : "default"}
          >
            {pushing ? (
              <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
            ) : (
              <PaperPlaneTiltIcon aria-hidden="true" weight="fill" />
            )}
            {pushed
              ? platform?.directPost
                ? "Re-post"
                : "Re-push draft"
              : platform?.directPost
                ? `Post to ${platform.label}`
                : "Push draft to inbox"}
          </Button>
          {!row?.videoUrl ? (
            <p className="text-xs text-muted-foreground">
              No video yet — render + upload it first.
            </p>
          ) : undefined}
        </div>

        {/* 3. CONFIRM — paste the live URL (or flag a failed push). Only once pushed. */}
        {pushed ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="push-url">Live URL</Label>
            <Input
              autoFocus={!isLive}
              id="push-url"
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && url.trim()) {
                  event.preventDefault();
                  void onMarkLive(url.trim());
                }
              }}
              placeholder={
                isTikTok
                  ? "https://www.tiktok.com/@fluncle/video/…"
                  : "https://www.youtube.com/shorts/…"
              }
              value={url}
            />
            <div className="flex items-center justify-between gap-2">
              <Button
                disabled={post?.status === "failed" || busy("failed")}
                onClick={() => void onMarkFailed()}
                size="sm"
                variant="ghost"
              >
                Mark failed
              </Button>
              <div className="flex items-center gap-2">
                {isLive && post?.url ? (
                  <Button
                    nativeButton={false}
                    render={<a href={post.url} rel="noreferrer" target="_blank" />}
                    size="sm"
                    variant="outline"
                  >
                    <ArrowSquareOutIcon aria-hidden="true" />
                    View
                  </Button>
                ) : undefined}
                <Button
                  className={cn(isLive && "min-w-0")}
                  disabled={!url.trim() || busy("published")}
                  onClick={() => void onMarkLive(url.trim())}
                  size="sm"
                >
                  {isLive ? "Update URL" : "Mark live"}
                </Button>
              </div>
            </div>
          </div>
        ) : undefined}
      </DialogContent>
    </Dialog>
  );
}
