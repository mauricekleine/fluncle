import {
  CaretRightIcon,
  CheckIcon,
  CircleNotchIcon,
  CopyIcon,
  DownloadSimpleIcon,
  MagnifyingGlassIcon,
  PaperPlaneTiltIcon,
  ShuffleIcon,
  SpotifyLogoIcon,
  TelegramLogoIcon,
  TerminalIcon,
  XLogoIcon,
} from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { siteUrl, spotifyPlaylistUrl, telegramUrl } from "@/lib/fluncle-links";
import { listTracks } from "@/lib/server/tracks";
import { searchTracks, submitTrack, type SearchResult } from "@/lib/submissions";
import { fetchRandomTrack, fetchTracks, type Track } from "@/lib/tracks";

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
          name: "Fluncle's Finest",
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
      "font: 800 24px Oxanium, sans-serif; letter-spacing: -0.02em; color: #f5b800;",
    );
    console.log(
      `%cFresh bangers, most nights. Tune in, junglist → ${telegramUrl}`,
      "color: #b7ab95; font: 13px Oxanium, sans-serif;",
    );
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
        <h1 className="sr-only">Fluncle's Finest</h1>
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
                Latest bangers
              </h2>
              <div className="playlist-shell flex flex-1 flex-col border border-border rounded-md">
                <div aria-hidden="true" className="playlist-header">
                  <span aria-hidden="true" />
                  <span aria-hidden="true" />
                  <span>Track</span>
                  <span className="hidden sm:block">Discovered</span>
                  <span aria-hidden="true" />
                </div>

                {tracks.length === 0 && !error ? (
                  <div className="px-4 py-10 text-center text-muted-foreground">
                    No bangers discovered yet. Quiet night in this dimension.
                  </div>
                ) : undefined}

                {tracks.length > 0 ? (
                  <ScrollArea className="h-[min(32rem,65dvh)] lg:h-[calc(100vh-8rem)]">
                    <ol className="grid m-0 list-none p-0 [&>li:last-child_.track-row]:border-b-0">
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

function RandomBangerDialog() {
  const [open, setOpen] = useState(false);
  const [track, setTrack] = useState<Track | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(false);

  async function loadRandomTrack(): Promise<void> {
    setError(undefined);
    setIsLoading(true);

    try {
      setTrack(await fetchRandomTrack());
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    } finally {
      setIsLoading(false);
    }
  }

  function handleOpenChange(nextOpen: boolean): void {
    setOpen(nextOpen);

    if (nextOpen && !track && !isLoading) {
      void loadRandomTrack();
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Random banger"
              nativeButton={false}
              render={<DialogTrigger />}
              size="icon-lg"
              variant="outline"
            />
          }
        >
          <ShuffleIcon aria-hidden="true" weight="bold" />
        </TooltipTrigger>
        <TooltipContent>Random banger</TooltipContent>
      </Tooltip>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Random banger</DialogTitle>
          <DialogDescription>The archive throws one back.</DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex min-h-24 items-center justify-center gap-2 text-sm font-bold text-muted-foreground">
            <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
            Scanning the archive
          </div>
        ) : undefined}

        {!isLoading && track ? (
          <div className="grid gap-3">
            <div className="grid grid-cols-[3.25rem_minmax(0,1fr)] items-center gap-3 rounded-lg border border-border bg-secondary/50 p-2">
              {track.albumImageUrl ? (
                <img alt="" className="track-artwork" src={track.albumImageUrl} />
              ) : (
                <span aria-hidden="true" className="track-artwork track-artwork-fallback" />
              )}
              <span className="min-w-0">
                <span className="block text-sm font-extrabold [overflow-wrap:anywhere]">
                  {track.title}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {track.artists.join(", ")}
                </span>
              </span>
            </div>
            {track.note ? <p className="text-sm text-muted-foreground">{track.note}</p> : undefined}
            <div className="flex flex-wrap gap-2">
              <Button
                nativeButton={false}
                render={<a href={track.spotifyUrl} rel="noreferrer" target="_blank" />}
              >
                <SpotifyLogoIcon aria-hidden="true" weight="fill" />
                Open on Spotify
              </Button>
              <Button onClick={loadRandomTrack} type="button" variant="outline">
                <ShuffleIcon aria-hidden="true" weight="bold" />
                Another one
              </Button>
            </div>
          </div>
        ) : undefined}

        {error ? <p className="text-sm text-destructive">{error}</p> : undefined}
      </DialogContent>
    </Dialog>
  );
}

const sshCommand = "ssh rave.fluncle.com";

