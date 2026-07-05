import { CaretLeftIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { Button } from "@fluncle/ui/components/button";

// Quiet full-screen states for the Stories surface, sitting directly on the
// cosmos like every other pane (One Pane).
function StoriesState({ children, heading }: { children: string; heading: string }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6 text-foreground">
      <div className="playlist-shell empty-scanlines grid max-w-md gap-3 rounded-lg border border-border px-6 py-7 text-center">
        <h1 className="text-lg font-extrabold">{heading}</h1>
        <p className="text-sm text-muted-foreground">{children}</p>
        <Button
          className="mx-auto mt-1"
          nativeButton={false}
          render={<Link to="/" />}
          variant="outline"
        >
          <CaretLeftIcon aria-hidden="true" weight="bold" />
          Back to the archive
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
