import { siTwitch } from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";
import { Button } from "@fluncle/ui/components/button";

// The live-set callout — the one loud, ephemeral beat (DESIGN.md "The Live
// Exception"). It rides above the masthead ONLY while Fluncle is on the decks and
// renders nothing otherwise, so the home page stays gold-and-quiet the rest of the
// time. Nebula Violet is the one sanctioned second light; it lives here and nowhere
// else. SSR'd from the home loader's `getLiveState()` read (no flash, no fetch on
// mount), and reduced-motion-safe: the pulse is gated behind `motion-safe`.

// The staleness-adjusted live state the home loader hands down (mirror of
// `LiveState` in lib/server/live.ts; kept local so the client bundle pulls no
// server module).
type LiveCallout = {
  on: boolean;
  title: string | null;
  startedAt: string | null;
  url: string;
};

export function LiveBanner({ live }: { live: LiveCallout }) {
  if (!live.on) {
    return null;
  }

  return (
    <aside
      aria-label="Fluncle is live on Twitch"
      className="live-banner mx-auto mb-4 flex w-full max-w-7xl flex-col gap-3 rounded-lg border px-4 py-3 sm:mb-6 sm:flex-row sm:items-center sm:gap-4"
    >
      {/* The live pulse — a Nebula-Violet dot with a ping ring that only animates
          when motion is allowed (the dot stays put under prefers-reduced-motion). */}
      <span aria-hidden="true" className="relative flex size-2.5 shrink-0 sm:self-center">
        <span
          className="absolute inline-flex size-full rounded-full opacity-75 motion-safe:animate-ping"
          style={{ backgroundColor: "var(--nebula-violet)" }}
        />
        <span
          className="relative inline-flex size-2.5 rounded-full"
          style={{ backgroundColor: "var(--nebula-violet)" }}
        />
      </span>

      <div className="min-w-0 flex-1">
        <p className="font-semibold" style={{ color: "var(--nebula-violet)" }}>
          I'm on the decks right now.
        </p>
        <p className="text-sm text-muted-foreground">
          Mixing live. Come through, cosmonauts.
          {live.title ? <span className="text-muted-foreground/80"> “{live.title}”</span> : null}
        </p>
      </div>

      <Button
        className="live-cta shrink-0"
        nativeButton={false}
        render={<a aria-label="Watch on Twitch" href={live.url} rel="noreferrer" target="_blank" />}
        variant="outline"
      >
        <BrandIcon icon={siTwitch} />
        Watch on Twitch
      </Button>
    </aside>
  );
}
