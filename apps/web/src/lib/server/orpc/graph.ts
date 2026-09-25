import { ORPCError } from "@orpc/server";
import { GraphEntityNotFoundError, getGraphPreview } from "../graph-preview";
import { apiFault, type Implementer } from "./_shared";

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
