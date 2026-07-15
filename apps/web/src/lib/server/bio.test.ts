import { beforeEach, describe, expect, it, vi } from "vitest";

// The entity-bio engine (lib/server/bio.ts): the voice gate, the Firecrawl fact query, and
// the prompt-assembly helper. The gate is the artist/label sibling of `gateNoteText`, but in
// the FACTUAL DOSSIER register — it reuses the SAME shared voice scan for the banned identity
// words, the Dry Rule's no-exclamation-marks, and no "we"-as-company, while ALLOWING earthly
// geography (a Wikipedia-style bio names a real country or city plainly). It carries the bio's
// own longer length ceiling (a 2–4 sentence paragraph, not a one-line note). A bio lands on a
// public entity page, so a violation hard-fails the store.

// `renderRegisteredPrompt` reads the prompt override table; with the store mocked to throw,
// `resolvePrompt` falls back to the baked default (version 0) — its cardinal guarantee. So
// `buildEntityBioPrompt` here exercises the BAKED prompt, exactly the floor a real sweep hits.
const execute = vi.fn();

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRow: (rows: unknown[]) => rows[0],
  typedRows: (rows: unknown[]) => rows,
}));

const readOptionalEnv = vi.fn();

vi.mock("./env", () => ({
  readEnv: (...args: unknown[]) => readOptionalEnv(...args),
  readOptionalEnv: (...args: unknown[]) => readOptionalEnv(...args),
}));

const { buildEntityBioPrompt, buildEntityFactsQuery, fetchEntityFacts, gateBioText } =
  await import("./bio");

beforeEach(() => {
  execute.mockReset().mockRejectedValue(new Error("store down"));
  readOptionalEnv.mockReset();
});

// A clean, dry, in-voice two-sentence bio — the shape the sweep should produce.
const GOOD_BIO =
  "One of the names I keep coming back to when the rollers need to breathe. The drums do the talking, and I have logged enough of them to trust the stamp.";

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? "(no code)";
  }

  return "(did not throw)";
}

describe("gateBioText", () => {
  it("passes a clean, dry entity bio", () => {
    expect(gateBioText(GOOD_BIO)).toBe(GOOD_BIO);
  });

  it("trims surrounding whitespace", () => {
    expect(gateBioText(`  ${GOOD_BIO}  `)).toBe(GOOD_BIO);
  });

  it("throws no_bio for a non-string / empty", () => {
    expect(codeOf(() => gateBioText(undefined))).toBe("no_bio");
    expect(codeOf(() => gateBioText(42))).toBe("no_bio");
    expect(codeOf(() => gateBioText("   "))).toBe("no_bio");
  });

  it("throws bio_too_short below the floor", () => {
    expect(codeOf(() => gateBioText("A producer."))).toBe("bio_too_short");
  });

  it("throws bio_too_long over the 500-char ceiling", () => {
    // 260 two-char words = 520 chars, past the paragraph cap.
    expect(codeOf(() => gateBioText("ok ".repeat(260)))).toBe("bio_too_long");
  });

  it("accepts a paragraph up to the ceiling (looser than the note's 280 budget)", () => {
    // A ~360-char paragraph — well past a one-line note's 280, comfortably under 500.
    const paragraph =
      "A stamp I trust when the night wants weight without noise, patient and certain in a way the loud imprints never quite land. " +
      "The tracks I have logged from it hold their nerve through the drop and keep their shape after it. " +
      "When one turns up in a set, the crew know before I say a word.";
    expect(paragraph.length).toBeGreaterThan(280);
    expect(paragraph.length).toBeLessThanOrEqual(500);
    expect(gateBioText(paragraph)).toBe(paragraph);
  });

  it("rejects a banned identity word (voice_gate)", () => {
    expect(
      codeOf(() =>
        gateBioText("A clean transmission of rolling menace, and I have logged plenty."),
      ),
    ).toBe("voice_gate");
  });

  it("ACCEPTS earthly geography — the factual dossier register names a real place plainly", () => {
    const withCity = "Netsky is a drum and bass producer from Belgium. He has released widely.";
    expect(gateBioText(withCity)).toBe(withCity);

    const withLondon =
      "Hospital Records is a drum and bass label run out of London since the 1990s.";
    expect(gateBioText(withLondon)).toBe(withLondon);
  });

  it("returns a realistic factual bio naming geography, trimmed", () => {
    const factual =
      "Calibre is the alias of Dominick Martin, a drum and bass producer from Belfast. He runs the Signature Recordings label and is known for a warm, rolling sound.";
    expect(gateBioText(`  ${factual}  `)).toBe(factual);
  });

  it("rejects an exclamation mark — the Dry Rule (voice_gate)", () => {
    expect(codeOf(() => gateBioText(`${GOOD_BIO.slice(0, -1)}!`))).toBe("voice_gate");
  });

  it('rejects "we"-as-company (voice_gate)', () => {
    expect(
      codeOf(() =>
        gateBioText("We keep coming back to this one because the rollers breathe the way they do."),
      ),
    ).toBe("voice_gate");
  });
});

describe("buildEntityFactsQuery", () => {
  it("anchors an artist query on producer + the genre lane", () => {
    expect(buildEntityFactsQuery("artist", "Calibre")).toBe("Calibre drum and bass producer");
  });

  it("anchors a label query on record label + the genre lane", () => {
    expect(buildEntityFactsQuery("label", "Shogun Audio")).toBe(
      "Shogun Audio drum and bass record label",
    );
  });
});

describe("fetchEntityFacts", () => {
  it("returns null (no facts, skip) when Firecrawl is unprovisioned", async () => {
    readOptionalEnv.mockResolvedValue(undefined);

    expect(await fetchEntityFacts({ kind: "artist", name: "Calibre" })).toBeNull();
  });
});

describe("buildEntityBioPrompt (the reusable authoring-prompt assembly)", () => {
  it("renders the baked artist prompt with the grounding rail, findings, and name", async () => {
    const { body, version } = await buildEntityBioPrompt({
      facts: "Runs the Signature imprint; long-running producer.",
      findingTitles: ["Mr Majestic", "Even If"],
      kind: "artist",
      name: "Calibre",
    });

    // The store is down, so the baked default (version 0) is what a real sweep would hit.
    expect(version).toBe(0);
    // THE GROUNDING RAIL is present and load-bearing.
    expect(body).toContain("GROUNDING RAIL");
    expect(body).toContain("Never invent");
    // The concrete, true material — the name + the logged findings — is interpolated in.
    expect(body).toContain("Calibre");
    expect(body).toContain("Mr Majestic");
    expect(body).toContain("Even If");
    // The gathered facts rode in as grounding fuel.
    expect(body).toContain("Signature imprint");
    // findingCount reflects the logged tracks.
    expect(body).toContain("2");
  });

  it("fires the noFacts branch (author from findings alone) when no facts are gathered", async () => {
    const { body } = await buildEntityBioPrompt({
      facts: null,
      findingTitles: ["Terminus"],
      kind: "label",
      name: "Metalheadz",
    });

    expect(body).toContain("No facts gathered");
    expect(body).toContain("Metalheadz");
    expect(body).toContain("Terminus");
  });
});
