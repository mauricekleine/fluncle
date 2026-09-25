import { appendPromptVersion, listPrompts, resolvePrompt } from "../prompts";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { apiFault, type Implementer } from "./_shared";

export function adminPromptsHandlers(os: Implementer) {
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
