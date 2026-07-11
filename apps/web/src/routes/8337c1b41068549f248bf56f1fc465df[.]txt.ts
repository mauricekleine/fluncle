import { createFileRoute } from "@tanstack/react-router";
import { INDEXNOW_KEY } from "../lib/server/indexnow";

// The IndexNow ownership key file. IndexNow verifies a submission by fetching
// `https://www.fluncle.com/<key>.txt` and checking it returns exactly the key
// string. The key is PUBLIC (an ownership token, not a secret) — committed and
// served here so new-finding indexing is hands-off (see lib/server/indexnow.ts).
// The route path literal must match INDEXNOW_KEY (the filename encodes the key);
// the body is sourced from the single constant so the two can never drift.
export const Route = createFileRoute("/8337c1b41068549f248bf56f1fc465df.txt")({
  server: {
    handlers: {
      GET: () =>
        new Response(INDEXNOW_KEY, {
          headers: {
            // A public, effectively-permanent ownership token — let IndexNow's
            // verifier and the CDN cache it; SWR keeps every re-verify free.
            "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
            "Content-Type": "text/plain; charset=utf-8",
          },
        }),
    },
  },
});
