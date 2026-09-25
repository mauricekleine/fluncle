import { createFileRoute } from "@tanstack/react-router";
import { INDEXNOW_KEY } from "../lib/server/indexnow";

export const Route = createFileRoute("/8337c1b41068549f248bf56f1fc465df.txt")({
  server: {
    handlers: {
      GET: () =>
        new Response(INDEXNOW_KEY, {
          headers: {
            "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
            "Content-Type": "text/plain; charset=utf-8",
          },
        }),
    },
  },
});
