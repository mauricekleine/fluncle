import { type ReactNode } from "react";
import { SidebarTrigger } from "@fluncle/ui/components/sidebar";

// The per-page workspace header + body (docs/admin-shell.md). The PERSISTENT
// shell — the sidebar, the content plate, the cosmos backdrop — lives one level
// up in the /admin layout route (route.tsx) and stays mounted across navigation,
// so the sidebar's live counts and the plate's glass never re-mount or flash.
// Each guarded page renders THIS inside that plate (through the Outlet): the
// identical header row (the sidebar trigger, the title + optional subtitle, and
// the page-action slot top-right), an optional full-width subheader strip, then
// its body. Only these differ per surface; the frame around them does not.
//
// It renders as a fragment so the header, subheader, and body sit directly in
// the plate's flex column — the same layout the shell had when it owned the
// plate, minus the remount.

type AdminShellProps = {
  /** The page body — a board, a table, or the Studio's two-pane workstation. */
  children: ReactNode;
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
  headerActions,
  subheader,
  subtitle,
  title,
}: AdminShellProps) {
  return (
    <>
      {/* Fixed row height so the header never jumps between admin pages — a
          page-action button (Plans' "New plan") no longer makes the row taller
          than a button-less page. shrink-0 keeps it pinned when a fill page's
          body scrolls beneath it. */}
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border px-3 py-3 sm:px-4">
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
    </>
  );
}
