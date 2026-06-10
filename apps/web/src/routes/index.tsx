import {
  CircleNotchIcon,
  SpotifyLogoIcon,
  TelegramLogoIcon,
  XLogoIcon,
} from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { colors } from "@fluncle/tokens";
import { useCallback, useEffect, useRef, useState } from "react";
import { CliInstallDialog } from "@/components/cli-install-dialog";
import { RandomBangerDialog } from "@/components/random-banger-dialog";
import { SubmitTrackDialog } from "@/components/submit-track-dialog";
import { SubscribeDialog } from "@/components/subscribe-dialog";
import { TerminalRaversDialog } from "@/components/terminal-ravers-dialog";
import { TrackRow } from "@/components/track-row";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TooltipProvider } from "@/components/ui/tooltip";
import { siteUrl, spotifyPlaylistUrl, telegramUrl } from "@/lib/fluncle-links";
import { listTracks } from "@/lib/server/tracks";
import { fetchTracks, type Track } from "@/lib/tracks";
import { registerWebMcpTools } from "@/lib/webmcp";

const pageSize = 10;

// Server-rendering the first page keeps the archive readable for crawlers
// (search engines and AI agents alike) that never execute JavaScript.
const fetchInitialTracks = createServerFn({ method: "GET" }).handler(() =>
  listTracks({ limit: pageSize }),
);

export const Route = createFileRoute("/")({
  component: HomePage,
  head: ({ loaderData }) => ({
    scripts: [
      {
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "MusicPlaylist",
          description: "Drum & bass bangers from another dimension.",
          genre: "Drum and Bass",
          image: `${siteUrl}/fluncle-cover.png`,
          name: "Fluncle's Findings",
          numTracks: loaderData?.totalCount,
          sameAs: [spotifyPlaylistUrl, telegramUrl],
          track: loaderData?.tracks.map((track) => ({
            "@type": "MusicRecording",
            byArtist: track.artists.map((artist) => ({
              "@type": "MusicGroup",
              name: artist,
            })),
            ...(track.album ? { inAlbum: { "@type": "MusicAlbum", name: track.album } } : {}),
            name: track.title,
            url: track.spotifyUrl,
          })),
          url: `${siteUrl}/`,
        }),
        type: "application/ld+json",
      },
    ],
  }),
  loader: () => fetchInitialTracks(),
});

