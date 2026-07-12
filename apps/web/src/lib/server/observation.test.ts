import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The distil resolves its system prompt from the registry (./prompts.ts), which reads the
// `prompt_versions` table. This suite drives a mocked global `fetch`, and an unmocked
// libSQL client would try to reach the database THROUGH it — so stub the db to the cold
// state (no override on file). The distil then runs on the registry's baked default at
// version 0, which is exactly what production does before anyone edits a prompt.
vi.mock("./db", () => ({
  getDb: async () => ({ execute: async () => ({ rows: [] }) }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

// The Apple editorial leg (RFC U5): the oracle read + the cross-cutting breaker/meter are
// mocked so the gate-integration tests can drive Apple fuel + the breaker's allow/deny without a
// live token or the settings KV. The breaker/meter themselves are proven in apple-breaker.test.ts;
// what matters here is the CONTRACT — fetchTrackContext folds Apple in, meters the call, and runs
// the n-gram gate on the authored note.
const appleCatalogLookupByIsrc = vi.fn();
const recordAppleCall = vi.fn();
const recordAppleAuthOutcome = vi.fn();
const appleGate = { budget: true, calls: true };

vi.mock("./apple-music", () => ({
  appleCatalogLookupByIsrc: (isrc: string) => appleCatalogLookupByIsrc(isrc),
}));

vi.mock("./apple-breaker", () => ({
  areAppleCallsAllowed: async () => appleGate.calls,
  isAppleCallBudgetAvailable: async () => appleGate.budget,
  recordAppleAuthOutcome: (...args: unknown[]) => recordAppleAuthOutcome(...args),
  recordAppleCall: (...args: unknown[]) => recordAppleCall(...args),
}));

import {
  APPLE_EDITORIAL_SNIPPET_LABEL,
  CONTEXT_DISTIL_SYSTEM_PROMPT,
  OBSERVATION_TAIL_PAD_MS,
  buildContextQuery,
  distilContextNote,
  fetchTrackContext,
  gateObservationScript,
  longestVerbatimTokenSpan,
  noteEchoesAppleEditorial,
  observationDurationFromAlignment,
  sanitizeForCartesia,
  scanObservationScript,
  stripEditorialHtml,
  wordsFromCartesia,
} from "./observation";

// The voice gate's automatable half (VOICE.md §3 bans + the Dry Rule + no
// "we"-as-company). The North-Star human sign-off on the rendered audio is a
// separate content control; this only covers the mechanical scan.

const CLEAN =
  "Arrived on the dark side of the sector and this one moved at a hard, even pace. Knees went up before I clocked the coordinate. Logged it as fluncle://004.7.2I. Hope it gets an oof out of you, fam.";

describe("scanObservationScript", () => {
  it("passes a clean recovered-audio observation", () => {
    expect(scanObservationScript(CLEAN)).toEqual([]);
  });

  it("flags the banned identity word 'signal'", () => {
    const violations = scanObservationScript("The signal carried a clean pace, fam.");
    expect(violations.some((v) => v.word === "signal")).toBe(true);
  });

  it("flags 'transmission'", () => {
    const violations = scanObservationScript("Picked up the transmission and the knees went up.");
    expect(violations.some((v) => v.word === "transmission")).toBe(true);
  });

  it("does not false-positive on 'signature' (whole-word match)", () => {
    expect(scanObservationScript("Pure Calibre, the Signature sound, fam.")).toEqual([]);
  });

  it("flags an exclamation mark (the Dry Rule)", () => {
    const violations = scanObservationScript("This one threw me three sectors sideways!");
    expect(violations.some((v) => v.reason.includes("exclamation"))).toBe(true);
  });

  it('flags "we" as a company', () => {
    const violations = scanObservationScript("We logged this one out past the next sector, fam.");
    expect(violations.some((v) => v.reason.includes("we"))).toBe(true);
  });

  it("flags earthly geography (a nationality leaking from the context_note)", () => {
    const violations = scanObservationScript(
      "This one flies the flag for the American side of the map, fam.",
    );
    expect(violations.some((v) => v.word === "american")).toBe(true);
    expect(violations.some((v) => v.reason.includes("geography"))).toBe(true);
  });

  it("flags the dotted abbreviation 'u.k.'", () => {
    const violations = scanObservationScript(
      "Came up out of the u.k. scene and the knees went up, fam.",
    );
    expect(violations.some((v) => v.word === "u.k.")).toBe(true);
  });

  it("passes a clean cosmic observation with no earthly geography", () => {
    expect(
      scanObservationScript(
        "Came in from a far sector and the air went thick. Knees went up before I clocked the coordinate. Hope it does the same to you, fam.",
      ),
    ).toEqual([]);
  });
});

describe("gateObservationScript", () => {
  it("returns the trimmed text for a clean script", () => {
    expect(gateObservationScript(`  ${CLEAN}  `)).toBe(CLEAN);
  });

  it("throws no_script for a non-string or empty script", () => {
    expect(() => gateObservationScript(undefined)).toThrowError(/required/);
    expect(() => gateObservationScript("   ")).toThrowError(/required/);
  });

  it("throws script_too_short below the floor", () => {
    expect(() => gateObservationScript("Oof, banger.")).toThrowError(/too short/);
  });

  it("throws voice_gate on a banned word", () => {
    expect(() =>
      gateObservationScript(
        "The signal carried a clean, even pace and the knees went up before I clocked the coordinate, fam.",
      ),
    ).toThrowError(/voice gate/);
  });

  it("throws voice_gate with a geography reason on earthly geography", () => {
    expect(() =>
      gateObservationScript(
        "This one flies the flag for the American side of the map and the knees went up before I clocked the coordinate, fam.",
      ),
    ).toThrowError(/geography/);
  });
});

// ── The context fetch + distil (the clean-note rework) ───────────────────────

describe("buildContextQuery", () => {
  it("assembles artist + title + label + the genre anchor", () => {
    expect(
      buildContextQuery({ artists: ["Calibre", "DRS"], label: "Signature", title: "Mr Right On" }),
    ).toBe("Calibre DRS Mr Right On Signature drum and bass");
  });

  it("DROPS the release date (a literal date breaks the search — 'Missing: <date>')", () => {
    // The old query folded releaseDate in; the new one never references it, even if
    // an extra field is present on the passed object.
    const query = buildContextQuery({
      artists: ["Calibre"],
      label: "Signature",
      // @ts-expect-error releaseDate is no longer part of the query input
      releaseDate: "2017-08-11",
      title: "Mr Right On",
    });
    expect(query).not.toContain("2017");
    expect(query).toBe("Calibre Mr Right On Signature drum and bass");
  });

  it("omits a missing label", () => {
    expect(buildContextQuery({ artists: ["Calibre"], title: "Mr Right On" })).toBe(
      "Calibre Mr Right On drum and bass",
    );
  });
});

// A tiny URL-routing fetch mock (mirrors discogs.test.ts): map a URL substring to a
// JSON body or a Response. Records calls + parsed bodies so a test can assert the
// distil prompt assembly and the releaseDate-free query without a live vendor.
function mockFetch(routes: Array<{ body?: unknown; match: string; response?: Response }>): {
  bodies: Record<string, unknown>;
  calls: string[];
} {
  const calls: string[] = [];
  const bodies: Record<string, unknown> = {};

  const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(url);

    if (typeof init?.body === "string") {
      bodies[url] = JSON.parse(init.body);
    }

    const route = routes.find((candidate) => url.includes(candidate.match));

    if (!route) {
      return new Response("not found", { status: 404 });
    }

    return route.response ?? Response.json(route.body);
  });

  vi.stubGlobal("fetch", fetchMock);

  return { bodies, calls };
}

const FIRECRAWL_MATCH = "api.firecrawl.dev/v2/search";
const OPENROUTER_MATCH = "openrouter.ai/api/v1/chat/completions";

// A Firecrawl search payload with soupy snippets + a lyric-domain hit to filter.
const SOUPY_FIRECRAWL = {
  data: {
    web: [
      {
        description: "12,304,991 views · 5:42 · €1.29 · Calibre - Mr Right On (Signature, 2017)",
        title: "Calibre - Mr Right On [Official]",
        url: "https://youtube.com/watch?v=abc",
      },
      {
        description: "Lyrics: ...",
        title: "Mr Right On Lyrics",
        url: "https://genius.com/calibre-mr-right-on-lyrics",
      },
      {
        description: "Released August 2017 on Signature Recordings, Calibre's own label.",
        title: "Signature Recordings — Mr Right On",
        url: "https://discogs.com/release/123",
      },
    ],
  },
};

describe("distilContextNote", () => {
  const ORIGINAL_KEY = process.env.OPENROUTER_API_KEY;
  const ORIGINAL_MODEL = process.env.OPENROUTER_CONTEXT_MODEL;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    delete process.env.OPENROUTER_CONTEXT_MODEL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.OPENROUTER_API_KEY = ORIGINAL_KEY;
    process.env.OPENROUTER_CONTEXT_MODEL = ORIGINAL_MODEL;
  });

  it("assembles the prompt (system + snippets + sources) and defaults the model", async () => {
    const { bodies, calls } = mockFetch([
      {
        body: { choices: [{ message: { content: "Mr Right On is a 2017 Calibre track." } }] },
        match: OPENROUTER_MATCH,
      },
    ]);

    const note = await distilContextNote({
      query: "Calibre Mr Right On Signature drum and bass",
      snippets: ["Calibre - Mr Right On [Official]", "Signature Recordings — Mr Right On"],
      sources: ["https://discogs.com/release/123"],
    });

    // The distil now returns the note PLUS the prompt version that produced it (the
    // provenance that lands on `findings.context_prompt_version`). With no override row
    // on file — and, in this suite, no reachable database at all — it resolves to the
    // registry's baked default, version 0. That fallback is the point: the distil runs
    // exactly as it did when the prompt was a const.
    expect(note?.note).toBe("Mr Right On is a 2017 Calibre track.");
    expect(note?.promptVersion).toBe(0);
    const url = calls[0];
    expect(url).toContain(OPENROUTER_MATCH);

    const sent = bodies[url ?? ""] as {
      messages: { content: string; role: string }[];
      model: string;
    };
    expect(sent.model).toBe("anthropic/claude-haiku-4.5");
    expect(sent.messages[0]?.role).toBe("system");
    expect(sent.messages[0]?.content).toBe(CONTEXT_DISTIL_SYSTEM_PROMPT);
    // The snippets + sources ride in the user turn as labelled DATA.
    expect(sent.messages[1]?.content).toContain("Mr Right On [Official]");
    expect(sent.messages[1]?.content).toContain("https://discogs.com/release/123");
  });

  it("honours OPENROUTER_CONTEXT_MODEL when set", async () => {
    process.env.OPENROUTER_CONTEXT_MODEL = "openai/gpt-4o-mini";
    const { bodies, calls } = mockFetch([
      { body: { choices: [{ message: { content: "A note." } }] }, match: OPENROUTER_MATCH },
    ]);

    await distilContextNote({ query: "q", snippets: ["a snippet"], sources: [] });

    expect((bodies[calls[0] ?? ""] as { model: string }).model).toBe("openai/gpt-4o-mini");
  });

  it("returns null with no snippets (nothing to distil — never calls the vendor)", async () => {
    const { calls } = mockFetch([]);
    expect(await distilContextNote({ query: "q", snippets: [], sources: [] })).toBeNull();
    expect(calls.length).toBe(0);
  });

  it("returns null when OPENROUTER_API_KEY is unset (unprovisioned → raw fallback)", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const { calls } = mockFetch([]);
    expect(
      await distilContextNote({ query: "q", snippets: ["a snippet"], sources: [] }),
    ).toBeNull();
    expect(calls.length).toBe(0);
  });

  it("returns null on an OpenRouter error (best-effort → raw fallback)", async () => {
    mockFetch([{ match: OPENROUTER_MATCH, response: new Response("boom", { status: 500 }) }]);
    expect(
      await distilContextNote({ query: "q", snippets: ["a snippet"], sources: [] }),
    ).toBeNull();
  });
});

