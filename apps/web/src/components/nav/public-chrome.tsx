// The ONE mount point for the public navigation (mounted once in __root.tsx, inside
// the QueryClientProvider). The architecture is the LOGBOOK COLOPHON:
//
//   - a minimal top bar carrying the wordmark and, INLINE with it, the page's
//     breadcrumb — so the trail reads FLUNCLE › Log › 038.6.1J and the wordmark IS
//     the home crumb (no redundant "Home" link, no separate breadcrumb band);
//   - the whole nav weight banked in a liner-notes footer.
//
// The cover stays the hero. Admin and the full-bleed immersive surfaces opt out.

import { Link, useRouterState } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { CrewSlot } from "@/components/nav/crew-slot";
import { NavBreadcrumb } from "@/components/nav/nav-breadcrumb";
import { NavFooter } from "@/components/nav/nav-footer";
import { SearchProvider, SearchTrigger } from "@/components/search/search-command";

// Surfaces that render WITHOUT the public chrome:
// - /admin: its own AdminShell workspace chrome (never touched here).
// - /radio, /galaxy, /pipeline: full-bleed immersive experiences (the player, the game
//   canvas, the draggable machinery map). Each is a fixed inset-0 viewport that owns its
//   own chrome (its own bottom status bar), so a mounted colophon only overlaps it.
// - /device, /cli: bare auth / install flows.
const CHROMELESS_PREFIXES = ["/admin", "/radio", "/galaxy", "/pipeline", "/device", "/cli"];

function isChromeless(pathname: string): boolean {
  return CHROMELESS_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function PublicChrome({
  children,
  galaxiesLive,
}: {
  children: ReactNode;
  /**
   * Whether `/galaxies` is live — it 404s until the operator has named the WHOLE
   * sonic map, so the nav must not link it early. Resolved SERVER-SIDE in the root
   * loader, deliberately: a client-only gate keeps the link out of the SSR HTML,
   * which is exactly the hop a crawler needs to find the map.
   */
  galaxiesLive: boolean;
}): ReactNode {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // The /account tabs live in a search param, invisible to the path-based trail —
  // surface the open door as the breadcrumb's tail (FLUNCLE › Your account › Saves).
  const accountTab = useRouterState({
    select: (state) => (state.location.search as { tab?: string }).tab,
  });
  const tail =
    pathname === "/account" && accountTab
      ? { saves: "Saves", settings: "Settings" }[accountTab]
      : undefined;
  // The workbench register: /chat is a conversation, not a reading page — the shell
  // locks to the viewport (the transcript scrolls inside it) and the liner-notes
  // footer stays on the reading pages where a colophon belongs.
  const workbench = pathname === "/chat";

  if (isChromeless(pathname)) {
    return <>{children}</>;
  }

  return (
    // `SearchProvider` owns the ONE search dialog and the ONE ⌘K listener for every public page.
    // It wraps the whole shell rather than sitting inside the top bar, because a page under it
    // (the front door's seeding entry) reaches the same dialog through the context.
    <SearchProvider>
      <div
        className={workbench ? "nav-shell nav-shell--workbench" : "nav-shell"}
        // The front door stands the colophon's search glyph down (below), and carries no
        // breadcrumb either, so the bar needs a different element to take the slack. A plain
        // attribute rather than a class, and computed from the same pathname on both sides,
        // so it changes no element and hydration is untouched.
        data-front-door={pathname === "/" ? "" : undefined}
      >
        <header className="nav-topbar">
          <div className="nav-topbar-inner">
            <Link aria-label="Fluncle home" className="nav-wordmark" to="/">
              FLUNCLE
            </Link>
            <NavBreadcrumb pathname={pathname} tail={tail} />
            {/* The two controls, banked to the far end so they never crowd the trail. The
              provider above mounts the ⌘K listener, which is why it lives in the chrome and
              not on a page: search has to be one keystroke away from every public surface. The crew
              slot rides beside it — Join when signed out, the account door when signed in.
              `home` gates the Join glow to the page it was designed for (the ambient
              budget: no perpetual sweep on the gold-spending deep pages). It rides
              `/findings`, the archive page it was drawn for, and deliberately NOT the
              front door: `/` works fully anonymously and never sells joining as the
              outcome of arriving (PRODUCT.md "The front door"). */}
            {/* The colophon's glyph stands down on the FRONT DOOR, which carries a much larger
                door to the same action; two controls answering to one name on one screen is
                ambiguous by voice and redundant by eye. The slot still mounts the dialog, and
                ⌘K still works there. */}
            <SearchTrigger showTrigger={pathname !== "/"} />
            <CrewSlot home={pathname === "/findings"} />
          </div>
        </header>

        <div className="nav-content">{children}</div>

        {workbench ? undefined : <NavFooter galaxiesLive={galaxiesLive} />}
      </div>
    </SearchProvider>
  );
}
