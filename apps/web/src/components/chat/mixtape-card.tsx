import { Link } from "@tanstack/react-router";
import { TrackArtwork } from "@/components/track-artwork";
import { bangersCount, formatAlbumDuration } from "@/lib/format";
import { mixtapeCoverUrl } from "@/lib/mixtapes";

export type ChatMixtape = {
  bangerCount?: number;

  coordinate?: string;
  note?: string;
  runtimeMs?: number;
  title?: string;
};

export function MixtapeCard({ mixtape }: { mixtape: ChatMixtape }) {
  const logId = mixtape.coordinate;

  const title = mixtape.title ?? "";
  const label = title || logId || "this mixtape";

  const coverSrc = logId ? mixtapeCoverUrl(logId, "thumb") : undefined;

  const meta = [
    mixtape.bangerCount === undefined ? undefined : bangersCount(mixtape.bangerCount),
    mixtape.runtimeMs === undefined ? undefined : formatAlbumDuration(mixtape.runtimeMs),
  ].filter((part): part is string => Boolean(part));

  return (
    <div className="flex items-start gap-3 rounded-md border border-border bg-card px-3 py-2.5">
      <span className="shrink-0">
        <TrackArtwork alt={`${label} cover art`} src={coverSrc} />
      </span>

      <div className="min-w-0 flex-1">
        <p className="track-title">{title}</p>
        {logId ? (
          <Link
            aria-label={`Open the log page for ${label}`}
            className="track-log-id track-log-id-link mt-0.5 inline-block"
            params={{ logId }}
            to="/log/$logId"
          >
            {logId}
          </Link>
        ) : null}
        {meta.length > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">{meta.join(" · ")}</p>
        ) : null}
        {mixtape.note ? (
          <p className="mt-1 truncate text-xs text-muted-foreground">{mixtape.note}</p>
        ) : null}
      </div>
    </div>
  );
}
