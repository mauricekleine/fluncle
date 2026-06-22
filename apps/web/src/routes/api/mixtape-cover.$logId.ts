import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "./-alias";
import { requireParam } from "@/lib/server/http-errors";
import { renderMixtapeCover, resolveCoverSize } from "@/lib/server/mixtape-cover";

// On-the-fly mixtape cover, rendered on the edge with workers-og (Satori + resvg
// WASM — the same path as the per-finding OG card in og.$logId.ts). The cover is
// the shared Deep-Field background (the cosmonaut) with the only per-mixtape marks —
// "MIXTAPE #N" and the Log ID coordinate — stamped over it. The render itself lives
// in lib/server/mixtape-cover.ts so the YouTube finalize can render it IN-PROCESS
// for the custom thumbnail (a Worker can't HTTP-fetch its own cover route — that
// loops to the SPA fallback).
//
// `?size=` picks the aspect: square (Mixcloud/SoundCloud + the /log coverImageUrl),
// og (the /log link-preview), or wide (the YouTube thumbnail). The mixtape's
// coverImageUrl points here, versioned by `?v=<updatedAt>` so an edit re-renders
// while each version stays immutable + edge-cached.

export const serverHandlers: ApiHandlers = {
  GET: async ({ request, params }) => {
    const logId = decodeURIComponent(requireParam(params.logId, "logId"));
    const size = resolveCoverSize(new URL(request.url).searchParams.get("size"));
    const image = await renderMixtapeCover(logId, size);

    return image ?? new Response("Not found", { status: 404 });
  },
};

export const Route = createFileRoute("/api/mixtape-cover/$logId")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
