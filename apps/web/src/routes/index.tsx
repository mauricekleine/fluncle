import {
  CalendarDots,
  CaretRight,
  CircleNotch,
  MusicNotes,
  SpotifyLogo,
  TelegramLogo,
} from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { type KeyboardEvent } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { spotifyPlaylistUrl, telegramUrl } from "@/lib/fluncle-links";
import { fetchTracks, type Track } from "@/lib/tracks";
import { cn } from "@/lib/utils";

const pageSize = 2;

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const [cursor, setCursor] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [tracks, setTracks] = useState<Track[]>([]);

  useEffect(() => {
    let isActive = true;

    fetchTracks({ limit: pageSize })
      .then((result) => {
        if (!isActive) {
          return;
        }

        setNextCursor(result.nextCursor);
        setTracks(result.tracks);
      })
      .catch((caughtError: unknown) => {
        if (!isActive) {
          return;
        }

        setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
      })
      .finally(() => {
        if (isActive) {
          setIsLoading(false);
        }
      });

    return () => {
      isActive = false;
    };
  }, []);

  async function loadMore(): Promise<void> {
    if (!nextCursor || isLoadingMore) {
      return;
    }

    setError(undefined);
    setIsLoadingMore(true);

    try {
      const result = await fetchTracks({
        cursor: nextCursor,
        limit: pageSize,
      });

      setCursor(nextCursor);
      setNextCursor(result.nextCursor);
      setTracks((currentTracks) => [...currentTracks, ...result.tracks]);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    } finally {
      setIsLoadingMore(false);
    }
  }

  const latestDate = useMemo(() => tracks[0]?.addedAt, [tracks]);

  return (
    <TooltipProvider>
      <main className="min-h-screen overflow-hidden bg-[var(--background)] text-[var(--foreground)]">
        <div className="site-glow" />
        <section className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-4 py-6 sm:px-6 lg:px-8">
          <header className="flex items-center justify-between gap-4 py-4">
            <a
              aria-label="Fluncle home"
              className="flex items-center gap-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              href="/"
            >
              <img
                alt=""
                className="size-11 rounded-md border border-[var(--cover-border)] object-cover"
                height="44"
                src="/fluncle-cover.png"
                width="44"
              />
              <span className="leading-tight">
                <span className="block text-lg font-bold tracking-normal">Fluncle</span>
                <span className="block text-sm text-[var(--muted-foreground)]">
                  Finest transmissions
                </span>
              </span>
            </a>

            <nav aria-label="Social links" className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <a
                      className={cn(buttonVariants({ size: "icon", variant: "ghost" }))}
                      href={spotifyPlaylistUrl}
                      rel="noreferrer"
                      target="_blank"
                    />
                  }
                >
                  <SpotifyLogo aria-hidden="true" size={22} weight="fill" />
                  <span className="sr-only">Open Spotify playlist</span>
                </TooltipTrigger>
                <TooltipContent>Open Spotify playlist</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <a
                      className={cn(buttonVariants({ size: "icon", variant: "ghost" }))}
                      href={telegramUrl}
                      rel="noreferrer"
                      target="_blank"
                    />
                  }
                >
                  <TelegramLogo aria-hidden="true" size={22} weight="fill" />
                  <span className="sr-only">Open Telegram channel</span>
                </TooltipTrigger>
                <TooltipContent>Open Telegram channel</TooltipContent>
              </Tooltip>
            </nav>
          </header>

          <div className="grid flex-1 content-center gap-10 py-8 lg:grid-cols-[280px_minmax(0,1fr)] lg:items-center">
            <aside className="mx-auto w-full max-w-72 lg:mx-0">
              <div className="cover-frame">
                <img
                  alt="Fluncle cover art"
                  className="aspect-square w-full rounded-lg object-cover"
                  height="512"
                  src="/fluncle-cover.png"
                  width="512"
                />
              </div>
              <div className="mt-5 flex items-center justify-center gap-2 lg:justify-start">
                <Button
                  nativeButton={false}
                  render={<a href={spotifyPlaylistUrl} rel="noreferrer" target="_blank" />}
                >
                  <SpotifyLogo aria-hidden="true" size={19} weight="fill" />
                  Play playlist
                </Button>
                <Button
                  nativeButton={false}
                  render={<a href={telegramUrl} rel="noreferrer" target="_blank" />}
                  variant="outline"
                >
                  <TelegramLogo aria-hidden="true" size={19} weight="fill" />
                  Telegram
                </Button>
              </div>
            </aside>

            <section aria-labelledby="playlist-title" className="min-w-0">
              <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--accent)]">
                    <MusicNotes aria-hidden="true" size={18} weight="fill" />
                    Drum & bass, freshly logged
                  </p>
                  <h1
                    className="max-w-2xl text-balance text-4xl font-black leading-[0.95] text-[var(--foreground)] sm:text-5xl"
                    id="playlist-title"
                  >
                    Fluncle's Finest
                  </h1>
                </div>
                {latestDate ? (
                  <p className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
                    <CalendarDots aria-hidden="true" size={17} />
                    Latest {formatDate(latestDate)}
                  </p>
                ) : undefined}
              </div>

              <div className="playlist-shell">
                <div className="playlist-header" role="row">
                  <span>Track</span>
                  <span className="hidden sm:block">Added</span>
                </div>

                {isLoading ? <LoadingRows /> : undefined}

                {!isLoading && tracks.length === 0 && !error ? (
                  <div className="empty-state">No transmissions found yet.</div>
                ) : undefined}

                {!isLoading && tracks.length > 0 ? (
                  <ol className="playlist-list">
                    {tracks.map((track, index) => (
                      <TrackRow index={index + 1} key={track.trackId} track={track} />
                    ))}
                  </ol>
                ) : undefined}
              </div>

              {error ? <p className="mt-4 text-sm text-[var(--danger)]">{error}</p> : undefined}

              {nextCursor ? (
                <div className="mt-5 flex justify-center">
                  <Button disabled={isLoadingMore} onClick={loadMore} variant="outline">
                    {isLoadingMore ? (
                      <CircleNotch aria-hidden="true" className="animate-spin" size={18} />
                    ) : undefined}
                    Load more
                  </Button>
                </div>
              ) : undefined}

              {cursor ? <span className="sr-only">Loaded through cursor {cursor}</span> : undefined}
            </section>
          </div>
        </section>
      </main>
    </TooltipProvider>
  );
}

