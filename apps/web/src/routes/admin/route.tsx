import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { SIDEBAR_COOKIE_NAME, SidebarInset, SidebarProvider } from "@fluncle/ui/components/sidebar";
import { AdminSidebar, navKeyForPath } from "@/components/admin/admin-sidebar";
import { ConnectedToast } from "@/components/admin/connected-toast";
import { cn } from "@/lib/utils";

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

  if (pathname === "/admin/login") {
    return <Outlet />;
  }

  const fill =
    pathname === "/admin/studio" ||
    pathname.startsWith("/admin/studio/") ||
    pathname === "/admin/chat";

  return (
    <SidebarProvider defaultOpen={sidebarOpen}>
      <AdminSidebar current={navKeyForPath(pathname)} />

      <SidebarInset
        className={cn("min-w-0 bg-transparent", fill && "lg:h-svh lg:max-h-svh lg:overflow-hidden")}
      >
        <div
          className={cn(
            "admin-workspace m-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card/80 outline outline-1 outline-border/40 outline-offset-4 backdrop-blur-xl",
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
