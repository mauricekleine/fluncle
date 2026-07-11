// The `graph` domain router — the one public read behind Fluncle's graph links (the
// `GraphLink` hover card). A slug that names no entity of that kind is a 404, which is also
// the answer for every galaxy slug while the browse-by-feel launch gate is closed.

import { ORPCError } from "@orpc/server";
import { GraphEntityNotFoundError, getGraphPreview } from "../graph-preview";
import { apiFault, type Implementer } from "./_shared";

/** Build the `graph` domain's handlers — one public read. */
export function graphHandlers(os: Implementer) {
  const getGraphPreviewHandler = os.get_graph_preview.handler(async ({ input }) => {
    try {
      return { ok: true, preview: await getGraphPreview(input.kind, input.slug) } as const;
    } catch (error) {
      if (error instanceof GraphEntityNotFoundError) {
        throw new ORPCError("NOT_FOUND", { message: error.message });
      }

      throw apiFault(error);
    }
  });

  return { get_graph_preview: getGraphPreviewHandler };
}
