// The `admin-prompts` domain router module — the prompt registry's HTTP surface
// (../prompts.ts, docs/agents/prompt-registry.md).
//
//   - `get_prompt`    — GET /admin/prompts/{slug} on `adminAuth` ONLY (no
//                       `operatorGuard`): AGENT tier, the `record_cost` precedent. This
//                       is the read the on-box sweeps make every tick with their
//                       agent-scoped token, and it is the whole reason a prompt can live
//                       in the database without a box rebake. It resolves rather than
//                       fetches: a slug with no override comes back as the repo's baked
//                       default at version 0, so it cannot 404 and cannot strand a sweep.
//   - `list_prompts`  — GET /admin/prompts, `adminAuth` + `operatorGuard` (OPERATOR):
//                       the whole station in one read. Editing what Fluncle SAYS is
//                       publish-class, so an agent token 403s on the way in.
//   - `update_prompt` — POST /admin/prompts/{slug}, OPERATOR: appends a version. An
//                       edit, a rollback, and a reset are all this one call.
//
// The contract's Zod enum has already rejected an unknown slug before a handler runs, so
// the handlers trust the slug is a registry key.

import { appendPromptVersion, listPrompts, resolvePrompt } from "../prompts";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { apiFault, type Implementer } from "./_shared";

/** Build the `admin-prompts` domain's handlers. */
export function adminPromptsHandlers(os: Implementer) {
  // GET /admin/prompts/{slug} — AGENT tier. The box's per-tick read.
  //
  // `resolvePrompt` is total: it cannot throw and it always yields a runnable body, so
  // there is no error path to map here. That is deliberate — the sweep on the other end
  // of this call must never be handed a 500 for a prompt it has a perfectly good baked
  // default for.
  const getPromptHandler = os.get_prompt.use(adminAuth).handler(async ({ input }) => {
    const resolved = await resolvePrompt(input.slug);

    return {
      body: resolved.body,
      ok: true as const,
      slug: resolved.slug,
      source: resolved.source,
      version: resolved.version,
    };
  });

  // GET /admin/prompts — OPERATOR tier. Every prompt, every version, one round-trip.
  const listPromptsHandler = os.list_prompts
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async () => {
      try {
        return { ok: true as const, prompts: await listPrompts() };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // POST /admin/prompts/{slug} — OPERATOR tier. Append-only; an agent token 403s.
  const updatePromptHandler = os.update_prompt
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const { version } = await appendPromptVersion({
          body: input.body,
          note: input.note,
          slug: input.slug,
        });

        return { ok: true as const, version };
      } catch (error) {
        throw apiFault(error);
      }
    });

  return {
    get_prompt: getPromptHandler,
    list_prompts: listPromptsHandler,
    update_prompt: updatePromptHandler,
  };
}
