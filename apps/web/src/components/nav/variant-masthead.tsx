// Variant A — "Masthead strip" (the shipped default).
// A quiet sticky top strip carries the primary Explore nav on every page; the shared
// footer holds full link equity. The everyday driver: the trunk is one glance away.

import { type ReactNode } from "react";
import { NavBreadcrumb } from "@/components/nav/nav-breadcrumb";
import { NavFooter } from "@/components/nav/nav-footer";
import {
  NavPrimaryActions,
  NavSectionRow,
  NavWordmark,
  exploreSection,
} from "@/components/nav/nav-shared";

export function VariantMasthead({
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
      <header className="nav-masthead">
        <div className="nav-masthead-inner">
          <NavWordmark />
          <NavSectionRow
            className="nav-masthead-explore"
            galaxiesLive={galaxiesLive}
            section={exploreSection()}
          />
          <NavPrimaryActions compact />
        </div>
      </header>

      <div className="nav-content">
        <NavBreadcrumb pathname={pathname} />
        {children}
      </div>

      <NavFooter galaxiesLive={galaxiesLive} />
    </div>
  );
}
