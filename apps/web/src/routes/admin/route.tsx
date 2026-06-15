import { createFileRoute, Outlet } from "@tanstack/react-router";

// The pathless layout route for every `/admin/*` surface. It exists to make
// `/admin` (the pipeline board, in index.tsx) a real nested route alongside the
// focused modes (posts, tag) and the unguarded front door (login), and to give
// them one place to share future cross-surface concerns.
//
// The visible chrome — the plate, width, header, and nav — lives in the
// AdminShell component each guarded page composes, NOT here: login must stay a
// bare centered card (it's pre-auth, outside the fiction), and the admin guard
// is per-page so it never wraps login. The layout is a thin passthrough.
export const Route = createFileRoute("/admin")({
  component: () => <Outlet />,
});
