import { describe, expect, test } from "bun:test";

import { fetchPrompt, renderPrompt, resolveSweepPrompt } from "./prompt-fetch";

type RecordedCall = { auth: string; method: string; url: string };

function stubFetch(response: { json?: () => Promise<unknown>; ok: boolean; status?: number }): {
  calls: RecordedCall[];
  fetchImpl: typeof fetch;
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      auth: headers.Authorization ?? "",
      method: init.method ?? "",
      url,
    });

    return Promise.resolve({
      json: response.json ?? (() => Promise.resolve({})),
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
    } as Response);
  }) as unknown as typeof fetch;

  return { calls, fetchImpl };
}

describe("renderPrompt", () => {
  test("substitutes {{var}} (tolerating inner whitespace)", () => {
    expect(
      renderPrompt("artists: {{artists}} / title: {{ title }}", {
        artists: "Whiney",
        title: "Nightfall",
      }),
    ).toBe("artists: Whiney / title: Nightfall");
  });

  test("keeps an {{#if}} block when the variable is present", () => {
    const body = "head\n{{#if contextNote}}\nCONTEXT: {{contextNote}}\n{{/if}}\ntail";

    expect(renderPrompt(body, { contextNote: "a 2016 single" })).toBe(
      "head\n\nCONTEXT: a 2016 single\n\ntail",
    );
  });

  test("drops an {{#if}} block when the variable is absent, empty, or whitespace", () => {
    const body = "head\n{{#if contextNote}}\nCONTEXT: {{contextNote}}\n{{/if}}\ntail";

    for (const variables of [{}, { contextNote: "" }, { contextNote: "   " }]) {
      const rendered = renderPrompt(body, variables);

      expect(rendered).not.toContain("CONTEXT");
      expect(rendered).toBe("head\n\ntail");
    }
  });

  test("expresses a two-armed branch as two flags (the no-`else` contract)", () => {
    const body = "{{#if contextNote}}NOTE: {{contextNote}}{{/if}}{{#if noContextNote}}NONE{{/if}}";

    expect(renderPrompt(body, { contextNote: "facts", noContextNote: "" })).toBe("NOTE: facts");
    expect(renderPrompt(body, { contextNote: "", noContextNote: "yes" })).toBe("NONE");
  });

  test("renders an unknown variable empty and never throws", () => {
    expect(() => renderPrompt("a {{nope}} b")).not.toThrow();
    expect(renderPrompt("a {{nope}} b")).toBe("a  b");
    expect(renderPrompt("{{#if nope}}gone{{/if}}kept")).toBe("kept");
  });

  test("collapses the newline run a dropped block leaves behind", () => {
    expect(renderPrompt("a\n\n{{#if x}}\nb\n{{/if}}\n\nc")).toBe("a\n\nc");
  });
});

describe("fetchPrompt best-effort contract", () => {
  test("happy path returns the body/version/source and GETs with the bearer", async () => {
    const { calls, fetchImpl } = stubFetch({
      json: () => Promise.resolve({ body: "  hello  ", ok: true, source: "override", version: 7 }),
      ok: true,
    });

    const result = await fetchPrompt("note_author", {
      baseUrl: "https://example.test/",
      fetchImpl,
      token: "agent-tok",
    });

    expect(result).toEqual({ body: "hello", source: "override", version: 7 });
    expect(calls.length).toBe(1);

    const call = calls[0];
    if (!call) {
      throw new Error("expected exactly one recorded fetch call");
    }
    expect(call.url).toBe("https://example.test/api/v1/admin/prompts/note_author");
    expect(call.method).toBe("GET");
    expect(call.auth).toBe("Bearer agent-tok");
  });

  test("a version-less/source-less payload defaults to the registry default (v0)", async () => {
    const { fetchImpl } = stubFetch({
      json: () => Promise.resolve({ body: "hello" }),
      ok: true,
    });

    expect(await fetchPrompt("note_author", { fetchImpl, token: "t" })).toEqual({
      body: "hello",
      source: "default",
      version: 0,
    });
  });

  test("no token → null, and no fetch is attempted", async () => {
    const { calls, fetchImpl } = stubFetch({ ok: true });

    expect(await fetchPrompt("note_author", { fetchImpl, token: "" })).toBeNull();
    expect(calls.length).toBe(0);
  });

  test("a non-2xx → null, never thrown", async () => {
    const { fetchImpl } = stubFetch({ ok: false, status: 500 });

    expect(await fetchPrompt("note_author", { fetchImpl, token: "t" })).toBeNull();
  });

  test("a network throw → null, never thrown", async () => {
    const fetchImpl = (() => Promise.reject(new Error("boom"))) as unknown as typeof fetch;

    expect(await fetchPrompt("note_author", { fetchImpl, token: "t" })).toBeNull();
  });

  test("a timeout → null, never thrown (the hard budget fires)", async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("The operation timed out.")));
      })) as unknown as typeof fetch;

    expect(await fetchPrompt("note_author", { fetchImpl, timeoutMs: 5, token: "t" })).toBeNull();
  });

  test("an empty body → null (a corrupt answer is not an instruction to send nothing)", async () => {
    for (const body of ["", "   ", 42, null, undefined]) {
      const { fetchImpl } = stubFetch({
        json: () => Promise.resolve({ body, version: 3 }),
        ok: true,
      });

      expect(await fetchPrompt("note_author", { fetchImpl, token: "t" })).toBeNull();
    }
  });

  test("malformed JSON → null, never thrown", async () => {
    const { fetchImpl } = stubFetch({
      json: () => Promise.reject(new SyntaxError("Unexpected token < in JSON")),
      ok: true,
    });

    expect(await fetchPrompt("note_author", { fetchImpl, token: "t" })).toBeNull();
  });
});

