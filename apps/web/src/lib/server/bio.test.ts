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

const {
  acceptFinalDraftBio,
  buildEntityBioPrompt,
  buildEntityFactsQuery,
  fetchEntityFacts,
  gateBioText,
  maskEntityName,
} = await import("./bio");

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

// The entity a bio is about. Every `gateBioText` call takes one, and its occurrences are masked
// out before the scan (THE NAME EXEMPTION) — so a name with no bearing on the case under test is
// a no-op, and the exemption's own behaviour is pinned in its dedicated block below.
const CALIBRE = "Calibre";

describe("gateBioText", () => {
  it("passes a clean, dry entity bio", () => {
    expect(gateBioText(GOOD_BIO, CALIBRE)).toBe(GOOD_BIO);
  });

  it("trims surrounding whitespace", () => {
    expect(gateBioText(`  ${GOOD_BIO}  `, CALIBRE)).toBe(GOOD_BIO);
  });

  it("throws no_bio for a non-string / empty", () => {
    expect(codeOf(() => gateBioText(undefined, CALIBRE))).toBe("no_bio");
    expect(codeOf(() => gateBioText(42, CALIBRE))).toBe("no_bio");
    expect(codeOf(() => gateBioText("   ", CALIBRE))).toBe("no_bio");
  });

  it("throws bio_too_short below the floor", () => {
    expect(codeOf(() => gateBioText("A producer.", CALIBRE))).toBe("bio_too_short");
  });

  it("throws bio_too_long over the 500-char ceiling", () => {
    // 260 two-char words = 520 chars, past the paragraph cap.
    expect(codeOf(() => gateBioText("ok ".repeat(260), CALIBRE))).toBe("bio_too_long");
  });

  it("accepts a paragraph up to the ceiling (looser than the note's 280 budget)", () => {
    // A ~360-char paragraph — well past a one-line note's 280, comfortably under 500.
    const paragraph =
      "A stamp I trust when the night wants weight without noise, patient and certain in a way the loud imprints never quite land. " +
      "The tracks I have logged from it hold their nerve through the drop and keep their shape after it. " +
      "When one turns up in a set, the crew know before I say a word.";
    expect(paragraph.length).toBeGreaterThan(280);
    expect(paragraph.length).toBeLessThanOrEqual(500);
    expect(gateBioText(paragraph, CALIBRE)).toBe(paragraph);
  });

  it("rejects a banned identity word (voice_gate)", () => {
    expect(
      codeOf(() =>
        gateBioText("A clean transmission of rolling menace, and I have logged plenty.", CALIBRE),
      ),
    ).toBe("voice_gate");
  });

  it("ACCEPTS earthly geography — the factual dossier register names a real place plainly", () => {
    const withCity = "Netsky is a drum and bass producer from Belgium. He has released widely.";
    expect(gateBioText(withCity, "Netsky")).toBe(withCity);

    const withLondon =
      "Hospital Records is a drum and bass label run out of London since the 1990s.";
    expect(gateBioText(withLondon, "Hospital Records")).toBe(withLondon);
  });

  it("returns a realistic factual bio naming geography, trimmed", () => {
    const factual =
      "Calibre is the alias of Dominick Martin, a drum and bass producer from Belfast. He runs the Signature Recordings label and is known for a warm, rolling sound.";
    expect(gateBioText(`  ${factual}  `, CALIBRE)).toBe(factual);
  });

  it("rejects an exclamation mark — the Dry Rule (voice_gate)", () => {
    expect(codeOf(() => gateBioText(`${GOOD_BIO.slice(0, -1)}!`, CALIBRE))).toBe("voice_gate");
  });

  it('rejects "we"-as-company (voice_gate)', () => {
    expect(
      codeOf(() =>
        gateBioText(
          "We keep coming back to this one because the rollers breathe the way they do.",
          CALIBRE,
        ),
      ),
    ).toBe("voice_gate");
  });
});

// ── THE NAME EXEMPTION ───────────────────────────────────────────────────────────────────
//
// The gate polices the prose FLUNCLE wrote and stops policing words it did not choose. An entity's
// own name is not Fluncle's prose: "Future Signal", "Invaderz Transmissions", and "Jungle Sound:
// The Bassline Strikes Back!" are real-world names, and a bio must be able to name its subject.
// Before this, those three could not be written AT ALL — every rewrite named the entity, every
// rewrite tripped the scan, and the box sweep re-authored them ~90 times each over two days.
//
// The bans themselves are untouched. Only the TEXT handed to the scanner changes: exact,
// case-insensitive occurrences of the FULL name are masked out first.

describe("maskEntityName (what the scanner is allowed to see)", () => {
  it("masks every case-insensitive occurrence of the full name", () => {
    expect(maskEntityName("Future Signal is future signal.", "Future Signal")).toBe("  is  .");
  });

  it("leaves the text alone when the name does not appear", () => {
    expect(maskEntityName("A rolling stamp I trust.", "Calibre")).toBe("A rolling stamp I trust.");
  });

  it("leaves the text alone for a blank name (no name, nothing exempt)", () => {
    expect(maskEntityName("A rolling stamp I trust.", "   ")).toBe("A rolling stamp I trust.");
  });

  it("escapes regex metacharacters in a name rather than interpreting them", () => {
    // A name is a trusted identity string, but it is still not a pattern.
    expect(maskEntityName("Sub Focus (UK) rolls.", "Sub Focus (UK)")).toBe("  rolls.");
    expect(maskEntityName("A.B.C. rolls.", "A.B.C.")).toBe("  rolls.");
  });
});

