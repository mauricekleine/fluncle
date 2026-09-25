import { CircleNotchIcon, PlayIcon } from "@phosphor-icons/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  Link,
  createFileRoute,
  useCanGoBack,
  useLoaderData,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { FindingsLinkHub } from "@/components/home/link-hub";
import { LiveBanner } from "@/components/home/live-banner";
import { StoriesDialog } from "@/components/stories/stories-dialog";
import { DiscoveryPlayableList } from "@/components/discovery-row";
import { TrackRow } from "@/components/track-row";
import { findingToDiscoveryTrack } from "@/lib/discovery-tracks";
import { ScrollArea } from "@fluncle/ui/components/scroll-area";
import { TooltipProvider } from "@fluncle/ui/components/tooltip";
import { printConsoleGreeting } from "@/lib/console-greeting";
import { fluncleEntityId, siteUrl } from "@/lib/fluncle-links";
import { fluncleDescription } from "@/lib/identity";
import { jsonLdScript } from "@/lib/json-ld";
import { type FeedItem } from "@/lib/mixtapes";
import { FINDINGS_PAGE_SIZE } from "@/lib/findings-feed";
import { fetchTracks, type TracksResponse } from "@/lib/tracks";
import { registerWebMcpTools } from "@/lib/webmcp";

type FindingsSearch = {
  story?: string;
};

const findingsPageUrl = `${siteUrl}/findings`;

const findingsTitle = "Every drum & bass finding, newest first · Fluncle";
const findingsDescription =
  "Every drum & bass banger Fluncle has certified, newest first, each one logged with the coordinate that names it.";

const fetchFindingsData = createServerFn({ method: "GET" }).handler(async () => {
  const { loadFindingsData } = await import("./-findings-data");
  return loadFindingsData();
});

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/findings")({
  validateSearch: (search: Record<string, unknown>): FindingsSearch => ({
    story: typeof search.story === "string" && search.story.length > 0 ? search.story : undefined,
  }),
  loader: () => fetchFindingsData(),

  shouldReload: false,
  head: ({ loaderData }) => ({
    links: [
      { href: findingsPageUrl, rel: "canonical" },

      {
        as: "image",
        fetchPriority: "high",
        href: "/fluncle-cover.webp",
        rel: "preload",
        type: "image/webp",
      },
    ],
    meta: [
      { title: findingsTitle },
      { content: findingsDescription, name: "description" },
      { content: findingsTitle, property: "og:title" },
      { content: findingsDescription, property: "og:description" },
      { content: `${siteUrl}/fluncle-cover.png`, property: "og:image" },
      { content: findingsPageUrl, property: "og:url" },
    ],

    scripts: [
      jsonLdScript({
        "@context": "https://schema.org",
        "@type": "MusicPlaylist",

        creator: { "@id": fluncleEntityId },
        description: fluncleDescription,
        genre: "Drum and Bass",
        image: `${siteUrl}/fluncle-cover.png`,
        name: "Fluncle's Findings",
        numTracks: loaderData?.totalCount,
        track: loaderData?.tracks.flatMap((track) => {
          if (track.type === "mixtape") {
            return [];
          }

          return [
            {
              "@type": "MusicRecording",
              byArtist: track.artists.map((artist) => ({
                "@type": "MusicGroup",
                name: artist,
              })),
              ...(track.album ? { inAlbum: { "@type": "MusicAlbum", name: track.album } } : {}),
              name: track.title,
              url: track.spotifyUrl,
            },
          ];
        }),
        url: findingsPageUrl,
      }),
    ],
  }),
  component: FindingsPage,
});

const coverArt = (
  <>
    <span className="cover-story-gap">
      <picture>
        <source srcSet="/fluncle-cover.webp" type="image/webp" />
        <img
          alt="Fluncle cover art"
          className="aspect-square w-full object-cover"

          fetchPriority="high"
          height="512"
          loading="eager"
          src="/fluncle-cover.png"
          width="512"
        />
      </picture>
    </span>
    <span aria-hidden="true" className="cover-story-badge">
      <PlayIcon className="size-3.5" weight="fill" />
    </span>
  </>
);

