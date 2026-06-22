import { CircleNotchIcon, MagnifyingGlassIcon, PaperPlaneTiltIcon } from "@phosphor-icons/react";
import { type FormEvent, useReducer, useState } from "react";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { searchTracks, submitTrack, type SearchResult } from "@/lib/submissions";

type FormState = {
  contact: string;
  didSubmit: boolean;
  error: string | undefined;
  isSearching: boolean;
  isSubmitting: boolean;
  note: string;
  query: string;
  results: SearchResult[];
  selected: SearchResult | undefined;
  website: string;
};

type FormAction =
  | { fields: Partial<FormState>; type: "patch" }
  | { type: "searchFailed"; error: string }
  | { type: "searchStarted" }
  | { results: SearchResult[]; type: "searchSucceeded" }
  | { type: "submitFailed"; error: string }
  | { type: "submitStarted" }
  | { type: "submitSucceeded" };

const initialFormState: FormState = {
  contact: "",
  didSubmit: false,
  error: undefined,
  isSearching: false,
  isSubmitting: false,
  note: "",
  query: "",
  results: [],
  selected: undefined,
  website: "",
};

function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case "patch":
      return { ...state, ...action.fields };
    case "searchStarted":
      return {
        ...state,
        didSubmit: false,
        error: undefined,
        isSearching: true,
        selected: undefined,
      };
    case "searchSucceeded":
      return { ...state, isSearching: false, results: action.results };
    case "searchFailed":
      return { ...state, error: action.error, isSearching: false, results: [] };
    case "submitStarted":
      return { ...state, error: undefined, isSubmitting: true };
    case "submitSucceeded":
      return {
        ...state,
        contact: "",
        didSubmit: true,
        isSubmitting: false,
        note: "",
        query: "",
        results: [],
        selected: undefined,
        website: "",
      };
    case "submitFailed":
      return { ...state, error: action.error, isSubmitting: false };
    default:
      return state;
  }
}

/**
 * Defaults to a full outline "Submit a track" button. Pass `className` (e.g.
 * `w-full` or `flex-1`) to size it within a row; `compact` renders a tooltip'd
 * icon trigger for the tightest layouts.
 */
export function SubmitTrackDialog({
  className,
  compact = false,
}: { className?: string; compact?: boolean } = {}) {
  const [open, setOpen] = useState(false);
  const [state, dispatch] = useReducer(formReducer, initialFormState);
  const {
    contact,
    didSubmit,
    error,
    isSearching,
    isSubmitting,
    note,
    query,
    results,
    selected,
    website,
  } = state;

  async function handleSearch(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmedQuery = query.trim();

    if (!trimmedQuery) {
      dispatch({ fields: { error: "Enter a Spotify URL or track search." }, type: "patch" });
      return;
    }

    dispatch({ type: "searchStarted" });

    try {
      const candidates = await searchTracks(trimmedQuery);

      if (candidates.length === 0) {
        dispatch({ error: "No Spotify tracks found.", type: "searchFailed" });
        return;
      }

      dispatch({ results: candidates, type: "searchSucceeded" });
    } catch (caughtError) {
      dispatch({
        error: caughtError instanceof Error ? caughtError.message : String(caughtError),
        type: "searchFailed",
      });
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (!selected) {
      dispatch({ error: "Select a track first.", type: "submitFailed" });
      return;
    }

    dispatch({ type: "submitStarted" });

    try {
      await submitTrack({
        candidate: selected,
        contact,
        honeypot: website,
        note,
      });
      dispatch({ type: "submitSucceeded" });
    } catch (caughtError) {
      dispatch({
        error: caughtError instanceof Error ? caughtError.message : String(caughtError),
        type: "submitFailed",
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {compact ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <DialogTrigger
                render={<Button aria-label="Submit a track" size="icon-lg" variant="outline" />}
              />
            }
          >
            <PaperPlaneTiltIcon aria-hidden="true" weight="bold" />
          </TooltipTrigger>
          <TooltipContent>Submit a track</TooltipContent>
        </Tooltip>
      ) : (
        <DialogTrigger render={<Button className={className} size="lg" variant="outline" />}>
          <PaperPlaneTiltIcon aria-hidden="true" weight="bold" />
          Submit a track
        </DialogTrigger>
      )}
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
              onChange={(event) =>
                dispatch({ fields: { query: event.target.value }, type: "patch" })
              }
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
                    onClick={() => dispatch({ fields: { selected: result }, type: "patch" })}
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
                onChange={(event) =>
                  dispatch({ fields: { note: event.target.value }, type: "patch" })
                }
                value={note}
              />
            </Label>
            <Label className="grid gap-2 text-sm font-bold" htmlFor="track-contact">
              Contact
              <Input
                id="track-contact"
                maxLength={120}
                onChange={(event) =>
                  dispatch({ fields: { contact: event.target.value }, type: "patch" })
                }
                value={contact}
              />
            </Label>
            <HoneypotField
              id="track-website"
              onChange={(value) => dispatch({ fields: { website: value }, type: "patch" })}
              value={website}
            />
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
            Logged. I'll give it a listen.
          </p>
        ) : undefined}

        {error ? <p className="text-sm text-destructive">{error}</p> : undefined}
      </DialogContent>
    </Dialog>
  );
}
