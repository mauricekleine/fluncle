import { Link, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { BrowseMenu } from "@/components/nav/browse-menu";
import { CrewSlot } from "@/components/nav/crew-slot";
import { NavBreadcrumb } from "@/components/nav/nav-breadcrumb";
import { NavFooter } from "@/components/nav/nav-footer";
import { PlayerBar } from "@/components/player/player-bar";
import { PublicToaster } from "@/components/public-toaster";
import { SavedTracksSync } from "@/components/saved-tracks-sync";
import { SearchProvider, SearchTrigger } from "@/components/search/search-command";
import { expirePageContinuation, pausePreview } from "@/lib/preview-player";

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

  galaxiesLive: boolean;
}): ReactNode {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  const accountTab = useRouterState({
    select: (state) => (state.location.search as { tab?: string }).tab,
  });
  const tail =
    pathname === "/account" && accountTab
      ? { saves: "Saves", settings: "Settings" }[accountTab]
      : undefined;

  const workbench = pathname === "/chat";
  const chromeless = isChromeless(pathname);

  useEffect(() => {
    if (chromeless) {
      pausePreview();
    }
  }, [chromeless]);

  const href = useRouterState({ select: (state) => state.location.href });

  useEffect(() => {
    expirePageContinuation(href);
  }, [href]);

  if (chromeless) {
    return <>{children}</>;
  }

  return (
    <SearchProvider>
      <div
        className={workbench ? "nav-shell nav-shell--workbench" : "nav-shell"}

        data-front-door={pathname === "/" ? "" : undefined}
      >
        <a className="skip-link" href="#content">
          Skip to the page
        </a>
        <header className="nav-topbar">
          <div className="nav-topbar-inner">
            <Link aria-label="Fluncle home" className="nav-wordmark" to="/">
              FLUNCLE
            </Link>
            <NavBreadcrumb pathname={pathname} tail={tail} />

            <BrowseMenu />
            <SearchTrigger showTrigger={pathname !== "/"} />
            <CrewSlot home={pathname === "/findings"} />
          </div>
        </header>

        <div className="nav-content" id="content" tabIndex={-1}>
          {children}
        </div>

        {workbench ? undefined : <NavFooter galaxiesLive={galaxiesLive} />}

        {pathname === "/mix" ? undefined : <PlayerBar />}
        <PublicToaster />
        <SavedTracksSync />
      </div>
    </SearchProvider>
  );
}