function HomePage() {
  const initialPage = Route.useLoaderData();
  const [cursor, setCursor] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>(initialPage.nextCursor);
  const [totalCount, setTotalCount] = useState(initialPage.totalCount);
  const [tracks, setTracks] = useState<Track[]>(initialPage.tracks);

  useEffect(() => {
    console.log(
      "%cFLUNCLE",
      `font: 800 24px Oxanium, sans-serif; letter-spacing: -0.02em; color: ${colors.eclipseGold};`,
    );
    console.log(
      `%cFresh bangers, most nights. Tune in, junglist → ${telegramUrl}`,
      `color: ${colors.stardust}; font: 13px Oxanium, sans-serif;`,
    );
    // WebMCP: hand agent-driving browsers the same controls humans get.
    registerWebMcpTools();
  }, []);

  const loadMore = useCallback(async (): Promise<void> => {
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
  }, [isLoadingMore, nextCursor]);

  const loadMoreSentinelRef = useRef<HTMLLIElement | null>(null);

  // Auto-fetch when the load-more row drifts near the viewport bottom. The row
  // stays clickable as a manual fallback; the observer re-arms after each page
  // settles, so a short first page keeps filling until the pane has overflow.
  // After a fetch error, auto mode pauses until a manual click clears it, so a
  // failing API isn't hammered in a retry loop.
  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;

    if (!sentinel || !nextCursor || isLoadingMore || error) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMore();
        }
      },
      {
        root: sentinel.closest("[data-slot='scroll-area-viewport']"),
        rootMargin: "240px",
      },
    );

    observer.observe(sentinel);

    return () => {
      observer.disconnect();
    };
  }, [error, isLoadingMore, loadMore, nextCursor]);

  const trackNumberBase = totalCount || tracks.length;

  return (
    <TooltipProvider>
      <main className="min-h-screen overflow-hidden text-foreground">
        <h1 className="sr-only">Fluncle's Findings</h1>
        <section className="mx-auto grid min-h-screen w-full max-w-7xl content-center gap-y-8 px-4 py-8 sm:px-6 lg:grid-cols-[minmax(240px,320px)_minmax(0,1fr)] lg:gap-x-12 lg:gap-y-10 lg:px-8">
          <div className="grid gap-x-12 gap-y-8 lg:col-span-2 lg:grid-cols-subgrid">
            <aside className="mx-auto w-full max-w-80 lg:mx-0 lg:max-w-none">
              <div className="cover-frame border border-primary/40 p-1 rounded-lg">
                {/* WebP for the page; the PNG stays canonical for og:image and JSON-LD. */}
                <picture>
                  <source srcSet="/fluncle-cover.webp" type="image/webp" />
                  <img
                    alt="Fluncle cover art"
                    className="aspect-square w-full rounded-lg object-cover"
                    height="512"
                    src="/fluncle-cover.png"
                    width="512"
                  />
                </picture>
              </div>
              <div className="mt-5 flex items-center justify-center gap-2 lg:justify-start">
                <Button
                  className="flex-1"
                  nativeButton={false}
                  render={<a href={spotifyPlaylistUrl} rel="noreferrer" target="_blank" />}
                  size="lg"
                >
                  <SpotifyLogoIcon aria-hidden="true" weight="fill" />
                  Playlist
                </Button>
                <Button
                  className="flex-1"
                  nativeButton={false}
                  render={<a href={telegramUrl} rel="noreferrer" target="_blank" />}
                  size="lg"
                  variant="outline"
                >
                  <TelegramLogoIcon aria-hidden="true" weight="fill" />
                  Telegram
                </Button>
                <RandomBangerDialog />
              </div>
              <div className="mt-3 grid gap-2">
                <SubmitTrackDialog />
                <SubscribeDialog />
                <Button
                  nativeButton={false}
                  render={<a href="https://x.com/mauricekleine" rel="noreferrer" target="_blank" />}
                  size="lg"
                  variant="outline"
                >
                  <XLogoIcon aria-hidden="true" weight="bold" />
                  DM me on X
                </Button>
                <div className="playlist-shell mt-1 grid gap-1 rounded-lg border border-border px-3.5 py-3">
                  <p className="text-xs font-extrabold text-muted-foreground">For the nerds:</p>
                  <div className="grid justify-items-start">
                    <CliInstallDialog />
                    <TerminalRaversDialog />
                  </div>
                </div>
              </div>
            </aside>

            <section aria-labelledby="playlist-title" className="flex min-w-0 flex-col">
              <h2 className="sr-only" id="playlist-title">
                Latest findings
              </h2>
              <div className="playlist-shell flex flex-1 flex-col border border-border rounded-md">
                <div aria-hidden="true" className="playlist-header">
                  <span>Log ID</span>
                  <span aria-hidden="true" />
                  <span>Track</span>
                  <span className="hidden sm:block">Found</span>
                  <span aria-hidden="true" />
                </div>

                {tracks.length === 0 && !error ? (
                  <div className="px-4 py-10 text-center text-muted-foreground">
                    No findings logged yet. Quiet sector tonight.
                  </div>
                ) : undefined}

                {tracks.length > 0 ? (
                  <ScrollArea className="h-[min(32rem,65dvh)] lg:h-[calc(100vh-8rem)]">
                    <ol className="grid m-0 list-none p-0 [&>li:last-child.track-row]:border-b-0">
                      {tracks.map((track, index) => (
                        <TrackRow
                          key={track.trackId}
                          track={track}
                          trackNumber={trackNumberBase - index}
                        />
                      ))}
                      {nextCursor ? (
                        <li ref={loadMoreSentinelRef}>
                          <button
                            className="flex min-h-14 w-full cursor-pointer items-center justify-center gap-2 text-sm font-bold text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default"
                            disabled={isLoadingMore}
                            onClick={loadMore}
                            type="button"
                          >
                            {isLoadingMore ? (
                              <CircleNotchIcon
                                aria-hidden="true"
                                className="animate-spin"
                                weight="bold"
                              />
                            ) : undefined}
                            {isLoadingMore ? "Loading more tracks" : "Load more"}
                          </button>
                        </li>
                      ) : undefined}
                    </ol>
                  </ScrollArea>
                ) : undefined}
              </div>

              {error ? <p className="mt-4 text-sm text-destructive">{error}</p> : undefined}

              {cursor ? <span className="sr-only">Loaded through cursor {cursor}</span> : undefined}
            </section>
          </div>
        </section>
      </main>
    </TooltipProvider>
  );
}