describe("gateBioText + the name exemption (the three production loops)", () => {
  it("PASSES an artist whose own name carries a banned word", () => {
    const bio =
      "Future Signal is a drum and bass producer with a long run of releases behind him. The drums do the talking, and I have logged enough of them to trust the stamp.";
    expect(gateBioText(bio, "Future Signal")).toBe(bio);
  });

  it("PASSES a label whose own name carries a banned word", () => {
    const bio =
      "Invaderz Transmissions is a drum and bass imprint with a taste for the heavier end. The records I have logged from it hold their nerve through the drop.";
    expect(gateBioText(bio, "Invaderz Transmissions")).toBe(bio);
  });

  it("PASSES an album whose own title carries an exclamation mark (the Dry Rule)", () => {
    // Masking the full title removes the punctuation INSIDE it — which is the whole mechanism.
    const bio =
      "Jungle Sound: The Bassline Strikes Back! is a compilation that pulls the older end of the sound back into the room. The cuts I have logged off it still hit.";
    expect(gateBioText(bio, "Jungle Sound: The Bassline Strikes Back!")).toBe(bio);
  });

  // THE PROPERTY THAT KEEPS THE GATE MEANINGFUL. The exemption is for the NAME, not for the word:
  // naming "Future Signal" is fine, using "signal" as a generic word is still a violation.
  it("STILL REJECTS the banned word used generically elsewhere in the same bio", () => {
    expect(
      codeOf(() =>
        gateBioText(
          "Future Signal is a drum and bass producer. Every record is a signal that the night is turning, and I have logged plenty.",
          "Future Signal",
        ),
      ),
    ).toBe("voice_gate");
  });

  it("STILL REJECTS an exclamation mark Fluncle wrote, on an entity whose title contains one", () => {
    expect(
      codeOf(() =>
        gateBioText(
          "Jungle Sound: The Bassline Strikes Back! is a compilation, and the cuts still hit!",
          "Jungle Sound: The Bassline Strikes Back!",
        ),
      ),
    ).toBe("voice_gate");
  });

  // Conservative and intended: the exemption covers the FULL name only, so a shortened reference
  // is still judged. The rewrite can simply use the full name.
  it("REJECTS a partial-name reference (the exemption is the full name only)", () => {
    expect(
      codeOf(() =>
        gateBioText(
          "Signal is a drum and bass producer with a long run of releases behind him, and the drums do the talking.",
          "Future Signal",
        ),
      ),
    ).toBe("voice_gate");
  });

  it("still measures LENGTH on the whole bio, name included", () => {
    // The exemption is about what Fluncle is judged for SAYING, never about the paragraph's size.
    expect(codeOf(() => gateBioText("Future Signal.", "Future Signal"))).toBe("bio_too_short");
  });
});

// ── THE FINAL-ATTEMPT ACCEPTANCE ─────────────────────────────────────────────────────────
//
// The BACKSTOP under the attempt budget: after three authoring attempts the last draft is stored
// even if the scan refuses it, so the queue can never spin on one entity forever. It bypasses the
// voice SCAN only — a present, in-bounds bio is still required — and it hands the violations back
// so the acceptance is logged and reviewable rather than silent.

describe("acceptFinalDraftBio", () => {
  it("returns a clean bio with NO violations (an ordinary write, no marker)", () => {
    expect(acceptFinalDraftBio(GOOD_BIO, CALIBRE)).toEqual({ bio: GOOD_BIO, violations: [] });
  });

  it("ACCEPTS a bio the voice scan refuses, and reports why", () => {
    const refused = "A clean transmission of rolling menace, and I have logged plenty.";
    const accepted = acceptFinalDraftBio(refused, CALIBRE);

    expect(accepted.bio).toBe(refused);
    expect(accepted.violations).toHaveLength(1);
    expect(accepted.violations[0]?.word).toBe("transmission");
  });

  it("runs the SAME name exemption, so it never reports the entity's own name back", () => {
    const bio =
      "Future Signal is a drum and bass producer with a long run of releases behind him. The drums do the talking, and I have logged enough of them to trust the stamp.";
    expect(acceptFinalDraftBio(bio, "Future Signal").violations).toEqual([]);
  });

  it("STILL enforces the structural bounds — those are not voice judgments", () => {
    expect(codeOf(() => acceptFinalDraftBio(undefined, CALIBRE))).toBe("no_bio");
    expect(codeOf(() => acceptFinalDraftBio("   ", CALIBRE))).toBe("no_bio");
    expect(codeOf(() => acceptFinalDraftBio("A producer.", CALIBRE))).toBe("bio_too_short");
    expect(codeOf(() => acceptFinalDraftBio("ok ".repeat(260), CALIBRE))).toBe("bio_too_long");
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

  it("anchors an album query on album + the genre lane", () => {
    expect(buildEntityFactsQuery("album", "Colours in the Dark")).toBe(
      "Colours in the Dark drum and bass album",
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

  it("renders the baked album prompt with the grounding rail, findings, and name", async () => {
    const { body, version } = await buildEntityBioPrompt({
      facts: "Third studio album; released on Hospital Records.",
      findingTitles: ["Higher Ground"],
      kind: "album",
      name: "Colours in the Dark",
    });

    expect(version).toBe(0);
    expect(body).toContain("GROUNDING RAIL");
    expect(body).toContain("Colours in the Dark");
    expect(body).toContain("Higher Ground");
    expect(body).toContain("Hospital Records");
  });
});
