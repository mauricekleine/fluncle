// prompt-fetch.ts — the box's shared, best-effort prompt reader. The DRY seam every
// on-box authoring sweep imports to pull its prompt from the registry
// (apps/web/src/lib/server/prompts.ts, docs/agents/prompt-registry.md) instead of
// carrying it as a string in the image.
//
// WHY IT IS AN HTTP FETCH AND NOT A CLI CALL. The box runs a PINNED CLI release and a
// BAKED script image. A new `fluncle` verb does not exist on the box until a release AND
// a pin bump — which is the exact deploy loop this whole feature exists to abolish. So a
// sweep reaches its prompt the only way it can reach anything new: over the API, with the
// `agent`-scoped token it already holds. That is `cost-emit.ts`'s pattern exactly (the
// box POSTs cost rows the same way), and it is why the endpoint is AGENT tier.
//
// Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Baked into /opt/hermes-scripts/ alongside the sweeps
// by the Dockerfile's `COPY docs/agents/hermes/scripts/`, so a sibling `./prompt-fetch`
// import resolves on the box; `*.test.ts` is stripped from the image.
//
// THE CONTRACT (mirrored, deliberately, from the workspace the box CANNOT import —
// exactly as cost-emit.ts mirrors the cost contract):
//   the agent-tier endpoint `GET ${FLUNCLE_API_BASE_URL}/api/admin/prompts/<slug>`
//   (packages/contracts/src/orpc/admin-prompts.ts), Bearer ${FLUNCLE_API_TOKEN},
//   returning `{ ok, slug, body, version, source }`.
//
// ── THE CARDINAL GUARANTEE ──────────────────────────────────────────────────────────
// A SWEEP MUST NEVER BREAK BECAUSE A PROMPT COULD NOT BE FETCHED. `fetchPrompt` cannot
// throw, cannot reject, and cannot block past a hard timeout. Every failure path — no
// token, a non-2xx, a network error, a timeout, a malformed body, an empty body — returns
// `null`, and a `null` means ONE thing to every caller: fall back to the builder baked
// into the sweep itself and author exactly as it did before this feature existed.
//
// So there are three tiers, and the sweep reports which one it ran under:
//
//   version │ where the prompt came from
//   ────────┼──────────────────────────────────────────────────────────────────────────
//     N ≥ 1 │ the operator's live override, version N
//     0     │ the registry's baked default (no override on file) — served by the API
//     null  │ THE API WAS UNREACHABLE. The sweep used its own inlined builder.
//
// That number is stamped onto the artifact (`--prompt-version`), so a note authored
// during an outage is legible as such forever, rather than silently attributed to a
// version that did not write it.
//
// The inlined builder in each sweep is therefore not dead code and not duplication for
// its own sake: it is the floor. It is what makes "the prompt store is down" a boring
// event instead of a stopped pipeline, and it is the thing the fallback test pins.

/** The lean resolve the agent-tier endpoint returns. */
export type FetchedPrompt = {
  body: string;
  /** "override" = an operator edit is live. "default" = the repo's baked body is live. */
  source: "default" | "override";
  /** 0 = the registry default, N = operator override N. Stamp it on the artifact. */
  version: number;
};

export type FetchPromptOptions = {
  /** Override the Worker base (default: FLUNCLE_API_BASE_URL env, then prod). */
  baseUrl?: string;
  /** Injected fetch for tests; defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Hard budget. Default 2500ms — well inside the cron's 120s kill. */
  timeoutMs?: number;
  /** Override the agent token (default: FLUNCLE_API_TOKEN env). */
  token?: string;
};

const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_BASE_URL = "https://www.fluncle.com";

const log = (message: string) => console.error(`[prompt-fetch] ${message}`);

/**
 * Fetch one prompt from the registry. Returns `null` on ANY failure — the caller falls
 * back to its baked-in builder. Never throws.
 */
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
    const response = await doFetch(`${baseUrl}/api/admin/prompts/${slug}`, {
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

    // An empty body is a corrupt answer, not an instruction to send the model nothing.
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

// ---------------------------------------------------------------------------
// The template renderer — a VERBATIM mirror of `renderPrompt`
// (apps/web/src/lib/server/prompts.ts), which the box cannot import. Two constructs and
// nothing else, because a prompt template is edited by a human at 1am and every feature
// is a way to break a sweep:
//
//   {{name}}              → the variable's value, or "" when it is absent/empty.
//   {{#if name}}…{{/if}}  → the block, only when `name` is a non-empty string.
//
// TOTAL: every input renders to a string. An unknown variable renders empty; nothing here
// throws. An operator's typo in the /admin editor must never be able to stop a sweep.
// The shared unit test pins this against the Worker's copy so the two cannot drift.
// ---------------------------------------------------------------------------

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

/**
 * The shape every authoring sweep resolves to: the prompt text to send, and the version
 * to stamp on whatever it produces (`null` ⇒ the baked-in fallback wrote it).
 *
 * `fallback` is a THUNK, not a string, so the sweep's own builder only runs when it is
 * actually needed — and so the fallback path stays the sweep's existing, tested code
 * rather than a second rendering of a template it could not fetch.
 */
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
