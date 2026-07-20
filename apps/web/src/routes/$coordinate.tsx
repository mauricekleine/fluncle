import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { canonicalCoordinate } from "@/lib/log-page-param";

// The bare-coordinate resolver. A viewer reads `fluncle://049.7.6B` off a video frame
// and types what they see — `fluncle.com/049.7.6B` — so the root resolves that straight
// to the finding's home at `/log/049.7.6B` (301, permanent). Captions keep the
// `fluncle://<coord>` scheme verbatim (the Chrome extension highlights it); this route
// only serves the human who types the coordinate into the address bar.
//
// GUARDED and case-insensitive: uppercase first, then match ONLY the finding + mixtape
// coordinate grammar (`canonicalCoordinate`). Anything else throws `notFound()` and
// falls through to the site-wide 404 (the root's NotFoundBlackHole at a real HTTP 404),
// exactly as a bare unknown segment does today. A single dynamic segment never shadows a
// static route (TanStack ranks static above dynamic) nor a deeper path (`/log/x` is two
// segments), so the real routes keep their precedence. Normalization past the coordinate
// (a trackId deep link) still happens once, at `/log`.
export const Route = createFileRoute("/$coordinate")({
  beforeLoad: ({ params }) => {
    const logId = canonicalCoordinate(params.coordinate);

    if (!logId) {
      throw notFound();
    }

    throw redirect({ params: { logId }, statusCode: 301, to: "/log/$logId" });
  },
});