describe("fetchTrackContext (status transitions + distil/fallback)", () => {
  const ORIGINAL_FIRECRAWL = process.env.FIRECRAWL_API_KEY;
  const ORIGINAL_OPENROUTER = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    process.env.FIRECRAWL_API_KEY = "test-firecrawl-key";
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    delete process.env.OPENROUTER_CONTEXT_MODEL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.FIRECRAWL_API_KEY = ORIGINAL_FIRECRAWL;
    process.env.OPENROUTER_API_KEY = ORIGINAL_OPENROUTER;
  });

  it("resolved: distils the snippets, drops lyric domains, keeps sources", async () => {
    mockFetch([
      { body: SOUPY_FIRECRAWL, match: FIRECRAWL_MATCH },
      {
        body: {
          choices: [
            {
              message: {
                content:
                  "Mr Right On is a 2017 Calibre track on his own Signature Recordings.\nTexture: rolling, warm, nocturnal.",
              },
            },
          ],
        },
        match: OPENROUTER_MATCH,
      },
    ]);

    const result = await fetchTrackContext("Calibre Mr Right On Signature drum and bass");

    expect(result.status).toBe("resolved");
    expect(result.distilled).toBe(true);
    expect(result.contextNote).toContain("Signature Recordings");
    expect(result.contextNote).toContain("Texture:");
    // The lyric-domain hit is filtered out of the sources.
    expect(result.sources).toEqual([
      "https://youtube.com/watch?v=abc",
      "https://discogs.com/release/123",
    ]);
  });

  it("resolved with fallback: a distil failure stores the cleaned RAW note", async () => {
    delete process.env.OPENROUTER_API_KEY; // distil no-ops → raw fallback
    mockFetch([{ body: SOUPY_FIRECRAWL, match: FIRECRAWL_MATCH }]);

    const result = await fetchTrackContext("Calibre Mr Right On");

    expect(result.status).toBe("resolved");
    expect(result.distilled).toBe(false);
    // The raw note carries the non-lyric snippet text and never the lyric hit.
    expect(result.contextNote).toContain("Mr Right On [Official]");
    expect(result.contextNote).not.toContain("Mr Right On Lyrics");
  });

  it("empty: Firecrawl returns no usable web results", async () => {
    mockFetch([{ body: { data: { web: [] } }, match: FIRECRAWL_MATCH }]);

    const result = await fetchTrackContext("nothing here");

    expect(result.status).toBe("empty");
    expect(result.contextNote).toBe("");
    expect(result.distilled).toBe(false);
  });

  it("failed: a Firecrawl vendor error is distinct from empty", async () => {
    mockFetch([{ match: FIRECRAWL_MATCH, response: new Response("down", { status: 502 }) }]);

    const result = await fetchTrackContext("anything");

    expect(result.status).toBe("failed");
    expect(result.contextNote).toBe("");
  });
});

