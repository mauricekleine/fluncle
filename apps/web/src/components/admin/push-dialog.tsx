import {
  ArrowSquareOutIcon,
  CheckIcon,
  CircleNotchIcon,
  CopyIcon,
  DownloadSimpleIcon,
  PaperPlaneTiltIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { isStaleTikTokDraft, tikTokDraftAgeHours } from "@fluncle/contracts/util";
import { useState } from "react";
import { type PlatformConfig } from "@/components/admin/platform-cell";
import { type BoardRow } from "@/components/admin/use-publish";
import { Button } from "@fluncle/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@fluncle/ui/components/dialog";
import { Input } from "@fluncle/ui/components/input";
import { Label } from "@fluncle/ui/components/label";
import { trackMedia } from "@/lib/media";
import { cn } from "@/lib/utils";

type PushDialogProps = {
  busy: (status: string) => boolean;

  copied: boolean;

  onCopyCaption: () => void;
  onMarkFailed: () => Promise<void> | void;
  onMarkLive: (url: string) => Promise<void> | void;
  onOpenChange: (open: boolean) => void;
  onPush: () => Promise<void> | void;
  platform: PlatformConfig | null;

  pushing: boolean;
  row: BoardRow | null;

  tiktokPending: number;
};

export function PushDialog({ onOpenChange, platform, row, ...rest }: PushDialogProps) {
  return (
    <Dialog onOpenChange={onOpenChange} open={Boolean(row && platform)}>
      <DialogContent>
        {row && platform ? (
          <PushDialogBody
            key={`${platform.key}:${row.trackId}`}
            platform={platform}
            row={row}
            {...rest}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function tiktokDraftAge(
  post: BoardRow["posts"][number] | undefined,
  now: number,
): {
  staleDraft: boolean;
  staleHours: number;
} {
  return {
    staleDraft: Boolean(post && isStaleTikTokDraft(post, now)),
    staleHours: post ? (tikTokDraftAgeHours(post, now) ?? 0) : 0,
  };
}

function pushDescription(platform: PlatformConfig): string {
  return platform.directPost
    ? "Posts a public Short directly. Prep the caption + cover, push, then record the watch URL."
    : "Sends a silent draft to your TikTok inbox. Prep the caption + cover, push, finish in the app, then paste the live URL back here.";
}

function pushButtonLabel(platform: PlatformConfig, pushed: boolean): string {
  if (pushed) {
    return platform.directPost ? "Re-post" : "Re-push draft";
  }
  return platform.directPost ? `Post to ${platform.label}` : "Push draft to inbox";
}

function PushDialogBody({
  busy,
  copied,
  onCopyCaption,
  onMarkFailed,
  onMarkLive,
  onPush,
  platform,
  pushing,
  row,
  tiktokPending,
}: Omit<PushDialogProps, "onOpenChange" | "platform" | "row"> & {
  platform: PlatformConfig;
  row: BoardRow;
}) {
  const post = row.posts.find((p) => p.platform === platform.key);

  const [url, setUrl] = useState(post?.url ?? "");

  const pushed = Boolean(post && post.status !== "failed");
  const isLive = post?.status === "published";
  const isTikTok = platform.key === "tiktok";
  const cover = row.logId ? trackMedia(row.logId).coverUrl : undefined;
  const capWarning = isTikTok && !pushed && tiktokPending >= 5;

  const now = Date.now();
  const { staleDraft, staleHours } = tiktokDraftAge(post, now);

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <platform.Icon aria-hidden="true" className="size-4" weight="fill" />
          {platform.label} — {row.title}
        </DialogTitle>
        <DialogDescription>{pushDescription(platform)}</DialogDescription>
      </DialogHeader>

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
            render={
              <a
                aria-label="Download cover"
                download
                href={cover}
                rel="noreferrer"
                target="_blank"
              />
            }
            variant="outline"
          >
            <DownloadSimpleIcon aria-hidden="true" />
            Download cover
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>{pushed ? "Pushed" : "Push"}</Label>
        {staleDraft ? (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <WarningIcon aria-hidden="true" className="mt-px shrink-0" weight="fill" />
            Sat {staleHours}h in the inbox — past TikTok's 24h window, so it likely bounced. Re-push
            it.
          </p>
        ) : capWarning ? (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <WarningIcon aria-hidden="true" className="mt-px shrink-0" weight="fill" />
            {tiktokPending} drafts already pending — TikTok caps the inbox at 5 per 24h, so this one
            may bounce. Publish a few first.
          </p>
        ) : platform.directPost && !pushed ? (
          <p className="text-xs text-muted-foreground">
            This posts publicly to {platform.label} the moment you push.
          </p>
        ) : undefined}
        <Button
          disabled={!row.videoUrl || pushing}
          onClick={() => void onPush()}
          variant={pushed ? "outline" : "default"}
        >
          {pushing ? (
            <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
          ) : (
            <PaperPlaneTiltIcon aria-hidden="true" weight="fill" />
          )}
          {pushButtonLabel(platform, pushed)}
        </Button>
        {!row.videoUrl ? (
          <p className="text-xs text-muted-foreground">No video yet — render + upload it first.</p>
        ) : undefined}
      </div>

      {pushed ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="push-url">Live URL</Label>
          <Input
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the confirm step's one field: the operator arrives here to paste the live URL, and only when it is not already live.
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
                  render={
                    <a
                      aria-label={`View the live ${platform.label} post`}
                      href={post.url}
                      rel="noreferrer"
                      target="_blank"
                    />
                  }
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
    </>
  );
}
