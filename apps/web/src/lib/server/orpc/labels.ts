import { ORPCError } from "@orpc/server";
import { getLabelDetail, listLabelsApiPage } from "../labels";
import { apiFault, type Implementer, parseCataloguePage } from "./_shared";

export function labelsHandlers(os: Implementer) {
  const listLabelsHandler = os.list_labels.handler(async ({ input }) => {
    try {
      const { items, page, pageCount, total } = await listLabelsApiPage(
        parseCataloguePage(input.page),
      );

      return { labels: items, ok: true, page, pageCount, total } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  const getLabelHandler = os.get_label.handler(async ({ input }) => {
    try {
      const label = await getLabelDetail(input.slug);

      if (!label) {
        throw new ORPCError("NOT_FOUND", {
          message: `No label with slug "${input.slug}"`,
        });
      }

      return { label, ok: true } as const;
    } catch (error) {
      if (error instanceof ORPCError) {
        throw error;
      }

      throw apiFault(error);
    }
  });

  return { get_label: getLabelHandler, list_labels: listLabelsHandler };
}