function TrackRow({ index, track }: { index: number; track: Track }) {
  function openTrack(): void {
    window.open(track.spotifyUrl, "_blank", "noopener,noreferrer");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLLIElement>): void {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openTrack();
    }
  }

  return (
    <li
      aria-label={`Open ${track.artists.join(", ")} - ${track.title} on Spotify`}
      className="track-row"
      onClick={openTrack}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
    >
      <span className="track-index">{index.toString().padStart(2, "0")}</span>
      <span className="min-w-0">
        <span className="block text-pretty break-words font-semibold text-[var(--foreground)]">
          {track.title}
        </span>
        <span className="mt-1 block text-pretty break-words text-sm text-[var(--muted-foreground)]">
          {track.artists.join(", ")}
        </span>
        {track.note ? <span className="track-note">{track.note}</span> : undefined}
      </span>
      <time
        className="hidden text-right text-sm text-[var(--muted-foreground)] sm:block"
        dateTime={track.addedAt}
      >
        {formatDate(track.addedAt)}
      </time>
      <CaretRight aria-hidden="true" className="track-caret" size={18} weight="bold" />
    </li>
  );
}

function LoadingRows() {
  return (
    <div aria-label="Loading tracks" className="playlist-list" role="status">
      {Array.from({ length: 6 }).map((_, index) => (
        <div className="track-row is-loading" key={index}>
          <span className="track-index">--</span>
          <span className="min-w-0">
            <span className="loading-line w-2/3" />
            <span className="loading-line mt-3 w-1/3" />
          </span>
          <span className="hidden justify-self-end sm:block">
            <span className="loading-line w-16" />
          </span>
        </div>
      ))}
    </div>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  }).format(new Date(value));
}
