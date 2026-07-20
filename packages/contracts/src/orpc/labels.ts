// The `labels` domain contract module — public label-entity reads. Follows the
// `artists.ts` pattern: a paginated list op and a by-slug get op, both public reads.
// `list_labels` serves the SAME unified `/labels` index the web page does — every label
// Fluncle holds that clears the thin-content floor; `get_label` resolves any label that
// has a page. Like every public label read, both are blind to `seed_state` (crawl scope,
// never storage).

import { oc } from "@orpc/contract";
import * as z from "zod";

/** A label's parent or sublabel edge — the name + slug the get op returns. */
export const LabelEdgeSchema = z
  .object({ name: z.string(), slug: z.string() })
  .meta({ id: "LabelEdge" });

/**
 * A public label list item — the minimal row the list and get ops emit. The public
 * identifier is `slug`. `logoImageUrl` is the label's own resolved logo when it has one;
 * `coverImageUrl` is a representative cover borrowed from one of its tracks. `findingCount`
 * counts published findings on the label; `certified` is `findingCount > 0`; `trackCount`
 * is its renderable tracks (findings plus the quieter catalogue rows).
 */
export const LabelListItemSchema = z
  .object({
    certified: z.boolean(),
    coverImageUrl: z.string().optional(),
    findingCount: z.number(),
    logoImageUrl: z.string().optional(),
    name: z.string(),
    slug: z.string(),
    trackCount: z.number(),
  })
  .meta({ id: "LabelListItem" });

/**
 * A single label's full read — the list row plus the label's own identity fields: its
 * bio, founding date/location, the off-catalogue MusicBrainz/Discogs anchors, and its
 * imprint lineage (parent label and sublabels), each present only when the label carries
 * it. No track list: the tracklist lives on the web `/label/<slug>` page.
 */
export const LabelDetailSchema = z
  .object({
    bio: z.string().optional(),
    certified: z.boolean(),
    coverImageUrl: z.string().optional(),
    discogsLabelId: z.number().optional(),
    findingCount: z.number(),
    foundedLocation: z.string().optional(),
    foundingDate: z.string().optional(),
    logoImageUrl: z.string().optional(),
    mbLabelId: z.string().optional(),
    name: z.string(),
    parentLabel: LabelEdgeSchema.optional(),
    slug: z.string(),
    subLabels: z.array(LabelEdgeSchema).optional(),
    trackCount: z.number(),
  })
  .meta({ id: "LabelDetail" });

/**
 * `list_labels` → `GET /labels` (operationId `listLabels`).
 *
 * The unified `/labels` index — every label Fluncle holds that clears the thin-content floor,
 * ordered alphabetically by name, one page at a time. This is the SAME index the `/labels` web
 * page serves. `page` is a 1-based tolerant string query param (default 1); the page size is
 * fixed. Contract-only oRPC (no route file under /api/v1/labels). The response is
 * `{ ok: true, labels, page, pageCount, total }`.
 */
export const listLabels = oc
  .route({
    method: "GET",
    operationId: "listLabels",
    path: "/labels",
    summary: "List every label Fluncle holds, A to Z, one page at a time",
    tags: ["Labels"],
  })
  .input(z.object({ page: z.string().optional() }))
  .output(
    z.object({
      labels: z.array(LabelListItemSchema),
      ok: z.literal(true),
      page: z.number(),
      pageCount: z.number(),
      total: z.number(),
    }),
  );

/**
 * `get_label` → `GET /labels/{slug}` (operationId `getLabel`).
 *
 * One label by its unique slug, wrapped in `{ ok: true, label }`. Resolves any label that has a
 * page — a below-floor label the list omits still renders on its `/label/<slug>` page — so get is
 * intentionally wider than the list index. A slug that matches no label is a 404.
 */
export const getLabel = oc
  .route({
    method: "GET",
    operationId: "getLabel",
    path: "/labels/{slug}",
    summary: "Get a label by slug",
    tags: ["Labels"],
  })
  .input(z.object({ slug: z.string() }))
  .output(z.object({ label: LabelDetailSchema, ok: z.literal(true) }));

/** The `labels` domain's ops, merged into the root contract by `./index.ts`. */
export const labelsContract = {
  get_label: getLabel,
  list_labels: listLabels,
};
