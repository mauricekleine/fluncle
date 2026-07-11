// Variant D — "Chart drawer".
// One compact trigger opens a full navigation plate with every section AND archive
// search — the page stays uncluttered while the whole graph (and hundreds of
// artists) is one tap and one query away. Built for the larger catalog.

import { ListIcon } from "@phosphor-icons/react";
import { type ReactNode, useState } from "react";
import { NavBreadcrumb } from "@/components/nav/nav-breadcrumb";
import { NavFooter } from "@/components/nav/nav-footer";
import { NavSearch } from "@/components/nav/nav-search";
import {
  NavPrimaryActions,
  NavQuietRows,
  NavSectionRow,
  NavWordmark,
  allSections,
} from "@/components/nav/nav-shared";
import { Button } from "@fluncle/ui/components/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@fluncle/ui/components/sheet";

export function VariantDrawer({
  children,
  galaxiesLive,
  pathname,
}: {
  children: ReactNode;
  galaxiesLive: boolean;
  pathname: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const sections = allSections();

  return (
    <div className="nav-shell">
      <header className="nav-topbar">
        <div className="nav-topbar-inner">
          <NavWordmark />
          <Sheet onOpenChange={setOpen} open={open}>
            <SheetTrigger
              render={
                <Button aria-label="Open the chart" size="sm" variant="outline">
                  <ListIcon aria-hidden="true" weight="bold" />
                  <span className="nav-actions-label">Chart</span>
                </Button>
              }
            />
            <SheetContent className="nav-drawer" side="right">
              <SheetHeader>
                <SheetTitle>The chart</SheetTitle>
                <SheetDescription>Search the log, or wander the graph.</SheetDescription>
              </SheetHeader>

              <div className="nav-drawer-body">
                <NavSearch onNavigate={() => setOpen(false)} />

                <div className="nav-drawer-sections">
                  {sections.map((section) => (
                    <div className="nav-drawer-group" key={section.id}>
                      <span className="nav-rail-grouplabel">{section.label}</span>
                      <NavSectionRow
                        className="nav-drawer-nav"
                        galaxiesLive={galaxiesLive}
                        section={section}
                      />
                    </div>
                  ))}
                </div>

                <NavPrimaryActions />
                <NavQuietRows />
              </div>
            </SheetContent>
          </Sheet>
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
