import { createFileRoute, Outlet } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { SIDEBAR_COOKIE_NAME } from "@fluncle/ui/components/sidebar";

// The pathless layout route for every `/admin/*` surface. It exists to make
// `/admin` (the board, in index.tsx) a real nested route alongside the focused
// stations and the unguarded front door (login), and to give them one place to
// share cross-surface concerns.
//
// The visible chrome — the sidebar workspace — lives in the AdminShell
// component each guarded page composes, NOT here: login must stay a bare
// centered card (it's pre-auth, outside the fiction), and the admin guard is
// per-page so it never wraps login. The one shared concern this layout owns is
// the sidebar's persisted collapse state: the shadcn sidebar writes it to a
// cookie on toggle, and reading that cookie server-side here lets SSR paint the
// right sidebar width with no hydration flash. Harmless for login (unused).
const readSidebarState = createServerFn({ method: "GET" }).handler(
  async () => getCookie(SIDEBAR_COOKIE_NAME) !== "false",
);

export const Route = createFileRoute("/admin")({
  component: () => <Outlet />,
  loader: async () => ({ sidebarOpen: await readSidebarState() }),
});
