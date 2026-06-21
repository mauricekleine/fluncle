// The `stories` domain contract module. Owns the public Stories-feed op; a
// future wave adds an op here and one import line in `./index.ts`, touching no
// other domain's file.

import { oc } from "@orpc/contract";
import * as z from "zod";
import { TrackListItemSchema } from "./_shared";

/**
 * `list_stories` → `GET /stories` (operationId `listStories`).
 *
 * The Stories feed: findings that have a rendered video, newest first — a thin
 * veneer over `/tracks` with the `hasVideo` filter baked in. Like `/tracks` (and
 * unlike `/mixtapes`), the page IS the body — NO `ok` envelope (mirrors
 * `TrackListPage` in ../index.ts). The result is findings-only (mixtapes are
 * never interleaved here), so `tracks` is `TrackListItem[]`, not the merged
 * `FeedItem[]`.
 *
 * The query params mirror the live route exactly:
 *   - `limit`  — page size (default 16, clamped to 48). Kept a raw string and
 *                parsed in-handler so an invalid value degrades to the default
 *                exactly as the live route does (rather than 400-ing).
 *   - `cursor` — the opaque base64url keyset cursor from a prior page's
 *                `nextCursor`.
 */
export const listStories = oc
  .route({
    method: "GET",
    operationId: "listStories",
    path: "/stories",
    summary: "List the Stories feed (findings with a rendered video)",
    tags: ["Stories"],
  })
  .input(
    z.object({
      cursor: z.string().optional(),
      limit: z.string().optional(),
    }),
  )
  .output(
    z.object({
      nextCursor: z.string().optional(),
      totalCount: z.number(),
      tracks: z.array(TrackListItemSchema),
    }),
  );

/** The `stories` domain's ops, merged into the root contract by `./index.ts`. */
export const storiesContract = {
  list_stories: listStories,
};
