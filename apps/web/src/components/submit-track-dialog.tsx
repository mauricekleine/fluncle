import { CircleNotchIcon, MagnifyingGlassIcon, PaperPlaneTiltIcon } from "@phosphor-icons/react";
import { type FormEvent, useState } from "react";
import { HoneypotField } from "@/components/honeypot-field";
import { TrackSummary } from "@/components/track-summary";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { searchTracks, submitTrack, type SearchResult } from "@/lib/submissions";

export function SubmitTrackDialog() {
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
      <DialogTrigger render={<Button size="lg" variant="outline" />}>
        <PaperPlaneTiltIcon aria-hidden="true" weight="bold" />
        Submit a track
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Submit a track</DialogTitle>
          <DialogDescription>
            Search Spotify, pick the match, and send it for review.
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-3" onSubmit={handleSearch}>
          <Label className="grid gap-2 text-sm font-bold" htmlFor="track-search">
            Search or Spotify URL
            <Input
              id="track-search"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Camo & Crooked or https://open.spotify.com/track/..."
              value={query}
            />
          </Label>
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
                    <TrackSummary
                      artists={result.artists}
                      artworkUrl={result.artworkUrl}
                      title={result.title}
                    />
                  </button>
                ))}
              </div>
            </ScrollArea>
          </div>
        ) : undefined}

        {selected ? (
          <form className="grid gap-3" onSubmit={handleSubmit}>
            <Label className="grid gap-2 text-sm font-bold" htmlFor="track-note">
              Note
              <Textarea
                id="track-note"
                maxLength={500}
                onChange={(event) => setNote(event.target.value)}
                value={note}
              />
            </Label>
            <Label className="grid gap-2 text-sm font-bold" htmlFor="track-contact">
              Contact
              <Input
                id="track-contact"
                maxLength={120}
                onChange={(event) => setContact(event.target.value)}
                value={contact}
              />
            </Label>
            <HoneypotField id="track-website" onChange={setWebsite} value={website} />
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
            Logged. Fluncle will give it a listen.
          </p>
        ) : undefined}

        {error ? <p className="text-sm text-destructive">{error}</p> : undefined}
      </DialogContent>
    </Dialog>
  );
}
