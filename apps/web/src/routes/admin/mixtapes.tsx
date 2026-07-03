import { createFileRoute, redirect } from "@tanstack/react-router";

// `/admin/mixtapes` was renamed to `/admin/plans` (RFC plan→recording→mixtape §8): the old
// draft-mixtape editor became the PLAN editor (a plan is a videoless recording; a published
// mixtape is minted from a promoted take, not built here). This route survives only to
// redirect old links + bookmarks to the new surface.
export const Route = createFileRoute("/admin/mixtapes")({
  beforeLoad: () => {
    throw redirect({ to: "/admin/plans" });
  },
});
