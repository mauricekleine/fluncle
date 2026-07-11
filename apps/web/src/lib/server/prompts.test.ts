import { beforeEach, describe, expect, it, vi } from "vitest";

// The prompt registry (./prompts.ts). Three things are pinned here, and the first one is
// the whole reason the feature is safe to ship:
//
//   1. THE FALLBACK. A missing row, a corrupt row, or a database that is simply DOWN
//      must never stop a sweep — it falls back to the repo's baked-in default and logs.
//      A pipeline that dies because a settings table hiccuped is worse than no feature.
//   2. THE RENDERER is TOTAL. An operator's typo in the /admin editor cannot throw.
//   3. THE REGISTRY IS COHERENT: every `{{variable}}` a default body actually uses is
//      declared in that prompt's `variables` list, so the /admin editor cannot show the
//      operator a prompt whose real inputs it failed to mention.

const execute = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

const {
  appendPromptVersion,
  isPromptSlug,
  listPrompts,
  PROMPT_REGISTRY,
  PROMPT_SLUGS,
  renderPrompt,
  renderRegisteredPrompt,
  resolvePrompt,
} = await import("./prompts");

beforeEach(() => {
  execute.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

// ---------------------------------------------------------------------------
// THE FALLBACK — the cardinal guarantee. Each of these is a way the prompt store can
// fail, and every one of them must land on the baked default rather than an exception.
// ---------------------------------------------------------------------------

describe("resolvePrompt — a broken prompt store can never break a sweep", () => {
  it("falls back to the baked default when the prompt has NO row (the cold state)", async () => {
    execute.mockResolvedValueOnce({ rows: [] });

    const resolved = await resolvePrompt("note_author");

    expect(resolved.body).toBe(PROMPT_REGISTRY.note_author.defaultBody);
    expect(resolved.source).toBe("default");
    // Version 0 is the registry default. It is a real, citable provenance value — an
    // artifact authored under it is NOT "unknown", it is "the repo's own wording".
    expect(resolved.version).toBe(0);
  });

  it("falls back to the baked default when the DATABASE THROWS (the store is down)", async () => {
    execute.mockRejectedValueOnce(new Error("database is locked"));

    const resolved = await resolvePrompt("note_author");

    expect(resolved.body).toBe(PROMPT_REGISTRY.note_author.defaultBody);
    expect(resolved.source).toBe("default");
    expect(resolved.version).toBe(0);
  });

  it("falls back to the baked default when the stored override is EMPTY (corrupt row)", async () => {
    // An operator cannot have meant "send the model an empty prompt". A blank body is a
    // corrupt override, so we author from the default rather than from nothing.
    execute.mockResolvedValueOnce({ rows: [{ body: "   \n  ", version: 4 }] });

    const resolved = await resolvePrompt("note_author");

    expect(resolved.body).toBe(PROMPT_REGISTRY.note_author.defaultBody);
    expect(resolved.source).toBe("default");
    expect(resolved.version).toBe(0);
  });

  it("NEVER throws, for any registered slug, when the store is down", async () => {
    for (const slug of PROMPT_SLUGS) {
      execute.mockRejectedValueOnce(new Error("connection reset"));

      const resolved = await resolvePrompt(slug);

      expect(resolved.body).toBe(PROMPT_REGISTRY[slug].defaultBody);
      expect(resolved.body.length).toBeGreaterThan(0);
    }
  });

  it("serves the operator's newest override when one is on file", async () => {
    execute.mockResolvedValueOnce({ rows: [{ body: "the operator's tuned prompt", version: 7 }] });

    const resolved = await resolvePrompt("note_author");

    expect(resolved.body).toBe("the operator's tuned prompt");
    expect(resolved.source).toBe("override");
    expect(resolved.version).toBe(7);
  });

  it("reads the newest version (order by version desc limit 1)", async () => {
    execute.mockResolvedValueOnce({ rows: [{ body: "v9", version: 9 }] });

    await resolvePrompt("logbook_entry");

    const sql = execute.mock.calls[0]?.[0]?.sql ?? "";
    expect(sql).toContain("order by version desc");
    expect(sql).toContain("limit 1");
    expect(execute.mock.calls[0]?.[0]?.args).toEqual(["logbook_entry"]);
  });
});

describe("renderRegisteredPrompt — the Worker's resolve-and-render", () => {
  it("renders the override with the caller's variables and reports its version", async () => {
    execute.mockResolvedValueOnce({
      rows: [{ body: "note {{artists}} — {{title}}", version: 3 }],
    });

    const rendered = await renderRegisteredPrompt("note_author", {
      artists: "Netsky",
      title: "Iron Heart",
    });

    expect(rendered.body).toBe("note Netsky — Iron Heart");
    expect(rendered.version).toBe(3);
  });

  it("still returns a runnable prompt when the store is down", async () => {
    execute.mockRejectedValueOnce(new Error("down"));

    const rendered = await renderRegisteredPrompt("note_author", { artists: "Netsky" });

    expect(rendered.body.length).toBeGreaterThan(0);
    expect(rendered.version).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// THE RENDERER — two constructs, and it is TOTAL. Every input renders to a string.
// ---------------------------------------------------------------------------

describe("renderPrompt", () => {
  it("substitutes a variable", () => {
    expect(renderPrompt("hello {{name}}", { name: "Fluncle" })).toBe("hello Fluncle");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(renderPrompt("hello {{  name  }}", { name: "Fluncle" })).toBe("hello Fluncle");
  });

  it("substitutes every occurrence of the same variable", () => {
    expect(renderPrompt("{{a}} and {{a}}", { a: "x" })).toBe("x and x");
  });

  it("renders an UNKNOWN variable as empty rather than throwing", () => {
    // The operator typo'd a variable name in the /admin editor. That must degrade to a
    // slightly thinner prompt, never to a stopped sweep.
    expect(renderPrompt("a{{nope}}b", {})).toBe("ab");
  });

  it("keeps an {{#if}} block when the variable is present", () => {
    expect(renderPrompt("x{{#if v}}[{{v}}]{{/if}}y", { v: "hit" })).toBe("x[hit]y");
  });

  it("drops an {{#if}} block when the variable is absent, empty, or whitespace", () => {
    expect(renderPrompt("x{{#if v}}[{{v}}]{{/if}}y", {})).toBe("xy");
    expect(renderPrompt("x{{#if v}}[{{v}}]{{/if}}y", { v: "" })).toBe("xy");
    expect(renderPrompt("x{{#if v}}[{{v}}]{{/if}}y", { v: "   " })).toBe("xy");
  });

  it("never substitutes a variable inside a DROPPED block", () => {
    // The conditional runs first, on purpose: a variable in a dead branch must not leak.
    expect(renderPrompt("{{#if gate}}secret {{leak}}{{/if}}", { leak: "LEAKED" })).toBe("");
  });

  it("handles a multi-line block", () => {
    const body = "head\n{{#if v}}\nblock {{v}}\n{{/if}}\ntail";
    expect(renderPrompt(body, { v: "on" })).toBe("head\n\nblock on\n\ntail");
    expect(renderPrompt(body, {})).toBe("head\n\ntail");
  });

  it("collapses the newline hole a dropped block leaves behind", () => {
    expect(renderPrompt("a\n\n{{#if v}}b\n\n{{/if}}\n\nc", {})).toBe("a\n\nc");
  });

  it("leaves an UNCLOSED {{#if}} as literal text rather than swallowing the prompt", () => {
    // A half-typed conditional must not silently eat every rail below it.
    const out = renderPrompt("keep me {{#if v}} and me", { v: "x" });
    expect(out).toContain("keep me");
    expect(out).toContain("and me");
  });

  it("is total: it does not throw on any of these", () => {
    for (const body of ["", "{{", "}}", "{{#if}}", "{{/if}}", "{{a}}{{#if a}}{{/if}}"]) {
      expect(() => renderPrompt(body, {})).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// THE REGISTRY'S OWN COHERENCE. Cheap invariants that would otherwise rot silently and
// show the operator a prompt whose real inputs it never declared.
// ---------------------------------------------------------------------------

describe("the registry", () => {
  it("defines every slug in PROMPT_SLUGS, with a non-empty default body", () => {
    for (const slug of PROMPT_SLUGS) {
      const definition = PROMPT_REGISTRY[slug];

      expect(definition.slug).toBe(slug);
      expect(definition.defaultBody.trim().length).toBeGreaterThan(0);
      expect(definition.title.trim().length).toBeGreaterThan(0);
      expect(definition.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("DECLARES every variable its default body actually uses", () => {
    // The invariant that keeps the /admin editor honest: if a body interpolates
    // `{{neighbours}}`, the operator must be told `neighbours` is a thing they can
    // reference. An undeclared variable is a prompt the operator cannot safely edit.
    for (const slug of PROMPT_SLUGS) {
      const { defaultBody, variables } = PROMPT_REGISTRY[slug];
      const used = new Set<string>();

      for (const match of defaultBody.matchAll(/\{\{(?:#if\s+)?\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
        const name = match[1];

        if (name) {
          used.add(name);
        }
      }

      for (const name of used) {
        expect(
          variables,
          `${slug}: the default body uses {{${name}}} but does not declare it`,
        ).toContain(name);
      }
    }
  });

  it("renders every default body to a non-empty prompt with NO variables supplied", () => {
    // The degenerate case: the sweep could gather nothing at all. Every prompt must still
    // resolve to something a model can act on rather than to an empty string.
    for (const slug of PROMPT_SLUGS) {
      expect(renderPrompt(PROMPT_REGISTRY[slug].defaultBody, {}).length).toBeGreaterThan(100);
    }
  });

  it("leaves no unsubstituted {{token}} once every declared variable is supplied", () => {
    for (const slug of PROMPT_SLUGS) {
      const definition = PROMPT_REGISTRY[slug];
      const variables = Object.fromEntries(definition.variables.map((name) => [name, "x"]));

      expect(renderPrompt(definition.defaultBody, variables)).not.toMatch(/\{\{|\}\}/);
    }
  });

  it("guards the slug set", () => {
    expect(isPromptSlug("note_author")).toBe(true);
    expect(isPromptSlug("drop table prompts")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE WRITE — append-only. A rollback is a forward move, which is what makes it safe.
// ---------------------------------------------------------------------------

describe("appendPromptVersion", () => {
  it("mints version 1 against an un-overridden prompt", async () => {
    execute.mockResolvedValueOnce({ rows: [{ version: null }] }); // max(version) on an empty slug
    execute.mockResolvedValueOnce({ rows: [] }); // the insert

    expect(await appendPromptVersion({ body: "first", slug: "note_author" })).toEqual({
      version: 1,
    });
  });

  it("mints max(version) + 1 — never mutates, never deletes", async () => {
    execute.mockResolvedValueOnce({ rows: [{ version: 6 }] });
    execute.mockResolvedValueOnce({ rows: [] });

    expect(await appendPromptVersion({ body: "seventh", slug: "note_author" })).toEqual({
      version: 7,
    });

    const insert = execute.mock.calls[1]?.[0];
    expect(insert?.sql).toContain("insert into prompt_versions");
    expect(insert?.sql).not.toContain("update");
    expect(insert?.sql).not.toContain("delete");
    expect(insert?.args).toContain(7);
  });

  it("stores the operator's note (the WHY that makes the history readable)", async () => {
    execute.mockResolvedValueOnce({ rows: [{ version: 2 }] });
    execute.mockResolvedValueOnce({ rows: [] });

    await appendPromptVersion({
      body: "tuned",
      note: "shortened the neighbour block",
      slug: "note_author",
    });

    expect(execute.mock.calls[1]?.[0]?.args).toContain("shortened the neighbour block");
  });

  it("A ROLLBACK IS AN APPEND: re-submitting v3's body mints v8, and v3 still stands", async () => {
    // This is the safety net the whole feature turns on. Rolling back does not rewind the
    // history — it adds to it — so the thing you rolled back FROM is still readable, and
    // the rollback is itself undoable.
    execute.mockResolvedValueOnce({ rows: [{ version: 7 }] });
    execute.mockResolvedValueOnce({ rows: [] });

    const { version } = await appendPromptVersion({
      body: "the body that was live at v3",
      note: "rolled back to v3",
      slug: "note_author",
    });

    expect(version).toBe(8);

    const insert = execute.mock.calls[1]?.[0];
    expect(insert?.sql).toContain("insert into prompt_versions");
    expect(insert?.args).toContain("the body that was live at v3");
    expect(insert?.args).toContain("rolled back to v3");
  });

  it("refuses an empty body (the operator cannot mean 'send the model nothing')", async () => {
    await expect(appendPromptVersion({ body: "   ", slug: "note_author" })).rejects.toThrow(
      /cannot be empty/,
    );
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("listPrompts", () => {
  it("reports the baked default as live for a prompt with no override", async () => {
    execute.mockResolvedValueOnce({ rows: [] });

    const prompts = await listPrompts();
    const note = prompts.find((prompt) => prompt.slug === "note_author");

    expect(prompts).toHaveLength(PROMPT_SLUGS.length);
    expect(note?.source).toBe("default");
    expect(note?.activeVersion).toBe(0);
    expect(note?.activeBody).toBe(PROMPT_REGISTRY.note_author.defaultBody);
    expect(note?.versions).toEqual([]);
  });

  it("reports the newest override as live and carries the whole history", async () => {
    execute.mockResolvedValueOnce({
      rows: [
        {
          body: "v2 body",
          created_at: "2026-07-11T10:00:00.000Z",
          created_by: "operator",
          id: "b",
          note: "tightened it",
          slug: "note_author",
          version: 2,
        },
        {
          body: "v1 body",
          created_at: "2026-07-10T10:00:00.000Z",
          created_by: "operator",
          id: "a",
          note: null,
          slug: "note_author",
          version: 1,
        },
      ],
    });

    const note = (await listPrompts()).find((prompt) => prompt.slug === "note_author");

    expect(note?.source).toBe("override");
    expect(note?.activeVersion).toBe(2);
    expect(note?.activeBody).toBe("v2 body");
    expect(note?.versions.map((version) => version.version)).toEqual([2, 1]);
    // The baked default is always carried, so the operator can diff against it and reset.
    expect(note?.defaultBody).toBe(PROMPT_REGISTRY.note_author.defaultBody);
  });
});
