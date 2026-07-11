// Variant B — "Logbook colophon".
// Chrome up top shrinks to just the wordmark + a jump-to-index affordance; the
// navigation weight moves to a large plate-grammar footer read like a record
// sleeve's liner notes. Keeps the cover the hero, banks crawl equity at the bottom.

import { ArrowDownIcon } from "@phosphor-icons/react";
import { type ReactNode } from "react";
import { NavBreadcrumb } from "@/components/nav/nav-breadcrumb";
import { NavFooter } from "@/components/nav/nav-footer";
import { NavWordmark } from "@/components/nav/nav-shared";

export function VariantColophon({
  children,
  galaxiesLive,
  pathname,
}: {
  children: ReactNode;
  galaxiesLive: boolean;
  pathname: string;
}): ReactNode {
  return (
    <div className="nav-shell">
      <header className="nav-topbar nav-topbar--minimal">
        <div className="nav-topbar-inner">
          <NavWordmark />
          <a className="nav-jump-index" href="#nav-colophon">
            Index
            <ArrowDownIcon aria-hidden="true" weight="bold" />
          </a>
        </div>
      </header>

      <div className="nav-content">
        <NavBreadcrumb pathname={pathname} />
        {children}
      </div>

      <div id="nav-colophon">
        <NavFooter galaxiesLive={galaxiesLive} look="colophon" />
      </div>
    </div>
  );
}
