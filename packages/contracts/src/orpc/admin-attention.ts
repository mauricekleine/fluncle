// The `admin-attention` domain contract module — the read behind the `/admin`
// attention queue, exposed off the Worker so the operator's own tools (the
// `fluncle admin queue` CLI verb, its Raycast menu-bar sibling) can read the same
// snapshot the web dashboard renders, without a browser.
//
//   - `get_attention` — ADMIN tier (`adminAuth`, NOT `operatorGuard`): a pure READ
//     that composes the existing admin-tier reads the snapshot already draws from
//     (`list_tracks_admin`, `list_recordings`, `list_mixtapes_admin`,
//     `list_clip_posts`, the artist-review queue). It publishes nothing and is fully
//     reversible, so it rides the same tier as every other admin read
//     (`list_recordings`/`get_track_admin`) — the persona law's "automation verb on
//     the admin-tier API" for the box + the operator's CLI.
//
// The payload is a menu-bar-shaped digest of the server snapshot: the total waiting
// count, the per-source counts, a flat ordered `rows` list (each row's `source`,
// `title`, and the `/admin/…` deep-link `path`), the render-queue depth pulse, and
// the deterministic Fluncle-voiced `brief` (the morning dispatch, assembled from the
// counts server-side — no LLM). Snooze/won't-do state is client localStorage, so
// these counts are the RAW due/backlog truth by design.

import { oc } from "@orpc/contract";
import * as z from "zod";

/**
 * The queue's thirteen sources (mirrors `AttentionSource` in apps/web/src/lib/attention.ts).
 * EXHAUSTIVE and alphabetically sorted: this enum, the `AttentionSource` union, and every
 * exhaustive map over it (the dashboard's icons + labels, the CLI's labels, the Raycast
 * menu bar's meta, the priority order, the brief's phrases) must move together.
 */
export const AttentionSourceSchema = z
  .enum([
    "artist-review",
    "attach-cues",
    "capture-suspect",
    "distribute",
    "drip-empty",
    "label-review",
    "newsletter",
    "note-rejected",
    "observation-rejected",
    "post-tiktok",
    "post-youtube",
    "submission",
    "tiktok-draft",
  ])
  .meta({ id: "AttentionSource" });

/** One waiting row — the source, the object line, and where acting on it lives. */
export const AttentionRowSchema = z
  .object({
    // Present ⇒ a deadline row (a TikTok inbox draft racing its 24h bounce).
    deadlineAt: z.string().optional(),
    logId: z.string().optional(),
    // The `/admin/…` path a click opens (the row's `href`, or the dashboard `/admin`
    // for the inline publish-loop rows whose action lives on the queue itself).
    path: z.string(),
    source: AttentionSourceSchema,
    title: z.string(),
    // How many dressed findings wait behind this one (the publish-loop datum).
    waiting: z.number().optional(),
  })
  .meta({ id: "AttentionRow" });

/** One source's waiting count (present only when non-zero), in priority order. */
export const AttentionSourceCountSchema = z
  .object({
    count: z.number(),
    source: AttentionSourceSchema,
  })
  .meta({ id: "AttentionSourceCount" });

/** The menu-bar digest of the attention snapshot. */
export const AttentionQueueSchema = z
  .object({
    // The deterministic, Fluncle-voiced morning dispatch (assembled from the counts).
    brief: z.string(),
    counts: z.array(AttentionSourceCountSchema),
    // Enriched findings still waiting on the box's video render — the pulse datum.
    renderQueueDepth: z.number(),
    rows: z.array(AttentionRowSchema),
    // Total waiting rows (the raw due + backlog truth; no client snooze state).
    total: z.number(),
  })
  .meta({ id: "AttentionQueue" });

/**
 * `get_attention` → `GET /admin/attention` (operationId `getAttention`).
 *
 * ADMIN tier (`adminAuth`, no `operatorGuard`) — a pure read that composes the
 * admin-tier reads the snapshot already draws from, publishing nothing. Returns
 * `{ ok, attention }`.
 */
export const getAttention = oc
  .route({
    method: "GET",
    operationId: "getAttention",
    path: "/admin/attention",
    summary: "Read the /admin attention queue digest (counts, rows, and the day's dispatch)",
    tags: ["Admin"],
  })
  .input(z.object({}))
  .output(z.object({ attention: AttentionQueueSchema, ok: z.literal(true) }));

/** The `admin-attention` domain's ops, merged into the root contract by `./index.ts`. */
export const adminAttentionContract = {
  get_attention: getAttention,
};
