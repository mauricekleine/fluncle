import { getRouteApi } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@fluncle/ui/components/sidebar";
import { AdminSidebar, type AdminNavCurrent } from "@/components/admin/admin-sidebar";
import { ConnectedToast } from "@/components/admin/connected-toast";
import { cn } from "@/lib/utils";

// The admin workspace shell (docs/admin-shell.md) — every guarded admin page
// composes it. Full viewport, deliberately diverging from the public app's
// centered quiet register: the sidebar (the one nav surface, collapsible to an
// icon rail on desktop, a sheet on a phone) plus a content plate that fills the
// rest. The plate keeps the One-Pane grammar — a translucent pane sitting
// directly on the ambient cosmos (Dust Line border, offset outline, backdrop
// blur) — so the workspace still reads as Fluncle, just wider.
//
// Two body modes via `fill`:
//   - default: the plate fills the viewport and grows with its content; the
//     page scrolls.
//   - fill: a viewport-height plate whose body owns its own scrolling (the
//     Studio's two-pane workstation). lg+ only — on a phone it falls back to
//     the growing layout so the controls stay reachable.
//
// The header (the sidebar trigger, title + optional subtitle, and the
// page-action slot top-right) is identical on every surface; only the body
// differs. Sidebar collapse state persists via the sidebar cookie, read
// server-side by the /admin layout loader so SSR paints the right width.

const layoutRoute = getRouteApi("/admin");

type AdminShellProps = {
  /** The page body — a board, a table, or the Studio's two-pane workstation. */
  children: ReactNode;
  /** The sidebar entry this page OWNS (docs/admin-shell.md). */
  current: AdminNavCurrent;
  /** Viewport-height plate with a self-scrolling body (the Studio). */
  fill?: boolean;
  /** Page-level actions, top-right in the header (e.g. "New plan"). */
  headerActions?: ReactNode;
  /** A full-width strip directly under the header (e.g. the worklist tabs, an error). */
  subheader?: ReactNode;
  /** The quiet line under the title (counts, status). */
  subtitle?: ReactNode;
  /** The page heading. Quiet, small, bold — never a marketing masthead. */
  title: string;
};

export function AdminShell({
  children,
  current,
  fill = false,
  headerActions,
  subheader,
  subtitle,
  title,
}: AdminShellProps) {
  const { sidebarOpen } = layoutRoute.useLoaderData();

  return (
    <SidebarProvider defaultOpen={sidebarOpen}>
      <AdminSidebar current={current} />
      {/* min-w-0: a flex item defaults to min-width auto, so a wide body (the
          board's step grid) would inflate the inset past the viewport instead
          of scrolling inside its own overflow container. */}
      <SidebarInset
        className={cn("min-w-0 bg-transparent", fill && "lg:h-svh lg:max-h-svh lg:overflow-hidden")}
      >
        <div
          className={cn(
            "m-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card/80 outline outline-1 outline-border/40 outline-offset-4 backdrop-blur-xl sm:m-3",
            fill && "lg:min-h-0",
          )}
        >
          {/* Fixed row height so the header never jumps between admin pages — a
              page-action button (Plans' "New plan") no longer makes the row taller
              than a button-less page. Controls stay centered. */}
          <header className="flex min-h-14 items-center gap-2 border-b border-border px-3 py-3 sm:px-4">
            <SidebarTrigger className="shrink-0" />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-sm font-bold">{title}</h1>
              {subtitle ? (
                <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
              ) : undefined}
            </div>
            {headerActions ? (
              <div className="flex shrink-0 items-center gap-2">{headerActions}</div>
            ) : undefined}
          </header>

          {subheader}

          {children}
        </div>
      </SidebarInset>
      <ConnectedToast />
    </SidebarProvider>
  );
}
