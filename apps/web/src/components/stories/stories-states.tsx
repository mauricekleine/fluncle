import { CaretLeftIcon, CaretRightIcon, type Icon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { Button } from "@fluncle/ui/components/button";

function StoriesState({
  action,
  children,
  heading,
}: {
  action?: { Icon: Icon; label: string; to: "/findings" | "/tracks" };
  children: string;
  heading: string;
}) {
  const {
    Icon: ActionIcon,
    label,
    to,
  } = action ?? { Icon: CaretLeftIcon, label: "Back to the archive", to: "/findings" as const };

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
          <ActionIcon aria-hidden="true" weight="bold" />
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

export function TrackNotFoundState() {
  return (
    <StoriesState
      action={{ Icon: CaretRightIcon, label: "All tracks", to: "/tracks" }}
      heading="No track at this address"
    >
      That track didn&apos;t make it back, or it was never out there. Fluncle still holds every
      track that did.
    </StoriesState>
  );
}
