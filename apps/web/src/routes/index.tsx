import { CircleNotchIcon, PlayIcon, UsersThreeIcon } from "@phosphor-icons/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  Link,
  createFileRoute,
  useCanGoBack,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { colors } from "@fluncle/tokens";
import { useCallback, useEffect, useRef } from "react";
import { HomeLinkHub } from "@/components/home/link-hub";
import { StoriesDialog } from "@/components/stories/stories-dialog";
import { TrackRow } from "@/components/track-row";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  discogsUrl,
  instagramUrl,
  lastfmUrl,
  mixcloudUrl,
  musicbrainzUrl,
  onionUrl,
  siteUrl,
  soundcloudUrl,
  spotifyPlaylistUrl,
  telegramUrl,
  tiktokUrl,
  twitchUrl,
  wikidataUrl,
  youtubeUrl,
} from "@/lib/fluncle-links";
import { fluncleAsciiLogo, fluncleDescription } from "@/lib/identity";
import { jsonLdScript } from "@/lib/json-ld";
import { type FeedItem } from "@/lib/mixtapes";
import { listTracks } from "@/lib/server/tracks";
import { fetchTracks, type TracksResponse } from "@/lib/tracks";
import { registerWebMcpTools } from "@/lib/webmcp";

const pageSize = 10;

type HomeSearch = {
  /** The Log ID of the story open in the dialog (masked to /log/<id>). */
  story?: string;
};

// Server-rendering the first page keeps the archive readable for crawlers
// (search engines and AI agents alike) that never execute JavaScript. Alongside
// it we resolve the newest finding WITH footage across the whole archive, so the
// cover's story ring opens the viewer at the latest story even when that story
// isn't on the first page (it usually isn't, once newer findings land before
// their footage does). Same ordering as the stories feed, so it lines up.
const fetchHomeData = createServerFn({ method: "GET" }).handler(async () => {
  const [page, latestStory] = await Promise.all([
    listTracks({ includeMixtapes: true, limit: pageSize }),
    listTracks({ hasVideo: true, limit: 1 }),
  ]);

  return { ...page, newestStoryLogId: latestStory.tracks[0]?.logId };
});

// Route options follow TanStack's create-route-property-order (each step feeds the
// next's inferred types), which isn't alphabetical — so sort-keys is off here.
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): HomeSearch => ({
    story: typeof search.story === "string" && search.story.length > 0 ? search.story : undefined,
  }),
  loader: () => fetchHomeData(),
  // Opening/closing the Stories dialog is a search-param change on this same
  // route; the feed's loader must not re-run per open (a reload would remount
  // the list and lose the scroll the dialog is supposed to preserve).
  shouldReload: false,
  head: ({ loaderData }) => ({
    // The self-referencing canonical lives on each leaf: TanStack merges the
    // root's and the leaf's `links` without deduping by rel, so a canonical in
    // __root.tsx would emit a duplicate on every other page.
    links: [
      { href: `${siteUrl}/`, rel: "canonical" },
      // Preload the cover — the homepage LCP element. Without this the browser
      // discovers it at Medium priority mid-parse; preloading at high priority
      // lets the fetch start immediately. The WebP variant is preloaded to match
      // the <picture> the page actually renders (the PNG stays the og: fallback).
      {
        as: "image",
        fetchPriority: "high",
        href: "/fluncle-cover.webp",
        rel: "preload",
        type: "image/webp",
      },
    ],
    // JSON-LD goes through `jsonLdScript`, which HTML-escapes the serialized
    // payload before it reaches the inline <script>'s `children` (rendered raw
    // via dangerouslySetInnerHTML), so untrusted Spotify titles/artists/album
    // can't break out of the <script> (stored-XSS sink, security review).
    scripts: [
      // The site-level entity block (no SearchAction: there is no search results
      // page, and schema must mirror what the page actually does).
      jsonLdScript({
        "@context": "https://schema.org",
        "@type": "WebSite",
        description: fluncleDescription,
        name: "Fluncle",
        url: `${siteUrl}/`,
      }),
      jsonLdScript({
        "@context": "https://schema.org",
        "@type": "MusicPlaylist",
        description: fluncleDescription,
        genre: "Drum and Bass",
        image: `${siteUrl}/fluncle-cover.png`,
        name: "Fluncle's Findings",
        numTracks: loaderData?.totalCount,
        // The full identity graph, matching /about's MusicGroup so the home
        // page (highest authority, hit first by crawlers) declares the same
        // corroboration anchors. Same order as /about so the entity reads
        // identically everywhere.
        sameAs: [
          spotifyPlaylistUrl,
          telegramUrl,
          tiktokUrl,
          instagramUrl,
          youtubeUrl,
          mixcloudUrl,
          soundcloudUrl,
          twitchUrl,
          onionUrl,
          musicbrainzUrl,
          wikidataUrl,
          lastfmUrl,
          discogsUrl,
        ],
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
        url: `${siteUrl}/`,
      }),
    ],
  }),
  component: HomePage,
});

