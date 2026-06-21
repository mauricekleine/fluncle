import { PlayIcon } from "@phosphor-icons/react";
import { type BoardRow } from "@/components/admin/use-publish";
import { spotifyAlbumImageAtSize } from "@/lib/media";
import { cn } from "@/lib/utils";

// The finding's identity block — cover, title, artists — shared by every variant so
// a row reads the same wherever it lands. The cover doubles as the render status:
// a clip wears the gold story-ring + play badge (the One Sun gold spent on the live
// artifact); no badge means no video. Clicking a clip previews it.

const COVER_SIZE = {
  lg: "size-14",
  md: "size-11",
  sm: "size-9",
} as const;

export function FindingLead({
  logId,
  onPreview,
  row,
  size = "md",
}: {
  /** Show the Log ID coordinate above the title. */
  logId?: boolean;
  onPreview?: (row: BoardRow) => void;
  row: BoardRow;
  size?: "sm" | "md" | "lg";
}) {
  const cover = spotifyAlbumImageAtSize(row.albumImageUrl, "small") ?? "/fluncle-cover.png";
  const hasClip = Boolean(row.videoUrl);

  return (
    <div className="flex min-w-0 items-center gap-3">
      {hasClip && onPreview ? (
        <button
          aria-label={`Preview ${row.title} clip`}
          className={cn(
            "group relative shrink-0 rounded-md shadow-[0_0_14px_-3px_var(--eclipse-gold)] outline-none ring-2 ring-primary transition-transform hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--eclipse-glow)] motion-reduce:transition-none",
            COVER_SIZE[size],
          )}
          onClick={() => onPreview(row)}
          title="Preview clip"
          type="button"
        >
          <img alt="" className="size-full rounded-md object-cover" src={cover} />
          <span
            aria-hidden="true"
            className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm"
          >
            <PlayIcon className="size-2.5" weight="fill" />
          </span>
        </button>
      ) : (
        <img
          alt=""
          className={cn("shrink-0 rounded-md object-cover", COVER_SIZE[size])}
          src={cover}
        />
      )}
      <div className="min-w-0">
        {logId && row.logId ? (
          <p className="truncate font-mono text-[10px] tracking-tight text-muted-foreground tabular-nums">
            {row.logId}
          </p>
        ) : undefined}
        <p className="truncate text-sm font-medium">{row.title}</p>
        <p className="truncate text-xs text-muted-foreground">{row.artists.join(", ")}</p>
      </div>
    </div>
  );
}
