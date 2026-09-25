import { SpotifyIcon } from "@/components/platform-icons";

export type ChatCatalogueTrack = {
  artists: string[];

  label?: string;

  release?: string;

  releaseDate?: string;

  spotifyUrl?: string;
  title: string;
};

const MAX_ROWS = 8;

export function CatalogueList({
  catalogue,
  heading,
}: {
  catalogue: ChatCatalogueTrack[];
  heading?: string;
}) {
  const shown = catalogue.slice(0, MAX_ROWS);
  const remaining = catalogue.length - shown.length;

  return (
    <div className="flex flex-col gap-2">
      {heading ? <p className="px-1 text-xs text-muted-foreground">{heading}</p> : null}
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-card px-3">
        {shown.map((track, index) => (
          <CatalogueRow key={track.spotifyUrl ?? `${track.title}-${index}`} track={track} />
        ))}
      </ul>
      {remaining > 0 ? (
        <p className="px-1 text-xs text-muted-foreground">+{remaining} more</p>
      ) : null}
    </div>
  );
}

function CatalogueRow({ track }: { track: ChatCatalogueTrack }) {
  const artists = track.artists ?? [];
  const trackLine = artists.length > 0 ? `${artists.join(", ")} — ${track.title}` : track.title;
  const context = [track.release, track.label].filter(Boolean).join(" · ");

  return (
    <li className="flex items-center gap-2.5 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-muted-foreground">{trackLine}</p>
        {context ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{context}</p>
        ) : null}
      </div>
      {track.spotifyUrl ? (
        <a
          aria-label={`Open ${track.title} on Spotify`}
          className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          href={track.spotifyUrl}
          rel="noreferrer"
          target="_blank"
        >
          <SpotifyIcon aria-hidden="true" className="size-4" />
        </a>
      ) : null}
    </li>
  );
}
