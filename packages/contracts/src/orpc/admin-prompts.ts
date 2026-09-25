import { oc } from "@orpc/contract";
import * as z from "zod";

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
  "describe_album",
]);

export const PromptSurfaceSchema = z.enum(["box", "worker"]);

export const PromptSourceSchema = z.enum(["default", "override"]);

const PromptVersionSchema = z
  .object({
    body: z.string(),
    createdAt: z.string(),
    createdBy: z.enum(["agent", "operator"]),
    id: z.string(),

    note: z.string().nullable(),
    version: z.number(),
  })
  .meta({ id: "PromptVersion" });

const PromptDetailSchema = z
  .object({
    activeBody: z.string(),

    activeVersion: z.number(),

    defaultBody: z.string(),
    description: z.string(),
    slug: PromptSlugSchema,
    source: PromptSourceSchema,
    surface: PromptSurfaceSchema,
    title: z.string(),

    variables: z.array(z.string()),

    versions: z.array(PromptVersionSchema),
  })
  .meta({ id: "PromptDetail" });

export const listPrompts = oc
  .route({
    method: "GET",
    operationId: "listPrompts",
    path: "/admin/prompts",
    summary: "List every registered prompt with its live body and full edit history",
    tags: ["Admin"],
  })
  .output(z.object({ ok: z.literal(true), prompts: z.array(PromptDetailSchema) }));

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

      version: z.number(),
    }),
  );

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

      note: z.string().max(280).optional(),
      slug: PromptSlugSchema,
    }),
  )
  .output(z.object({ ok: z.literal(true), version: z.number() }));

export const adminPromptsContract = {
  get_prompt: getPrompt,
  list_prompts: listPrompts,
  update_prompt: updatePrompt,
};
