import { PlayIcon } from "@phosphor-icons/react";
import { type ReactNode } from "react";
import { formatAlbumDuration } from "@/lib/format";
import { formatKey, useKeyNotation } from "@/lib/key-notation";
import { albumCoverAtSize } from "@/lib/media";
import { cn } from "@/lib/utils";

const COVER_SIZE = {
  lg: "size-14",
  md: "size-11",
  sm: "size-9",
  xs: "size-8",
} as const;

export function FindingIdentity({
  artists,
  className,
  cover,
  coverVariant = "plate",
  hasClip = false,
  logId,
  logIdHref,
  onPreview,
  size = "md",
  title,
  titleFormat = "stacked",
}: {
  artists: string[];

  className?: string;

  cover?: string;

  coverVariant?: "plate" | "art";

  hasClip?: boolean;

  logId?: string;

  logIdHref?: string;

  onPreview?: () => void;
  size?: "xs" | "sm" | "md" | "lg";
  title: string;

  titleFormat?: "stacked" | "inline";
}) {
  const previewable = coverVariant === "plate" && hasClip && Boolean(onPreview);

  return (
    <div
      className={cn(
        "flex min-w-0 items-center",
        titleFormat === "stacked" ? "gap-3" : "gap-2.5",
        className,
      )}
    >
      <Cover
        cover={cover}
        hasClip={hasClip}
        onPreview={previewable ? onPreview : undefined}
        size={size}
        title={title}
        variant={coverVariant}
      />
      <div className="min-w-0 flex-1">
        {titleFormat === "stacked" ? (
          <>
            {logId ? (
              <p className="truncate font-mono text-[10px] tracking-tight text-muted-foreground tabular-nums">
                {logId}
              </p>
            ) : undefined}
            <p className="truncate text-sm font-medium">{title}</p>
            <p className="truncate text-xs text-muted-foreground">{artists.join(", ")}</p>
          </>
        ) : (
          <>
            <p className="truncate text-sm">
              {artists.join(", ")} — {title}
            </p>
            {logId && logIdHref ? (
              <a
                className="font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
                href={logIdHref}
                rel="noreferrer"
                target="_blank"
              >
                fluncle://{logId}
              </a>
            ) : logId ? (
              <p className="truncate font-mono text-xs text-muted-foreground tabular-nums">
                {logId}
              </p>
            ) : undefined}
          </>
        )}
      </div>
    </div>
  );
}

function Cover({
  cover,
  hasClip,
  onPreview,
  size,
  title,
  variant,
}: {
  cover?: string;
  hasClip: boolean;
  onPreview?: () => void;
  size: "xs" | "sm" | "md" | "lg";
  title: string;
  variant: "plate" | "art";
}) {
  if (variant === "art") {
    return cover ? (
      <img
        alt=""
        className={cn("shrink-0 rounded-sm border border-border object-cover", COVER_SIZE[size])}
        decoding="async"
        loading="lazy"
        src={albumCoverAtSize(cover, "small")}
      />
    ) : (
      <div
        className={cn(
          "track-artwork-fallback shrink-0 rounded-sm border border-border",
          COVER_SIZE[size],
        )}
      />
    );
  }

  const src = albumCoverAtSize(cover, "small") ?? "/fluncle-cover.png";

  if (hasClip && onPreview) {
    return (
      <button
        aria-label={`Preview ${title} clip`}
        className={cn(
          "group relative shrink-0 rounded-md shadow-[0_0_14px_-3px_var(--eclipse-gold)] outline-none ring-2 ring-primary transition-transform hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--eclipse-glow)] motion-reduce:transition-none",
          COVER_SIZE[size],
        )}
        onClick={onPreview}
        title="Preview clip"
        type="button"
      >
        <img
          alt=""
          className="size-full rounded-md object-cover"
          decoding="async"
          loading="lazy"
          src={src}
        />

        <span
          aria-hidden="true"
          className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_0_0_1px_color-mix(in_oklch,var(--deep-field)_70%,transparent)]"
        >
          <PlayIcon className="size-2.5" weight="fill" />
        </span>
      </button>
    );
  }

  return (
    <img
      alt=""
      className={cn("shrink-0 rounded-md object-cover", COVER_SIZE[size])}
      decoding="async"
      loading="lazy"
      src={src}
    />
  );
}

export function TrackMetaChips({
  bpm,
  className,
  durationMs,
  musicalKey,
}: {
  bpm?: number;
  className?: string;
  durationMs?: number;
  musicalKey?: string;
}): ReactNode {
  const { notation } = useKeyNotation();
  const formattedKey = formatKey(musicalKey, notation) || undefined;
  const parts = [
    bpm ? `${Math.round(bpm)} BPM` : undefined,
    formattedKey,
    durationMs ? formatAlbumDuration(durationMs) : undefined,
  ].filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  return (
    <span className={cn("shrink-0 text-xs text-muted-foreground tabular-nums", className)}>
      {parts.join(" · ")}
    </span>
  );
}