describe("observationDurationFromAlignment", () => {
  it("derives the real length from the last word's end plus the tail pad", () => {
    const duration = observationDurationFromAlignment({
      source: "cartesia",
      words: [
        { endMs: 1200, startMs: 0, text: "a" },
        { endMs: 38239, startMs: 37000, text: "fam" },
      ],
    });

    // 38239 (real audio end) + pad — NOT the old flat 30000 that cut the seam.
    expect(duration).toBe(38239 + OBSERVATION_TAIL_PAD_MS);
  });

  it("uses the MAX end, not the last entry's (out-of-order safe)", () => {
    const duration = observationDurationFromAlignment({
      source: "cartesia",
      words: [
        { endMs: 40000, startMs: 39000, text: "late" },
        { endMs: 1000, startMs: 0, text: "early" },
      ],
    });

    expect(duration).toBe(40000 + OBSERVATION_TAIL_PAD_MS);
  });

  it("returns undefined for a missing or empty alignment (caller keeps its fallback)", () => {
    expect(observationDurationFromAlignment(null)).toBeUndefined();
    expect(observationDurationFromAlignment(undefined)).toBeUndefined();
    expect(observationDurationFromAlignment({ source: "cartesia", words: [] })).toBeUndefined();
  });
});

describe("sanitizeForCartesia", () => {
  it("strips <break> SSML entirely (Cartesia doesn't parse it) and the em-dash", () => {
    expect(sanitizeForCartesia('rolls you quiet. <break time="1.0s"/> Days Like These.')).toBe(
      "rolls you quiet. Days Like These.",
    );
    expect(sanitizeForCartesia("BOP, Unquote — Drifting Away")).toBe("BOP, Unquote, Drifting Away");
  });
});

