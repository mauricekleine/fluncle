import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "./-alias";
import { requireParam } from "@/lib/server/http-errors";
import { renderMixtapeCover, resolveCoverSize } from "@/lib/server/mixtape-cover";

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