function FindingsPage() {
  const initialPage = Route.useLoaderData();

  const { galaxiesLive } = useLoaderData({ from: "__root__" });
  const { story } = Route.useSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();

  const {
    data,
    error: loadError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    getNextPageParam: (lastPage) => lastPage.nextCursor,

    initialData: { pageParams: [undefined], pages: [initialPage as TracksResponse] },
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchTracks({ cursor: pageParam, limit: FINDINGS_PAGE_SIZE }),
    queryKey: ["home-feed"],
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  const tracks = data.pages.flatMap((page) => page.tracks);
  const playableFeed = useMemo(
    () =>
      data.pages
        .flatMap((page) => page.tracks)
        .flatMap((item) => (item.type === "mixtape" ? [] : [findingToDiscoveryTrack(item)])),
    [data.pages],
  );

  const totalCount = data.pages[0]?.totalCount ?? initialPage.totalCount;

  const cursor = data.pageParams.at(-1) as string | undefined;
  const error = loadError
    ? loadError instanceof Error
      ? loadError.message
      : String(loadError)
    : undefined;

  const closeStory = useCallback(() => {
    if (canGoBack) {
      router.history.back();
    } else {
      void navigate({ replace: true, search: {}, to: "/findings" });
    }
  }, [canGoBack, navigate, router]);

  const handleStoryChange = useCallback(
    (logId: string) => {
      void navigate({
        mask: { params: { logId }, to: "/log/$logId", unmaskOnReload: true },
        replace: true,
        resetScroll: false,
        search: { story: logId },
        to: "/findings",
      });
    },
    [navigate],
  );

  const newestStoryLogId = initialPage.newestStoryLogId;

  const live = initialPage.live;

  useEffect(() => {
    printConsoleGreeting();

    registerWebMcpTools();
  }, []);

  const loadMoreSentinelRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;

    if (!sentinel || !hasNextPage || isFetchingNextPage || error) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void fetchNextPage();
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
  }, [error, fetchNextPage, hasNextPage, isFetchingNextPage]);

  const trackNumberBase = totalCount || tracks.length;

  return (
    <TooltipProvider>
      <main className="min-h-screen overflow-x-hidden p-4 text-foreground sm:p-6 lg:flex lg:flex-col lg:p-8">
        <LiveBanner live={live} />

        <article className="home-plate mx-auto my-6 w-full max-w-7xl sm:my-8 lg:my-auto">
          <header className="home-masthead">
            <div>
              <h1 className="home-nameplate">Fluncle's Findings</h1>
              <p className="home-tagline">Drum & bass bangers from another dimension.</p>
            </div>
          </header>
          <section className="grid gap-y-8 lg:min-h-0 lg:grid-cols-[minmax(240px,280px)_minmax(0,1fr)] lg:gap-x-10">
            <aside className="mx-auto flex w-full max-w-80 flex-col lg:mx-0 lg:max-w-none">
              {newestStoryLogId ? (
                <Link
                  aria-label="Open Fluncle stories"
                  className="cover-story"
                  mask={{
                    params: { logId: newestStoryLogId },
                    to: "/log/$logId",
                    unmaskOnReload: true,
                  }}
                  search={{ story: newestStoryLogId }}
                  to="/findings"
                >
                  {coverArt}
                </Link>
              ) : (
                <Link aria-label="Open Fluncle stories" className="cover-story" to="/log">
                  {coverArt}
                </Link>
              )}

              <FindingsLinkHub galaxiesLive={galaxiesLive} />
            </aside>

            <section aria-labelledby="playlist-title" className="flex min-w-0 flex-col lg:min-h-0">
              <h2 className="sr-only" id="playlist-title">
                Latest findings
              </h2>
              <div className="plate-field flex flex-1 flex-col border border-border rounded-md">
                <div aria-hidden="true" className="playlist-header">
                  <span>Log ID</span>
                  <span aria-hidden="true" />
                  <span>Track</span>
                  <span aria-hidden="true" />
                </div>

                {tracks.length === 0 && !error ? (
                  <div className="empty-scanlines px-4 py-10 text-center text-muted-foreground">
                    No findings logged yet. Quiet sector tonight.
                  </div>
                ) : undefined}

                {tracks.length === 0 && error ? (
                  <div className="empty-scanlines px-4 py-10 text-center text-muted-foreground">
                    <p>Couldn't reach the archive. The findings didn't make the trip back.</p>
                    <p className="mt-1 text-destructive">{error}</p>
                  </div>
                ) : undefined}

                {tracks.length > 0 ? (
                  <ScrollArea className="max-h-[min(32rem,60dvh)] lg:max-h-[max(calc(100dvh-24rem),39rem)]">
                    <DiscoveryPlayableList tracks={playableFeed}>
                      <ol className="grid m-0 list-none p-0 [&>li:last-child.track-row]:border-b-0">
                        {tracks.map((track, index) => (
                          <TrackRow
                            key={
                              track.type === "mixtape" ? (track.logId ?? track.id) : track.trackId
                            }
                            track={track}
                            trackNumber={fallbackFindingNumber(tracks, index, trackNumberBase)}
                          />
                        ))}
                        {hasNextPage ? (
                          <li ref={loadMoreSentinelRef}>
                            <button
                              className="flex min-h-14 w-full cursor-pointer items-center justify-center gap-2 text-sm font-bold text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default"
                              disabled={isFetchingNextPage}
                              onClick={() => void fetchNextPage()}
                              type="button"
                            >
                              {isFetchingNextPage ? (
                                <CircleNotchIcon
                                  aria-hidden="true"
                                  className="animate-spin"
                                  weight="bold"
                                />
                              ) : undefined}
                              {isFetchingNextPage ? "Loading more tracks" : "Load more"}
                            </button>
                          </li>
                        ) : undefined}
                      </ol>
                    </DiscoveryPlayableList>
                  </ScrollArea>
                ) : undefined}
              </div>

              {error && tracks.length > 0 ? (
                <p className="mt-4 text-sm text-destructive">{error}</p>
              ) : undefined}

              {cursor ? <span className="sr-only">Loaded through cursor {cursor}</span> : undefined}
            </section>
          </section>
        </article>

        <StoriesDialog
          initialLogId={story}
          onClose={closeStory}
          onStoryChange={handleStoryChange}
          open={Boolean(story)}
        />
      </main>
    </TooltipProvider>
  );
}

function fallbackFindingNumber(tracks: FeedItem[], index: number, trackNumberBase: number): number {
  if (tracks[index]?.type === "mixtape") {
    return trackNumberBase;
  }

  const findingsBefore = tracks.slice(0, index).filter((track) => track.type !== "mixtape").length;

  return trackNumberBase - findingsBefore;
}
