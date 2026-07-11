// Variant C — "Left rail".
// A persistent left spine on wide viewports (wordmark, vertical Explore + Listen,
// the quiet rows sunk to the bottom) that collapses to a top header on narrow
// screens. The archive as an app with a fixed trunk always in view.

import { type ReactNode } from "react";
import { NavBreadcrumb } from "@/components/nav/nav-breadcrumb";
import { NavFooter } from "@/components/nav/nav-footer";
import {
  NavPrimaryActions,
  NavQuietRows,
  NavSectionRow,
  NavWordmark,
  allSections,
  exploreSection,
} from "@/components/nav/nav-shared";

export function VariantRail({
  children,
  galaxiesLive,
  pathname,
}: {
  children: ReactNode;
  galaxiesLive: boolean;
  pathname: string;
}): ReactNode {
  const sections = allSections();

  return (
    <div className="nav-shell nav-shell--rail">
      {/* Narrow: the rail collapses to a slim top header with a scrollable Explore row. */}
      <header className="nav-railtop">
        <div className="nav-railtop-inner">
          <NavWordmark />
          <NavPrimaryActions compact />
        </div>
        <NavSectionRow
          className="nav-railtop-explore"
          galaxiesLive={galaxiesLive}
          section={exploreSection()}
        />
      </header>

      {/* Wide: the sticky spine. */}
      <aside className="nav-rail">
        <div className="nav-rail-top">
          <NavWordmark className="nav-wordmark nav-rail-wordmark" />
          <NavPrimaryActions />
        </div>
        <div className="nav-rail-sections">
          {sections
            .filter((section) => section.id !== "crew")
            .map((section) => (
              <div className="nav-rail-group" key={section.id}>
                <span className="nav-rail-grouplabel">{section.label}</span>
                <NavSectionRow
                  className="nav-rail-nav"
                  galaxiesLive={galaxiesLive}
                  section={section}
                />
              </div>
            ))}
        </div>
        <div className="nav-rail-bottom">
          <NavQuietRows />
        </div>
      </aside>

      <div className="nav-content nav-rail-content">
        <NavBreadcrumb pathname={pathname} />
        {children}
        <NavFooter galaxiesLive={galaxiesLive} />
      </div>
    </div>
  );
}