describe("wordsFromCartesia", () => {
  it("zips the parallel second-arrays into the stored ms word shape", () => {
    expect(wordsFromCartesia(["Hello", "world"], [0, 0.51], [0.4, 0.92])).toEqual([
      { endMs: 400, startMs: 0, text: "Hello" },
      { endMs: 920, startMs: 510, text: "world" },
    ]);
  });

  it("drops empty/whitespace word tokens and tolerates a length mismatch", () => {
    expect(wordsFromCartesia(["hi", "  ", "yo"], [0, 0.2, 0.3], [0.2, 0.3])).toEqual([
      { endMs: 200, startMs: 0, text: "hi" },
    ]);
  });

  it("returns null for empty input", () => {
    expect(wordsFromCartesia([], [], [])).toBeNull();
  });
});

// ── The Apple editorial echo gate (RFC U5) ───────────────────────────────────────────────────
// The mechanical, panel-mandated defence: a distil told to "summarise, never quote" Apple's
// editorial copy is prompt-trust, not a guarantee, so the gate REJECTS any authored note that
// lifts a contiguous ≥7-token span verbatim from an Apple source. The pure functions first, then
// the end-to-end fold + gate through fetchTrackContext.

describe("stripEditorialHtml", () => {
  it("drops tag spans and decodes the entities Apple emits", () => {
    expect(stripEditorialHtml("A <i>rolling</i> roller &amp; a <br/> stepper &#39;97")).toBe(
      "A rolling roller & a stepper '97",
    );
  });
});

