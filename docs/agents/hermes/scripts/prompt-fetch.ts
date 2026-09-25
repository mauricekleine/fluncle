export type FetchedPrompt = {
  body: string;

  source: "default" | "override";

  version: number;
};

export type FetchPromptOptions = {
  baseUrl?: string;

  fetchImpl?: typeof fetch;

  timeoutMs?: number;

  token?: string;
};

const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_BASE_URL = "https://www.fluncle.com";

const log = (message: string) => console.error(`[prompt-fetch] ${message}`);

export async function fetchPrompt(
  slug: string,
  options: FetchPromptOptions = {},
): Promise<FetchedPrompt | null> {
  const baseUrl = (options.baseUrl ?? process.env.FLUNCLE_API_BASE_URL ?? DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const token = options.token ?? process.env.FLUNCLE_API_TOKEN ?? "";

  if (!token) {
    log(`no FLUNCLE_API_TOKEN — authoring "${slug}" from the baked-in default`);

    return null;
  }

  const doFetch = options.fetchImpl ?? fetch;

  try {
    const response = await doFetch(`${baseUrl}/api/v1/admin/prompts/${slug}`, {
      headers: { Authorization: `Bearer ${token}` },
      method: "GET",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      log(`get_prompt "${slug}" returned HTTP ${response.status} — using the baked default`);

      return null;
    }

    const payload = (await response.json()) as {
      body?: unknown;
      source?: unknown;
      version?: unknown;
    };
    const body = typeof payload.body === "string" ? payload.body.trim() : "";

    if (!body) {
      log(`get_prompt "${slug}" returned an empty body — using the baked default`);

      return null;
    }

    return {
      body,
      source: payload.source === "override" ? "override" : "default",
      version: typeof payload.version === "number" ? payload.version : 0,
    };
  } catch (error) {
    log(
      `get_prompt "${slug}" failed (${
        error instanceof Error ? error.message : String(error)
      }) — using the baked default`,
    );

    return null;
  }
}

export type PromptVariables = Record<string, string | undefined>;

const IF_BLOCK = /\{\{#if\s+([a-zA-Z0-9_]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g;
const VARIABLE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function renderPrompt(body: string, variables: PromptVariables = {}): string {
  const has = (name: string) => {
    const value = variables[name];

    return typeof value === "string" && value.trim().length > 0;
  };

  const withBlocks = body.replace(IF_BLOCK, (_match, name: string, block: string) =>
    has(name) ? block : "",
  );

  const substituted = withBlocks.replace(VARIABLE, (_match, name: string) => variables[name] ?? "");

  return substituted.replace(/\n{3,}/g, "\n\n").trim();
}

export async function resolveSweepPrompt(input: {
  fallback: () => string;
  slug: string;
  variables: PromptVariables;
}): Promise<{ prompt: string; promptVersion: number | null }> {
  const fetched = await fetchPrompt(input.slug);

  if (!fetched) {
    return { prompt: input.fallback(), promptVersion: null };
  }

  return {
    prompt: renderPrompt(fetched.body, input.variables),
    promptVersion: fetched.version,
  };
}
