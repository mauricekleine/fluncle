// The `graph` domain contract — the ONE public read behind Fluncle's graph links.
//
// Fluncle's archive is a graph (log ↔ artist ↔ label ↔ album ↔ galaxy) and the `GraphLink`
// component names its nodes wherever they are mentioned. Each link can reveal a hover card
// previewing the entity: its own opening line, a few finding covers, the count. This op is
// what that card reads.
//
// ── WHY A LAZY, PER-ENTITY OP AND NOT A PAGE-LOADER BATCH ─────────────────────────────
// The obvious alternative — bundle every mentioned entity's preview into the page loader — is
// the wrong trade. It pays for EVERY link on EVERY page load, whether or not a cursor ever
// goes near one: the homepage feed alone names a label on every row, so a batched loader would
// fetch dozens of previews to serve, typically, zero hovers. Worse, it grows with the feed.
//
// This op inverts that. The card fetches on OPEN — after the hover-intent delay, so a cursor
// passing over a link costs nothing — and the client caches by `(kind, slug)` in the shared
// react-query cache. Thirty feed rows naming the same imprint share one query key, so they
// make ONE request between them, ever; a re-hover makes none. Page load makes none. The
// N+1 the naive design invites cannot happen, because the unit of work is the entity, not
// the link.
//
// The LINK ITSELF needs no request at all — a finding already carries its `albumSlug` /
// `labelSlug` / `galaxy.slug` on `TrackListItem` (resolved in the same SELECT that loads the
// track), so every graph link renders with the page, server-side, in the first paint. Only
// the CARD is lazy.

import { oc } from "@orpc/contract";
import * as z from "zod";

/** The four non-log nodes of the graph — the entities a graph link can name. */
export const GraphEntityKindSchema = z
  .enum(["album", "artist", "galaxy", "label"])
  .meta({ id: "GraphEntityKind" });

/**
 * An entity preview — what a hover card renders. `line` is the entity page's OWN opening
 * line, built by the SAME function the page's masthead calls (`lib/graph-prose.ts`), so the
 * card can never drift into a second voice for the same object. `findingCount` and `covers`
 * count FINDINGS only — the uncertified catalogue rows on those pages are never introduced,
 * never named, and never counted aloud (DESIGN.md's Unlit Rule).
 */
export const GraphPreviewSchema = z
  .object({
    /**
     * The entity's factual, third-person bio (artist/label only), when one is authored — the
     * SAME paragraph the entity page prints beneath its dateline. Optional: MANY entities carry
     * no bio yet (the backfill is in flight), and album/galaxy previews never have one. The card
     * renders it below the signature line, clamped; absent, the card reads exactly as before.
     */
    bio: z.string().optional(),
    covers: z.array(z.string()),
    findingCount: z.number(),
    kind: GraphEntityKindSchema,
    /**
     * Optional, and the absence is meaningful: an entity Fluncle has never found anything on
     * has no opening line, because he has nothing to say about it. The page prints none there
     * either — a card that filled the gap would be inventing a sentence, and an entity page
     * that apologised for the half it does not have is what made a crawled label read as a
     * doorway page (docs/album-entity.md).
     */
    line: z.string().optional(),
    name: z.string(),
    slug: z.string(),
  })
  .meta({ id: "GraphPreview" });

/**
 * `get_graph_preview` → `GET /graph/{kind}/{slug}` (operationId `getGraphPreview`).
 *
 * One graph entity's hover-card preview. A slug that names no entity of that kind is a 404 —
 * including every galaxy slug while the browse-by-feel launch gate is closed, which is the
 * same answer `get_galaxy` gives.
 */
export const getGraphPreview = oc
  .route({
    method: "GET",
    operationId: "getGraphPreview",
    path: "/graph/{kind}/{slug}",
    summary: "Preview one graph entity (artist, label, album, or galaxy) by slug",
    tags: ["Graph"],
  })
  .input(z.object({ kind: GraphEntityKindSchema, slug: z.string() }))
  .output(z.object({ ok: z.literal(true), preview: GraphPreviewSchema }));

/** The `graph` domain's ops, merged into the root contract by `./index.ts`. */
export const graphContract = {
  get_graph_preview: getGraphPreview,
};