describe("longestVerbatimTokenSpan", () => {
  it("counts the longest contiguous shared token run, punctuation-insensitively", () => {
    const note = "It is a warm, rolling roller from the label, apparently.";
    const source = "They called it a warm rolling roller from the label of the year.";
    // "a warm rolling roller from the label" = 7 contiguous tokens.
    expect(longestVerbatimTokenSpan(note, source)).toBe(7);
  });

  it("is 0 when nothing contiguous is shared", () => {
    expect(longestVerbatimTokenSpan("wholly different words here", "nothing at all alike")).toBe(0);
  });
});

describe("noteEchoesAppleEditorial (the n-gram gate)", () => {
  const SOURCE = "This tune is a warm rolling roller from the label that defined the sound.";

  it("REJECTS a note that lifts a verbatim ≥7-token span", () => {
    const echo = "Fluncle says it is a warm rolling roller from the label, basically.";
    expect(noteEchoesAppleEditorial(echo, [SOURCE])).toBe(true);
  });

  it("PASSES a clean paraphrase that shares no long span", () => {
    const paraphrase =
      "A warm roller with a rolling groove, put out by a label that shaped the era.";
    expect(noteEchoesAppleEditorial(paraphrase, [SOURCE])).toBe(false);
  });

  it("boundary: exactly 7 tokens rejects, 6 passes", () => {
    const seven = "warm rolling roller from the label that"; // 7 contiguous tokens of SOURCE
    const six = "warm rolling roller from the label"; // 6
    expect(noteEchoesAppleEditorial(seven, [SOURCE])).toBe(true);
    expect(noteEchoesAppleEditorial(six, [SOURCE])).toBe(false);
  });

  it("an empty note or an empty source set never echoes", () => {
    expect(noteEchoesAppleEditorial("", [SOURCE])).toBe(false);
    expect(noteEchoesAppleEditorial("anything at all here", [])).toBe(false);
  });
});