// The cover's inner art, shared by both story-link targets below. Static, so
// it's built once at module load rather than rebuilt on every render.
const coverArt = (
  <>
    <span className="cover-story-gap">
      {/* WebP for the page; the PNG stays canonical for og:image and JSON-LD. */}
      <picture>
        <source srcSet="/fluncle-cover.webp" type="image/webp" />
        <img
          alt="Fluncle cover art"
          className="aspect-square w-full object-cover"
          // The LCP element: fetch it at high priority and never lazy-load it.
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

function HomePage() {
  const initialPage = Route.useLoaderData();
  const { story } = Route.useSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();

  // The feed reads through react-query so "Load more" pages stay cached. Seeded
  // with the SSR loader's first page (instant first paint, no fetch on mount).
  // Focus-refetch is intentionally OFF: the archive barely changes minute to
  // minute, and refetching every loaded page on tab-back would waste bandwidth
  // and risk a scroll jump for someone reading deep in the list.
  const {
    data,
    error: loadError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    // The loader's first page carries an extra newestStoryLogId (read separately
    // below); narrow it to the plain feed page the queryFn returns.
    initialData: { pageParams: [undefined], pages: [initialPage as TracksResponse] },
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchTracks({ cursor: pageParam, limit: pageSize }),
    queryKey: ["home-feed"],
    refetchOnWindowFocus: false,
  });

  const tracks = data.pages.flatMap((page) => page.tracks);
  const totalCount = data.pages.at(-1)?.totalCount ?? initialPage.totalCount;
  // The last consumed cursor, for the sr-only progress note below.
  const cursor = data.pageParams.at(-1) as string | undefined;
  const error = loadError
    ? loadError instanceof Error
      ? loadError.message
      : String(loadError)
    : undefined;

  // Close the dialog by going BACK to the feed's history entry: a fresh
  // navigate({ to: "/" }) would mint a new entry and scroll the feed to top.
  // The fallback covers a direct /?story= load where there is nothing behind.
  const closeStory = useCallback(() => {
    if (canGoBack) {
      router.history.back();
    } else {
      void navigate({ replace: true, search: {}, to: "/" });
    }
  }, [canGoBack, navigate, router]);

  // Per-flick URL sync: a masked REPLACE navigation (never a raw
  // replaceState, which would wipe the mask's __tempLocation state and swap
  // the screen to the standalone route). shouldReload: false on this route
  // keeps the loader quiet, so the flick stays cheap.
  const handleStoryChange = useCallback(
    (logId: string) => {
      void navigate({
        mask: { params: { logId }, to: "/log/$logId", unmaskOnReload: true },
        replace: true,
        resetScroll: false,
        search: { story: logId },
        to: "/",
      });
    },
    [navigate],
  );

  // The stories entry opens at the newest finding with footage — resolved on
  // the server across the whole archive (above), not just this first page.
  const newestStoryLogId = initialPage.newestStoryLogId;

  useEffect(() => {
    console.log(
      `%c${fluncleAsciiLogo}`,
      `font: 800 10px ui-monospace, SFMono-Regular, Menlo, monospace; line-height: 1; color: ${colors.eclipseGold};`,
    );
    console.log(
      `%cFresh bangers, most nights. Tune in, junglist → ${telegramUrl}`,
      `color: ${colors.stardust}; font: 13px Oxanium, sans-serif;`,
    );
    // WebMCP: hand agent-driving browsers the same controls humans get.
    registerWebMcpTools();
  }, []);

  const loadMoreSentinelRef = useRef<HTMLLIElement | null>(null);

  // Auto-fetch when the load-more row drifts near the viewport bottom. The row
  // stays clickable as a manual fallback; the observer re-arms after each page
  // settles, so a short first page keeps filling until the pane has overflow.
  // After a fetch error, auto mode pauses until a manual click clears it, so a
  // failing API isn't hammered in a retry loop.
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
        {/* A0: the page as ONE recovered logbook plate — a real masthead, the
            cover and the list mounted flat on a single document (the silhouette
            change; DESIGN.md). The plate sizes to its taller column: the feed
            self-bounds to a viewport and scrolls within, the left column is its
            natural height (no scroll). my-auto centres the plate when it fits
            and lets the page scroll when the left column makes it taller. */}
        <article className="home-plate mx-auto my-6 w-full max-w-7xl sm:my-8 lg:my-auto">
          <header className="home-masthead">
            <div>
              <h1 className="home-nameplate">Fluncle's Findings</h1>
              <p className="home-tagline">Drum & bass bangers from another dimension.</p>
            </div>
            <div className="home-masthead-actions">
              {/* Join the Crew — the conventional top-right sign-up slot, wearing
                  the glowing moving border (.crew-glow). Outline, not a gold fill,
                  so the One Sun stays the Galaxy CTA's. */}
              <Button
                className="crew-glow"
                nativeButton={false}
                render={<Link aria-label="Join the Crew" to="/account" />}
                variant="outline"
              >
                <UsersThreeIcon aria-hidden="true" weight="bold" />
                Join the Crew
              </Button>
            </div>
          </header>
          <section className="grid gap-y-8 lg:min-h-0 lg:grid-cols-[minmax(240px,280px)_minmax(0,1fr)] lg:gap-x-10">
            <aside className="mx-auto flex w-full max-w-80 flex-col lg:mx-0 lg:max-w-none">
              {/* The cover IS the stories entry: a breathing gold ring + play
                  badge (the Instagram-story cue, Eclipse Gold only — One Sun).
                  Opens the viewer at the newest finding with footage; when none
                  has loaded yet it falls back to the full log, where they live. */}
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
                  to="/"
                >
                  {coverArt}
                </Link>
              ) : (
                <Link aria-label="Open Fluncle stories" className="cover-story" to="/log">
                  {coverArt}
                </Link>
              )}
              {/* The link hub: actions, then the quiet links pushed to the
                  bottom of the column. */}
              <HomeLinkHub />
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
                  // The first page never arrived: surface it here instead of a
                  // blank field. (Once any track has loaded, an error on a later
                  // page is shown by the note below the field.)
                  <div className="empty-scanlines px-4 py-10 text-center text-muted-foreground">
                    <p>Couldn't reach the archive. The findings didn't make the trip back.</p>
                    <p className="mt-1 text-destructive">{error}</p>
                  </div>
                ) : undefined}

                {tracks.length > 0 ? (
                  // The feed sizes to its content but never taller than ~a viewport (max-height,
                  // not a fixed height — so a short list doesn't leave empty padding below it),
                  // scrolling internally past that. It therefore never grows the plate beyond a
                  // viewport; the plate sizes to the taller column and the left column is simply
                  // its natural height. On mobile the rows are wider than the screen, so it also
                  // scrolls horizontally (see .track-row min-width).
                  <ScrollArea className="max-h-[min(32rem,60dvh)] lg:max-h-[max(calc(100dvh-24rem),39rem)]">
                    <ol className="grid m-0 list-none p-0 [&>li:last-child.track-row]:border-b-0">
                      {tracks.map((track, index) => (
                        <TrackRow
                          key={track.type === "mixtape" ? (track.logId ?? track.id) : track.trackId}
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
