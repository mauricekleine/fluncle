import {
  CaretRightIcon,
  CircleNotchIcon,
  SpotifyLogoIcon,
  TelegramLogoIcon,
} from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TooltipProvider } from "@/components/ui/tooltip";
import { spotifyPlaylistUrl, telegramUrl } from "@/lib/fluncle-links";
import { fetchTracks, type Track } from "@/lib/tracks";

const pageSize = 10;

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const [cursor, setCursor] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [totalCount, setTotalCount] = useState(0);
  const [tracks, setTracks] = useState<Track[]>([]);

  useEffect(() => {
    let isActive = true;

    fetchTracks({ limit: pageSize })
      .then((result) => {
        if (!isActive) {
          return;
        }

        setNextCursor(result.nextCursor);
        setTotalCount(result.totalCount);
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

  useEffect(() => {
    console.log(
      "%cFLUNCLE",
      "font: 800 24px Oxanium, sans-serif; letter-spacing: -0.02em; color: #f5b800;",
    );
    console.log(
      `%cFresh drum & bass, most nights. Tune in → ${telegramUrl}`,
      "color: #b7ab95; font: 13px Oxanium, sans-serif;",
    );
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
      setTotalCount(result.totalCount);
      setTracks((currentTracks) => [...currentTracks, ...result.tracks]);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    } finally {
      setIsLoadingMore(false);
    }
  }

  const latestDate = useMemo(() => tracks[0]?.addedAt, [tracks]);
  const trackNumberBase = totalCount || tracks.length;

  return (
    <TooltipProvider>
      <main className="min-h-screen overflow-hidden text-foreground">
        <section className="mx-auto grid min-h-screen w-full max-w-7xl content-center gap-y-8 px-4 py-8 sm:px-6 lg:grid-cols-[minmax(240px,320px)_minmax(0,1fr)] lg:gap-x-12 lg:gap-y-10 lg:px-8">
          <div className="grid items-start gap-x-12 gap-y-8 lg:col-span-2 lg:grid-cols-subgrid">
            <aside className="mx-auto w-full max-w-80 lg:mx-0 lg:max-w-none">
              <div className="cover-frame border border-primary/40 p-1 rounded-lg">
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
                  className="flex-1"
                  nativeButton={false}
                  render={<a href={spotifyPlaylistUrl} rel="noreferrer" target="_blank" />}
                >
                  <SpotifyLogoIcon aria-hidden="true" weight="fill" />
                  Playlist
                </Button>
                <Button
                  className="flex-1"
                  nativeButton={false}
                  render={<a href={telegramUrl} rel="noreferrer" target="_blank" />}
                  variant="outline"
                >
                  <TelegramLogoIcon aria-hidden="true" weight="fill" />
                  Telegram
                </Button>
              </div>
            </aside>

            <section
              aria-labelledby="playlist-title"
              className="min-w-0"
            >
              <div className="playlist-shell border border-border rounded-lg">
                <div aria-hidden="true" className="playlist-header">
                  <span aria-hidden="true" />
                  <span aria-hidden="true" />
                  <span>Track</span>
                  <span className="hidden sm:block">Added</span>
                  <span aria-hidden="true" />
                </div>

                {isLoading ? <LoadingRows /> : undefined}

                {!isLoading && tracks.length === 0 && !error ? (
                  <div className="px-4 py-10 text-center text-muted-foreground">
                    No transmissions found yet.
                  </div>
                ) : undefined}

                {!isLoading && tracks.length > 0 ? (
                  <ScrollArea className="max-h-128 h-128">
                    <ol className="grid m-0 list-none p-0 [&>li:last-child_.track-row]:border-b-0">
                      {tracks.map((track, index) => (
                        <TrackRow
                          key={track.trackId}
                          track={track}
                          trackNumber={trackNumberBase - index}
                        />
                      ))}
                    </ol>
                  </ScrollArea>
                ) : undefined}
              </div>

              {error ? <p className="mt-4 text-sm text-destructive">{error}</p> : undefined}

              {nextCursor ? (
                <div className="mt-5 flex justify-center">
                  <Button disabled={isLoadingMore} onClick={loadMore} variant="outline">
                    {isLoadingMore ? (
                      <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
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

function TrackRow({ track, trackNumber }: { track: Track; trackNumber: number }) {
  return (
    <li>
      <a
        aria-label={`Open ${track.artists.join(", ")} - ${track.title} on Spotify`}
        className="track-row group/track"
        href={track.spotifyUrl}
        rel="noreferrer"
        target="_blank"
      >
        <span className="track-index">#{trackNumber.toString().padStart(2, "0")}</span>
        {track.albumImageUrl ? (
          <img alt="" className="track-artwork" loading="lazy" src={track.albumImageUrl} />
        ) : (
          <span aria-hidden="true" className="track-artwork track-artwork-fallback" />
        )}
        <span className="min-w-0">
          <span className="block text-[1.02rem] leading-[1.18] font-extrabold tracking-[-0.01em] text-pretty text-foreground [overflow-wrap:anywhere]">
            {track.title}
          </span>
          <span className="mt-[0.34rem] block text-[0.9rem] leading-[1.25] text-pretty text-muted-foreground [overflow-wrap:anywhere]">
            {track.artists.join(", ")}
          </span>
        </span>
        <time
          className="hidden justify-self-end text-right text-[0.82rem] leading-none font-bold text-muted-foreground tabular-nums sm:block"
          dateTime={track.addedAt}
        >
          {formatDate(track.addedAt)}
        </time>
        <CaretRightIcon
          aria-hidden="true"
          className="text-muted-foreground transition-transform duration-150 ease-out group-hover/track:translate-x-0.5 group-focus-visible/track:translate-x-0.5"
          size={18}
          weight="bold"
        />
      </a>
    </li>
  );
}

function LoadingRows() {
  return (
    <div
      aria-label="Loading tracks"
      className="grid m-0 list-none p-0 [&>.track-row:last-child]:border-b-0"
      role="status"
    >
      {Array.from({ length: 6 }).map((_, index) => (
        <div className="track-row pointer-events-none cursor-default" key={index}>
          <span className="track-index">--</span>
          <span className="track-artwork track-artwork-fallback" />
          <span className="min-w-0">
            <span className="block h-[0.85rem] w-2/3 animate-pulse rounded-full bg-border" />
            <span className="mt-3 block h-[0.85rem] w-1/3 animate-pulse rounded-full bg-border" />
          </span>
          <span className="hidden justify-self-end sm:block">
            <span className="block h-[0.85rem] w-16 animate-pulse rounded-full bg-border" />
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
