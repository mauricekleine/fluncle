import { CaretLeftIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { Button } from "@fluncle/ui/components/button";

// Quiet full-screen states for the Stories surface, sitting directly on the
// cosmos like every other pane (One Pane).
function StoriesState({
  action,
  children,
  heading,
}: {
  /** Where the one control goes, and what it says. Defaults to the archive. */
  action?: { label: string; to: "/findings" | "/tracks" };
  children: string;
  heading: string;
}) {
  const { label, to } = action ?? { label: "Back to the archive", to: "/findings" as const };

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 text-foreground">
      <div className="playlist-shell empty-scanlines grid max-w-md gap-3 rounded-lg border border-border px-6 py-7 text-center">
        <h1 className="text-lg font-extrabold">{heading}</h1>
        <p className="text-sm text-muted-foreground">{children}</p>
        <Button
          className="mx-auto mt-1"
          nativeButton={false}
          render={<Link to={to} />}
          variant="outline"
        >
          <CaretLeftIcon aria-hidden="true" weight="bold" />
          {label}
        </Button>
      </div>
    </main>
  );
}

export function StoryNotFoundState() {
  return (
    <StoriesState heading="Nothing at this coordinate">
      That story didn't survive the trip, or it never existed. The archive has everything that did.
    </StoriesState>
  );
}

/**
 * The `/track/<trackId>` 404 — its OWN state, and it has to be.
 *
 * Every other detail page shares `StoryNotFoundState`, whose line reads "Nothing at this
 * coordinate". A `/track` URL is definitionally NOT a coordinate: it is a recording's permanent
 * id, and a coordinate is what a finding has and this tier does not (docs/track-destination.md).
 * Borrowing that line would hand the unnamed tier the one piece of vocabulary the whole surface is
 * built to keep off it, and it would call the missing thing a "story", which it also is not.
 *
 * So this one stays in the catalogue register: it says plainly what is not there and where to look
 * instead, with no lore narration, and the control points at the whole list rather than at the
 * findings.
 */
export function TrackNotFoundState() {
  return (
    <StoriesState
      action={{ label: "Browse every track", to: "/tracks" }}
      heading="No track at this address"
    >
      The whole list is one click away, and search finds a track by name.
    </StoriesState>
  );
}