function TerminalRaversDialog() {
  const [didCopy, setDidCopy] = useState(false);
  const copyResetTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => clearTimeout(copyResetTimeout.current);
  }, []);

  async function copySshCommand(): Promise<void> {
    await navigator.clipboard.writeText(sshCommand);
    setDidCopy(true);
    clearTimeout(copyResetTimeout.current);
    copyResetTimeout.current = setTimeout(() => setDidCopy(false), 2000);
  }

  return (
    <Dialog>
      <DialogTrigger className="cli-link">
        <TerminalIcon aria-hidden="true" size={14} weight="bold" />
        ssh rave.fluncle.com
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Terminal ravers</DialogTitle>
          <DialogDescription>
            Browse tracks, submit bangers, and enter the Fluncle rave terminal.
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 gap-2">
          <p className="text-sm font-bold">Connect</p>
          <div className="flex min-w-0 items-center gap-2">
            <code className="cli-command min-w-0 flex-1 px-3 py-2.5">{sshCommand}</code>
            <Button
              aria-label="Copy SSH command"
              onClick={copySshCommand}
              size="icon"
              variant="outline"
            >
              {didCopy ? (
                <CheckIcon aria-hidden="true" className="text-primary" weight="bold" />
              ) : (
                <CopyIcon aria-hidden="true" weight="bold" />
              )}
            </Button>
          </div>
          <p aria-live="polite" className="sr-only">
            {didCopy ? "SSH command copied." : ""}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SubmitTrackDialog() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState<SearchResult | undefined>();
  const [note, setNote] = useState("");
  const [contact, setContact] = useState("");
  const [website, setWebsite] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [isSearching, setIsSearching] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [didSubmit, setDidSubmit] = useState(false);

  async function handleSearch(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmedQuery = query.trim();

    if (!trimmedQuery) {
      setError("Enter a Spotify URL or track search.");
      return;
    }

    setError(undefined);
    setDidSubmit(false);
    setSelected(undefined);
    setIsSearching(true);

    try {
      const candidates = await searchTracks(trimmedQuery);
      setResults(candidates);

      if (candidates.length === 0) {
        setError("No Spotify tracks found.");
      }
    } catch (caughtError) {
      setResults([]);
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    } finally {
      setIsSearching(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (!selected) {
      setError("Select a track first.");
      return;
    }

    setError(undefined);
    setIsSubmitting(true);

    try {
      await submitTrack({
        candidate: selected,
        contact,
        honeypot: website,
        note,
      });
      setDidSubmit(true);
      setResults([]);
      setSelected(undefined);
      setQuery("");
      setNote("");
      setContact("");
      setWebsite("");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button nativeButton={false} render={<DialogTrigger />} size="lg" variant="outline">
        <PaperPlaneTiltIcon aria-hidden="true" weight="bold" />
        Submit a track
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Submit a track</DialogTitle>
          <DialogDescription>
            Search Spotify, pick the match, and send it for review.
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-3" onSubmit={handleSearch}>
          <label className="grid gap-2 text-sm font-bold" htmlFor="track-search">
            Search or Spotify URL
            <input
              className="h-10 rounded-md border border-input bg-input px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
              id="track-search"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Camo & Crooked or https://open.spotify.com/track/..."
              value={query}
            />
          </label>
          <Button disabled={isSearching} type="submit" variant="outline">
            {isSearching ? (
              <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
            ) : (
              <MagnifyingGlassIcon aria-hidden="true" weight="bold" />
            )}
            Search
          </Button>
        </form>

        {results.length > 0 ? (
          <div className="grid gap-2">
            <p className="text-sm font-bold text-muted-foreground">Select a match</p>
            <ScrollArea viewportClassName="max-h-72">
              <div className="grid gap-2 pr-2">
                {results.map((result) => (
                  <button
                    className="grid grid-cols-[3.25rem_minmax(0,1fr)] items-center gap-3 rounded-lg border border-border bg-secondary/50 p-2 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/40 aria-pressed:border-primary"
                    key={result.id}
                    onClick={() => setSelected(result)}
                    type="button"
                    aria-pressed={selected?.id === result.id}
                  >
                    {result.artworkUrl ? (
                      <img alt="" className="track-artwork" src={result.artworkUrl} />
                    ) : (
                      <span aria-hidden="true" className="track-artwork track-artwork-fallback" />
                    )}
                    <span className="min-w-0">
                      <span className="block text-sm font-extrabold [overflow-wrap:anywhere]">
                        {result.title}
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground [overflow-wrap:anywhere]">
                        {result.artists.join(", ")}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </div>
        ) : undefined}

        {selected ? (
          <form className="grid gap-3" onSubmit={handleSubmit}>
            <label className="grid gap-2 text-sm font-bold" htmlFor="track-note">
              Note
              <textarea
                className="min-h-20 resize-y rounded-md border border-input bg-input px-3 py-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
                id="track-note"
                maxLength={500}
                onChange={(event) => setNote(event.target.value)}
                value={note}
              />
            </label>
            <label className="grid gap-2 text-sm font-bold" htmlFor="track-contact">
              Contact
              <input
                className="h-10 rounded-md border border-input bg-input px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
                id="track-contact"
                maxLength={120}
                onChange={(event) => setContact(event.target.value)}
                value={contact}
              />
            </label>
            <label aria-hidden="true" className="sr-only" htmlFor="track-website">
              Website
              <input
                autoComplete="off"
                id="track-website"
                onChange={(event) => setWebsite(event.target.value)}
                tabIndex={-1}
                value={website}
              />
            </label>
            <Button disabled={isSubmitting} type="submit">
              {isSubmitting ? (
                <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
              ) : (
                <PaperPlaneTiltIcon aria-hidden="true" weight="bold" />
              )}
              Send for review
            </Button>
          </form>
        ) : undefined}

        {didSubmit ? (
          <p className="rounded-md border border-primary/30 bg-accent px-3 py-2 text-sm text-accent-foreground">
            Received. Fluncle will give it a listen.
          </p>
        ) : undefined}

        {error ? <p className="text-sm text-destructive">{error}</p> : undefined}
      </DialogContent>
    </Dialog>
  );
}

const cliInstallCommand = "curl -fsSL https://www.fluncle.com/cli/latest.sh | sh";

const cliExamples = [
  { command: "fluncle --help", description: "See every command" },
  { command: "fluncle recent", description: "Latest tracks in your terminal" },
  { command: "fluncle open", description: "Open the playlist" },
  { command: "fluncle submit", description: "Send a track for review" },
];

function CliInstallDialog() {
  const [didCopy, setDidCopy] = useState(false);
  const copyResetTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => clearTimeout(copyResetTimeout.current);
  }, []);

  async function copyInstallCommand(): Promise<void> {
    await navigator.clipboard.writeText(cliInstallCommand);
    setDidCopy(true);
    clearTimeout(copyResetTimeout.current);
    copyResetTimeout.current = setTimeout(() => setDidCopy(false), 2000);
  }

  return (
    <Dialog>
      <DialogTrigger className="cli-link">
        <DownloadSimpleIcon aria-hidden="true" size={14} weight="bold" />
        install CLI
      </DialogTrigger>
      <DialogContent className="sm:max-w-[32rem]">
        <DialogHeader>
          <DialogTitle>Install the Fluncle CLI</DialogTitle>
          <DialogDescription>Same bangers, no browser.</DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 gap-2">
          <p className="text-sm font-bold">Install</p>
          <div className="flex min-w-0 items-center gap-2">
            <code className="cli-command min-w-0 flex-1 px-3 py-2.5">{cliInstallCommand}</code>
            <Button
              aria-label="Copy install command"
              onClick={copyInstallCommand}
              size="icon"
              variant="outline"
            >
              {didCopy ? (
                <CheckIcon aria-hidden="true" className="text-primary" weight="bold" />
              ) : (
                <CopyIcon aria-hidden="true" weight="bold" />
              )}
            </Button>
          </div>
          <p aria-live="polite" className="sr-only">
            {didCopy ? "Install command copied." : ""}
          </p>
        </div>
        <div className="grid min-w-0 gap-2">
          <p className="text-sm font-bold">Then try</p>
          <ul className="m-0 grid list-none gap-2 p-0">
            {cliExamples.map((example) => (
              <li className="flex items-baseline justify-between gap-3" key={example.command}>
                <code className="cli-inline">{example.command}</code>
                <span className="text-xs text-muted-foreground">{example.description}</span>
              </li>
            ))}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
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
          <span className="track-title block text-pretty [overflow-wrap:anywhere]">
            {track.title}
          </span>
          <span className="track-artist block text-pretty [overflow-wrap:anywhere]">
            {track.artists.join(", ")}
          </span>
        </span>
        <time
          className="track-date hidden justify-self-end text-right sm:block"
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

function formatDate(value: string): string {
  // Pinned locale and timezone so the server-rendered date matches hydration
  // on every client; VOICE.md's tabular convention is "Jun 4".
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}