describe("fetchTrackContext (Apple editorial fuel + the echo gate)", () => {
  const ORIGINAL_FIRECRAWL = process.env.FIRECRAWL_API_KEY;
  const ORIGINAL_OPENROUTER = process.env.OPENROUTER_API_KEY;

  const appleOk = (notes: { short?: string; standard?: string }) => ({
    bundle: {
      canonicalAlbum: {
        editorialNotesShort: notes.short,
        editorialNotesStandard: notes.standard,
        id: "album-1",
      },
      songId: "song-1",
      songUrl: "https://music.apple.com/us/album/x?i=1",
    },
    configured: true as const,
    ok: true as const,
  });

  beforeEach(() => {
    process.env.FIRECRAWL_API_KEY = "test-firecrawl-key";
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    delete process.env.OPENROUTER_CONTEXT_MODEL;
    appleGate.budget = true;
    appleGate.calls = true;
    appleCatalogLookupByIsrc.mockReset();
    recordAppleCall.mockReset();
    recordAppleAuthOutcome.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.FIRECRAWL_API_KEY = ORIGINAL_FIRECRAWL;
    process.env.OPENROUTER_API_KEY = ORIGINAL_OPENROUTER;
  });

  it("folds Apple editorial notes into the distil, keeps the song URL as a source, meters the call", async () => {
    appleCatalogLookupByIsrc.mockResolvedValue(
      appleOk({ standard: "An amen-driven roller Apple loves." }),
    );
    const { bodies, calls } = mockFetch([
      { body: SOUPY_FIRECRAWL, match: FIRECRAWL_MATCH },
      {
        body: { choices: [{ message: { content: "A warm 2017 roller with an amen backbone." } }] },
        match: OPENROUTER_MATCH,
      },
    ]);

    const result = await fetchTrackContext(
      "Calibre Mr Right On",
      { trackId: "t1" },
      {
        isrc: "GB1234567890",
      },
    );

    expect(result.status).toBe("resolved");
    expect(result.contextNote).toContain("amen backbone");
    // Apple's song URL joins the provenance sources.
    expect(result.sources).toContain("https://music.apple.com/us/album/x?i=1");
    // The Apple copy rode into the distil's user turn as LABELLED untrusted data.
    const orUrl = calls.find((u) => u.includes(OPENROUTER_MATCH)) ?? "";
    const sent = bodies[orUrl] as { messages: { content: string }[] };
    expect(sent.messages[1]?.content).toContain(APPLE_EDITORIAL_SNIPPET_LABEL);
    expect(sent.messages[1]?.content).toContain("amen-driven roller Apple loves");
    // One real call → metered + its auth outcome fed to the breaker.
    expect(recordAppleCall).toHaveBeenCalledTimes(1);
    expect(recordAppleAuthOutcome).toHaveBeenCalledWith("ok");
  });

  it("REJECTS the note to the empty floor when the distil echoes Apple verbatim", async () => {
    appleCatalogLookupByIsrc.mockResolvedValue(
      appleOk({ standard: "A rolling amen roller that defined the Signature sound of the year." }),
    );
    mockFetch([
      { body: SOUPY_FIRECRAWL, match: FIRECRAWL_MATCH },
      {
        body: {
          choices: [
            {
              message: {
                // Lifts a verbatim ≥7-token span straight from Apple's copy.
                content:
                  "Fluncle reckons it is a rolling amen roller that defined the Signature sound, basically.",
              },
            },
          ],
        },
        match: OPENROUTER_MATCH,
      },
    ]);

    const result = await fetchTrackContext("Calibre", { trackId: "t1" }, { isrc: "GB1234567890" });

    // The honest empty floor — fill-empty-only leaves the finding as it was.
    expect(result.status).toBe("empty");
    expect(result.contextNote).toBe("");
    expect(result.distilled).toBe(false);
  });

  it("resolves on Apple fuel alone when Firecrawl returns nothing (fold precedes the empty gate)", async () => {
    appleCatalogLookupByIsrc.mockResolvedValue(
      appleOk({ standard: "An underground amen roller." }),
    );
    mockFetch([
      { body: { data: { web: [] } }, match: FIRECRAWL_MATCH },
      {
        body: {
          choices: [{ message: { content: "A paraphrased underground roller with amen breaks." } }],
        },
        match: OPENROUTER_MATCH,
      },
    ]);

    const result = await fetchTrackContext("x", { trackId: "t1" }, { isrc: "GB1234567890" });

    expect(result.status).toBe("resolved");
    expect(result.sources).toContain("https://music.apple.com/us/album/x?i=1");
  });

  it("short-circuits Apple when the breaker is tripped — no oracle call, no fuel", async () => {
    appleGate.calls = false;
    appleCatalogLookupByIsrc.mockResolvedValue(appleOk({ standard: "should never be read" }));
    mockFetch([
      { body: SOUPY_FIRECRAWL, match: FIRECRAWL_MATCH },
      {
        body: { choices: [{ message: { content: "A clean firecrawl-only note." } }] },
        match: OPENROUTER_MATCH,
      },
    ]);

    const result = await fetchTrackContext("Calibre", { trackId: "t1" }, { isrc: "GB1234567890" });

    expect(appleCatalogLookupByIsrc).not.toHaveBeenCalled();
    expect(recordAppleCall).not.toHaveBeenCalled();
    expect(result.status).toBe("resolved");
  });

  it("no-ops without recording when MusicKit is unconfigured", async () => {
    appleCatalogLookupByIsrc.mockResolvedValue({ configured: false });
    mockFetch([
      { body: SOUPY_FIRECRAWL, match: FIRECRAWL_MATCH },
      {
        body: { choices: [{ message: { content: "A clean note." } }] },
        match: OPENROUTER_MATCH,
      },
    ]);

    const result = await fetchTrackContext("Calibre", { trackId: "t1" }, { isrc: "GB123" });

    expect(appleCatalogLookupByIsrc).toHaveBeenCalledTimes(1);
    expect(recordAppleCall).not.toHaveBeenCalled();
    expect(recordAppleAuthOutcome).not.toHaveBeenCalled();
    expect(result.status).toBe("resolved");
  });

  it("feeds an auth_failure outcome to the breaker on a 401/403 oracle result", async () => {
    appleCatalogLookupByIsrc.mockResolvedValue({
      authFailed: true,
      configured: true as const,
      error: "Apple Music request failed: 403 Forbidden",
      ok: false as const,
      rateLimited: false,
    });
    mockFetch([
      { body: SOUPY_FIRECRAWL, match: FIRECRAWL_MATCH },
      {
        body: { choices: [{ message: { content: "A clean firecrawl-only note." } }] },
        match: OPENROUTER_MATCH,
      },
    ]);

    const result = await fetchTrackContext("Calibre", { trackId: "t1" }, { isrc: "GB123" });

    expect(recordAppleCall).toHaveBeenCalledTimes(1);
    expect(recordAppleAuthOutcome).toHaveBeenCalledWith("auth_failure");
    // A failed Apple leg never blocks the Firecrawl-derived note.
    expect(result.status).toBe("resolved");
  });
});
