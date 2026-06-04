import {
  CaretRightIcon,
  CheckIcon,
  CircleNotchIcon,
  CopyIcon,
  DownloadSimpleIcon,
  MagnifyingGlassIcon,
  PaperPlaneTiltIcon,
  SpotifyLogoIcon,
  TelegramLogoIcon,
  XLogoIcon,
} from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
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
import { TooltipProvider } from "@/components/ui/tooltip";
import { spotifyPlaylistUrl, telegramUrl } from "@/lib/fluncle-links";
import { searchTracks, submitTrack, type SearchResult } from "@/lib/submissions";
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
              </div>
              <div className="mt-3 grid gap-2">
                <SubmitTrackDialog />
                <CliInstallDialog />
                <Button
                  nativeButton={false}
                  render={<a href="https://x.com/mauricekleine" rel="noreferrer" target="_blank" />}
                  size="lg"
                  variant="ghost"
                >
                  <XLogoIcon aria-hidden="true" weight="bold" />
                  DM me on X
                </Button>
              </div>
            </aside>

            <section aria-labelledby="playlist-title" className="min-w-0">
              <h2 className="sr-only" id="playlist-title">
                Latest tracks
              </h2>
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
                  <ScrollArea className="h-[min(32rem,65dvh)]">
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
            Submission received.
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
      <Button nativeButton={false} render={<DialogTrigger />} size="lg" variant="ghost">
        <DownloadSimpleIcon aria-hidden="true" weight="bold" />
        Download the CLI
      </Button>
      <DialogContent className="sm:max-w-[32rem]">
        <DialogHeader>
          <DialogTitle>Install the Fluncle CLI</DialogTitle>
          <DialogDescription>
            One command installs it. The playlist follows you into the terminal.
          </DialogDescription>
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
