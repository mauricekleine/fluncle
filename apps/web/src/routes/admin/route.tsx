import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { SIDEBAR_COOKIE_NAME, SidebarInset, SidebarProvider } from "@fluncle/ui/components/sidebar";
import { AdminSidebar, navKeyForPath } from "@/components/admin/admin-sidebar";
import { ConnectedToast } from "@/components/admin/connected-toast";
import { cn } from "@/lib/utils";

// The pathless layout route for every `/admin/*` surface, and the home of the
// PERSISTENT admin workspace shell (docs/admin-shell.md). The shell — the sidebar
// (the one nav surface + its live counts) and the content plate (the translucent
// glass pane over the cosmos) — is mounted HERE, once, wrapping the Outlet, so it
// survives navigation between stations: the sidebar's count query stays
// subscribed (badges never blink out and refetch) and the plate's backdrop-blur
// never re-composites (no background flash). Each guarded page renders only its
// header + body through the Outlet, via AdminShell.
//
// Login is the one exception: it's pre-auth, outside the fiction, a bare centered
// card (login.tsx) — so it bypasses the shell entirely. The admin guard stays
// per-page (it never wraps login).
//
// The shell reads the sidebar's persisted collapse state server-side (the shadcn
// sidebar writes it to a cookie on toggle) so SSR paints the right width with no
// hydration flash.
const readSidebarState = createServerFn({ method: "GET" }).handler(
  async () => getCookie(SIDEBAR_COOKIE_NAME) !== "false",
);

export const Route = createFileRoute("/admin")({
  component: AdminLayout,
  loader: async () => ({ sidebarOpen: await readSidebarState() }),
});

function AdminLayout() {
  const { sidebarOpen } = Route.useLoaderData();
  const { pathname } = useLocation();

  // Login sits under /admin by path but outside the workspace: no sidebar, no
  // plate, just its own centered card.
  if (pathname === "/admin/login") {
    return <Outlet />;
  }

  // The Studio is the one viewport-height, self-scrolling station (its two-pane
  // workstation owns its own scroll on lg+); every other page grows the plate and
  // scrolls the document.
  const fill = pathname === "/admin/studio" || pathname.startsWith("/admin/studio/");

  return (
    <SidebarProvider defaultOpen={sidebarOpen}>
      <AdminSidebar current={navKeyForPath(pathname)} />
      {/* min-w-0: a flex item defaults to min-width auto, so a wide body (the
          board's step grid) would inflate the inset past the viewport instead
          of scrolling inside its own overflow container. */}
      <SidebarInset
        className={cn("min-w-0 bg-transparent", fill && "lg:h-svh lg:max-h-svh lg:overflow-hidden")}
      >
        {/* The content plate — the glass pane. m-2 (not sm:m-3): its vertical
            inset must match the floating sidebar's fixed p-2 so plate and sidebar
            line up top and bottom (docs/admin-shell.md). */}
        <div
          className={cn(
            "m-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card/80 outline outline-1 outline-border/40 outline-offset-4 backdrop-blur-xl",
            fill && "lg:min-h-0",
          )}
        >
          <Outlet />
        </div>
      </SidebarInset>
      <ConnectedToast />
    </SidebarProvider>
  );
}
