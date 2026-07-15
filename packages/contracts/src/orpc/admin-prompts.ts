// The `admin-prompts` domain contract — the operator's read/write on the prompt
// registry (apps/web/src/lib/server/prompts.ts, docs/agents/prompt-registry.md), plus
// the ONE agent-tier read the on-box sweeps live on.
//
// THE ARCHITECTURE THIS CONTRACT IS SHAPED BY. The box runs a PINNED CLI release and a
// BAKED script image, so a new CLI verb does not exist on the box until a release and a
// pin bump — which is the exact deploy loop this feature is meant to abolish. So the box
// must reach a prompt through the API, over the token it already holds:
//
//   - `get_prompt`   AGENT tier. What a sweep calls each tick, over the `agent`-scoped
//                    token it already has (the `record_cost` / `record_health`
//                    precedent). LEAN by design — the resolved body and its version,
//                    nothing else — because it is on the hot path of every tick.
//   - `list_prompts` OPERATOR tier. The whole station in one request: every prompt, its
//                    baked default, the body running now, and its full edit history. An
//                    agent token 403s — editing what Fluncle says is publish-class.
//   - `update_prompt` OPERATOR tier. Appends a version. An EDIT, a ROLLBACK, and a RESET
//                    are all this one op; they differ only in where the body came from
//                    (the editor / an old version / the baked default). There is
//                    deliberately no `restore_prompt` verb: with an append-only history a
//                    rollback IS an update whose body came from history, and modelling it
//                    as its own destructive-sounding op would imply the history rewinds.
//                    It does not — it only ever grows, so a rollback is itself undoable.
//
// These are PRIVATE admin ops: the `/admin/*` path filter (orpc.ts) keeps them off the
// public OpenAPI doc.

import { oc } from "@orpc/contract";
import * as z from "zod";

/** The closed slug set — mirrors PROMPT_SLUGS. An unknown slug is a 422, so the
 * override table can never accumulate prompts for sweeps that do not exist. */
export const PromptSlugSchema = z.enum([
  "note_author",
  "observation_script",
  "logbook_entry",
  "triage_verdict",
  "newsletter_edition",
  "context_distil",
  "search_filter",
  "describe_artist",
  "describe_label",
]);

/** Where an edit actually lands: `box` = live on the next sweep tick (no rebake);
 * `worker` = live on the next request. */
export const PromptSurfaceSchema = z.enum(["box", "worker"]);

/** Whether the body running right now is an operator override or the repo's default. */
export const PromptSourceSchema = z.enum(["default", "override"]);

const PromptVersionSchema = z
  .object({
    body: z.string(),
    createdAt: z.string(),
    createdBy: z.enum(["agent", "operator"]),
    id: z.string(),
    /** The operator's WHY for this edit ("shortened the neighbour block"). */
    note: z.string().nullable(),
    version: z.number(),
  })
  .meta({ id: "PromptVersion" });

const PromptDetailSchema = z
  .object({
    /** The body running right now — the newest override, else `defaultBody`. */
    activeBody: z.string(),
    /** 0 when the baked default is live; else the live override's version. */
    activeVersion: z.number(),
    /** The repo's baked-in body. The floor every failure path falls back to. */
    defaultBody: z.string(),
    description: z.string(),
    slug: PromptSlugSchema,
    source: PromptSourceSchema,
    surface: PromptSurfaceSchema,
    title: z.string(),
    /** The `{{variables}}` the body may interpolate. */
    variables: z.array(z.string()),
    /** Newest first; empty when the prompt has never been overridden. */
    versions: z.array(PromptVersionSchema),
  })
  .meta({ id: "PromptDetail" });

/**
 * `list_prompts` → `GET /admin/prompts` (operationId `listPrompts`).
 *
 * OPERATOR tier. The whole station in one read: every registered prompt with its baked
 * default, its live body, and its complete history — enough to render the list, every
 * diff, and the rollback without a second round-trip.
 */
export const listPrompts = oc
  .route({
    method: "GET",
    operationId: "listPrompts",
    path: "/admin/prompts",
    summary: "List every registered prompt with its live body and full edit history",
    tags: ["Admin"],
  })
  .output(z.object({ ok: z.literal(true), prompts: z.array(PromptDetailSchema) }));

/**
 * `get_prompt` → `GET /admin/prompts/{slug}` (operationId `getPrompt`).
 *
 * AGENT tier (`adminAuth`, no `operatorGuard`) — this is the op the on-box sweeps call
 * each tick with their agent token, and it is why the prompts can live in the database
 * at all without a rebake. Lean on purpose: the resolved body and the version to stamp
 * on whatever it authors.
 *
 * It CANNOT 404 on a registered slug: an unknown slug is a 422, and a slug with no
 * override resolves to the repo's baked default at version 0.
 */
export const getPrompt = oc
  .route({
    method: "GET",
    operationId: "getPrompt",
    path: "/admin/prompts/{slug}",
    summary: "Resolve one prompt to the body that should run now (override, else default)",
    tags: ["Admin"],
  })
  .input(z.object({ slug: PromptSlugSchema }))
  .output(
    z.object({
      body: z.string(),
      ok: z.literal(true),
      slug: PromptSlugSchema,
      source: PromptSourceSchema,
      /** Stamp this onto the artifact you author: 0 = baked default, N = override N. */
      version: z.number(),
    }),
  );

/**
 * `update_prompt` → `POST /admin/prompts/{slug}` (operationId `updatePrompt`).
 *
 * OPERATOR tier — an agent token 403s. Appends a new version; never mutates, never
 * deletes. Returns the version it minted, which is the number the next artifact will
 * cite. Edit, rollback, and reset all ride this one op.
 */
export const updatePrompt = oc
  .route({
    method: "POST",
    operationId: "updatePrompt",
    path: "/admin/prompts/{slug}",
    summary: "Append a new version of a prompt (an edit, a rollback, or a reset)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      body: z.string().min(1, "a prompt body cannot be empty"),
      /** The operator's WHY — what makes the history readable a month later. */
      note: z.string().max(280).optional(),
      slug: PromptSlugSchema,
    }),
  )
  .output(z.object({ ok: z.literal(true), version: z.number() }));

/** The `admin-prompts` domain's ops, merged into the root contract by `./index.ts`. */
export const adminPromptsContract = {
  get_prompt: getPrompt,
  list_prompts: listPrompts,
  update_prompt: updatePrompt,
};
