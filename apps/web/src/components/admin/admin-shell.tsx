import { type ReactNode } from "react";
import { AdminNav, type AdminNavCurrent } from "@/components/admin/admin-nav";
import { ConnectedToast } from "@/components/admin/connected-toast";
import { cn } from "@/lib/utils";

// The unified admin shell — one contained plate over the ambient cosmos, shared
// by the board (`/admin`), Posts, and Tag, so the three stop diverging between
// full-bleed and boxed. A pane sitting directly on the starfield (One Pane Rule):
// translucent card surface, Dust Line border, offset outline, backdrop blur.
//
// Two body modes via `fill`:
//   - default: a normal-height plate that grows with its content (the board, the
//     posting view) and scrolls the page.
//   - fill: a viewport-height plate whose body owns its own scrolling (the
//     tagging tool's three-pane layout). lg+ only — on a phone it falls back to
//     the growing layout so the controls stay reachable.
//
// The header (title + optional subtitle, an actions slot, and the nav) is
// identical on every surface; only the body differs.

type AdminShellProps = {
  /** The page body — a table, a board, or the tagging three-pane. */
  children: ReactNode;
  /** Which nav link is the current surface. */
  current: AdminNavCurrent;
  /** Viewport-height plate with a self-scrolling body (the tagging tool). */
  fill?: boolean;
  /** Header-right controls, left of the nav (e.g. the tagging list toggle). */
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
  return (
    <main
      className={cn(
        "min-h-dvh p-3 text-foreground sm:p-4 lg:p-6",
        fill && "lg:h-dvh lg:overflow-hidden",
      )}
    >
      <div
        className={cn(
          "mx-auto flex w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-border bg-card/80 outline outline-1 outline-border/40 outline-offset-4 backdrop-blur-xl",
          fill && "min-h-0 lg:h-full",
        )}
      >
        <header className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <h1 className="text-sm font-bold">{title}</h1>
            {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : undefined}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {headerActions}
            <AdminNav current={current} />
          </div>
        </header>

        {subheader}

        {children}
      </div>
      <ConnectedToast />
    </main>
  );
}
