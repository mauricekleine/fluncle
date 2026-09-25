import { siTwitch } from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";
import { Button } from "@fluncle/ui/components/button";

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