describe("resolveSweepPrompt", () => {
  async function withEnv<T>(
    input: { fetchImpl?: typeof fetch; token: string },
    body: () => Promise<T>,
  ): Promise<T> {
    const priorToken = process.env.FLUNCLE_API_TOKEN;
    const priorBase = process.env.FLUNCLE_API_BASE_URL;
    const priorFetch = globalThis.fetch;

    process.env.FLUNCLE_API_TOKEN = input.token;
    process.env.FLUNCLE_API_BASE_URL = "https://example.test";

    if (input.fetchImpl) {
      globalThis.fetch = input.fetchImpl;
    }

    try {
      return await body();
    } finally {
      globalThis.fetch = priorFetch;

      if (priorToken === undefined) {
        delete process.env.FLUNCLE_API_TOKEN;
      } else {
        process.env.FLUNCLE_API_TOKEN = priorToken;
      }

      if (priorBase === undefined) {
        delete process.env.FLUNCLE_API_BASE_URL;
      } else {
        process.env.FLUNCLE_API_BASE_URL = priorBase;
      }
    }
  }

  test("renders the fetched template and stamps its version; the fallback never runs", async () => {
    const { fetchImpl } = stubFetch({
      json: () =>
        Promise.resolve({
          body: "hi {{artists}}{{#if gone}}NO{{/if}}",
          source: "override",
          version: 4,
        }),
      ok: true,
    });

    let fallbacks = 0;

    const resolved = await withEnv({ fetchImpl, token: "t" }, () =>
      resolveSweepPrompt({
        fallback: () => {
          fallbacks += 1;

          return "the baked-in prompt";
        },
        slug: "note_author",
        variables: { artists: "Whiney" },
      }),
    );

    expect(resolved).toEqual({ prompt: "hi Whiney", promptVersion: 4 });
    expect(fallbacks).toBe(0);
  });

  test("falls back exactly once, with promptVersion null, when the fetch returns null", async () => {
    let fallbacks = 0;

    const resolved = await withEnv({ token: "" }, () =>
      resolveSweepPrompt({
        fallback: () => {
          fallbacks += 1;

          return "the baked-in prompt";
        },
        slug: "note_author",
        variables: { artists: "Whiney" },
      }),
    );

    expect(resolved).toEqual({ prompt: "the baked-in prompt", promptVersion: null });
    expect(fallbacks).toBe(1);
  });

  test("a network throw also lands on the fallback, never on an exception", async () => {
    const fetchImpl = (() => Promise.reject(new Error("boom"))) as unknown as typeof fetch;

    const resolved = await withEnv({ fetchImpl, token: "t" }, () =>
      resolveSweepPrompt({
        fallback: () => "the baked-in prompt",
        slug: "observation_script",
        variables: {},
      }),
    );

    expect(resolved).toEqual({ prompt: "the baked-in prompt", promptVersion: null });
  });

  test("the registry's baked default reports version 0, not null", async () => {
    const { fetchImpl } = stubFetch({
      json: () => Promise.resolve({ body: "the registry default", source: "default", version: 0 }),
      ok: true,
    });

    const resolved = await withEnv({ fetchImpl, token: "t" }, () =>
      resolveSweepPrompt({
        fallback: () => "the baked-in prompt",
        slug: "triage_verdict",
        variables: {},
      }),
    );

    expect(resolved).toEqual({ prompt: "the registry default", promptVersion: 0 });
  });
});
