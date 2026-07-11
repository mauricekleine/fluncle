// The site-wide 404 — the empty coordinate rendered as a black hole. A finding is a
// coordinate in the Galaxy; a 404 is a coordinate that resolves to nothing, which is
// exactly what a black hole is: the place where nothing is. And because the Galaxy
// game's black holes TELEPORT (apps/web/src/game/sim.ts — "not a death, a transport"),
// the page's action is canon-true: it throws the visitor at a real finding, a 404 that
// lands somewhere better than the page they were after.
//
// Mounted as the ROOT route's `notFoundComponent` (__root.tsx), so it renders for BOTH
// a genuinely-unmatched URL (fluncle.com/thispagedoesntexist) and any `notFound()` that
// bubbles up without a route-local state. The router sets the response to a real HTTP
// 404 whenever a notFound match is active (TanStack router-core), so this is never a
// soft-404; the noindex meta is belt-and-suspenders on top of the status.
//
// The black hole is three sprites from @fluncle/sprites' `void` set, layered: the tilted
// accretion disc (slowly spinning), the face-on event-horizon ring around a pure-black
// void (the still point — nothing is IN it), and the traveller's own Discman caught in
// orbit, falling in. All motion is gated to `prefers-reduced-motion: no-preference`; the
// still state is the same composition, just held.

import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { spriteUrl } from "@fluncle/sprites";
import { type ReactNode, useState } from "react";
import { Button } from "@fluncle/ui/components/button";
import { fetchRandomFindingLogId } from "@/lib/tracks";

const COPY = {
  // Active (I went looking / let me throw you), dry, no exclamation, turns to the crew,
  // and points forward at the throw. The teleport garnish rides the first-person prose,
  // never the button (the Chrome Rule keeps the control plainly literal).
  body: "I went looking and came up empty. Whatever sat here fell into the black hole a long time back, so let me throw you at a finding that actually lands.",
  // The quiet second escape (a ghost link, no gold — it never competes with the sun).
  browse: "Browse the log",
  // The heading carries the accessible meaning (the stage is decorative/aria-hidden).
  // "Nothing at this coordinate" is the canonical missing-coordinate phrase (it also
  // fronts the per-story StoryNotFoundState) — one voice for one kind of nothing.
  heading: "Nothing at this coordinate.",
  // The Chrome Rule: the control names its action in plain words. The One Sun — the
  // single lit action on the page (the gold Button).
  throwCta: "Take me to a finding",
  throwing: "Taking you there…",
} as const;

export function NotFoundBlackHole(): ReactNode {
  const router = useRouter();
  // Isomorphic: the requested path is known on the server too, so the dead-coordinate
  // line renders identically SSR and client (no hydration mismatch — reading
  // window.location here would have differed).
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [throwing, setThrowing] = useState(false);

  // The attempted path, framed as a coordinate that doesn't resolve. Dimmed to the
  // Unlit register (never gold): a coordinate Fluncle never certified.
  const deadCoordinate = `fluncle://${pathname.replace(/^\/+/, "")}`;

  // The throw. Progressive enhancement: the CTA is a real <a href="/log"> (so a
  // JS-off visitor still lands on the findings archive), and with JS this intercepts
  // to fetch a FRESH random coordinate every click and navigate straight to its log
  // page. A cmd/ctrl-click or an empty archive falls through to the honest href.
  async function handleThrow(event: React.MouseEvent<HTMLAnchorElement>): Promise<void> {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey) {
      return;
    }

    event.preventDefault();

    if (throwing) {
      return;
    }

    setThrowing(true);

    const logId = await fetchRandomFindingLogId();

    if (logId) {
      await router.navigate({ params: { logId }, to: "/log/$logId" });

      return;
    }

    // Empty archive (or a coordinate-less pick): honour the fallback rather than
    // stranding the click on a dead link.
    await router.navigate({ to: "/log" });
  }

  return (
    <main className="void404">
      <title>Nothing at this coordinate · Fluncle</title>
      <meta content="noindex, follow" name="robots" />

      <div aria-hidden="true" className="void404-stage">
        <span className="void404-glow" />
        <img
          alt=""
          className="void404-disc"
          src={spriteUrl({ collection: "void", id: "accretion" })}
        />
        <img
          alt=""
          className="void404-ring"
          src={spriteUrl({ collection: "void", id: "event-horizon" })}
        />
        <span className="void404-orbit">
          <img
            alt=""
            className="void404-debris"
            src={spriteUrl({ collection: "void", id: "discman" })}
          />
        </span>
      </div>

      <div className="void404-copy">
        <p className="void404-coord">{deadCoordinate}</p>
        <h1 className="void404-title">{COPY.heading}</h1>
        <p className="void404-body">{COPY.body}</p>
        <div className="void404-actions">
          <Button
            aria-busy={throwing}
            aria-live="polite"
            className="void404-throw"
            nativeButton={false}
            render={<a href="/log" onClick={handleThrow} />}
          >
            {throwing ? COPY.throwing : COPY.throwCta}
          </Button>
          <Link className="void404-browse" to="/log">
            {COPY.browse}
          </Link>
        </div>
      </div>
    </main>
  );
}
