// The `labels` domain router module — public label reads over the catalogue. Mirrors
// the `artists` pattern: a paginated list and a by-slug get, both public, no auth. The
// backing functions live in `../labels` (`listLabelsApiPage` / `getLabelDetail`).
//
// NOTE: the admin label ops (seed-state ruling, alias review, merge, bio) live in
// `./admin-labels.ts`; this is the PUBLIC read domain and shares no factory with it.

import { ORPCError } from "@orpc/server";
import { getLabelDetail, listLabelsApiPage } from "../labels";
import { apiFault, type Implementer, parseCataloguePage } from "./_shared";

/** Build the `labels` domain's PUBLIC read handlers — list + get, both no-auth. */
export function labelsHandlers(os: Implementer) {
  // `list_labels` — the unified `/labels` index over the API, one page at a time.
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

  // `get_label` — one label by slug, 404 when no label carries it.
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
