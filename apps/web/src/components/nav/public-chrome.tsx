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
import { NavBreadcrumb } from "@/components/nav/nav-breadcrumb";
import { NavFooter } from "@/components/nav/nav-footer";
import { SearchTrigger } from "@/components/search/search-command";

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

  if (isChromeless(pathname)) {
    return <>{children}</>;
  }

  return (
    <div className="nav-shell">
      <header className="nav-topbar">
        <div className="nav-topbar-inner">
          <Link aria-label="Fluncle home" className="nav-wordmark" to="/">
            FLUNCLE
          </Link>
          <NavBreadcrumb pathname={pathname} />
          {/* The one control in the bar, banked to the far end so it never crowds the trail.
              It also mounts the ⌘K listener, which is why it lives in the chrome and not on a
              page: search has to be one keystroke away from every public surface. */}
          <SearchTrigger />
        </div>
      </header>

      <div className="nav-content">{children}</div>

      <NavFooter galaxiesLive={galaxiesLive} />
    </div>
  );
}
