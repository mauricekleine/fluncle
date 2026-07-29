// Unit tests for entity-bio-sweep.ts — the load-bearing seams the box scripts being
// self-contained (they cannot import the workspace) let us pin without a live CLI/DB:
//
//   1. `isAuthorableDraft` — the Worker-draft GATE. The box triggers `draft-bio` (the
//      Worker-paced grounding read) per queued entity; the sweep only authors when the
//      Worker RESOLVED the entity and returned a non-empty prompt. A null draft (a failed
//      call / gather) or a `found:false` (unresolved slug) is a clean skip — never an
//      author. This is the Worker-paced parity with the context-note sweep.
//   2. `bioCostEvent` — the COST-01 metering seam. The ledger tracks DELIVERED work: a `bio`
//      authoring-spend row is recorded ONLY when a bio was actually authored AND stored this
//      tick, NEVER on a dry-run, an operator-bio no-op, a gate rejection, or a failure. Its
//      shape mirrors note-sweep's `note` row (subsidized/anthropic/tokens/measured), just
//      with `step: "bio"` and the entity slug as the id scope.
//   3. THE ATTEMPT BUDGET — the fix for the unbounded rewrite loop. The pure ledger seams
//      (parse/format/plan/select), and then the REAL `describeOne` loop driven end to end
//      against stub `fluncle`/`claude` binaries, because "authored at most three times, ever"
//      is a claim about the code that runs, not about arithmetic re-implemented beside it.
//
// This file uses `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/entity-bio-sweep.test.ts

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costEventId } from "./cost-emit";

// The stub rig has to be on disk and pointed at by env BEFORE the sweep module is evaluated:
// FLUNCLE_BIN / CLAUDE_BIN / ENTITY_BIO_STATE_DIR are all read at module load.
const RIG = mkdtempSync(join(tmpdir(), "entity-bio-sweep-test-"));
const STATE_DIR = join(RIG, "state");
const CONTROL = join(RIG, "control");
const FLUNCLE_STUB = join(RIG, "fluncle");
const CLAUDE_STUB = join(RIG, "claude");

mkdirSync(CONTROL, { recursive: true });

// A stub `claude -p`: consumes the prompt on stdin, records the invocation (and the prompt, so a
// test can prove the rewrite feedback reached the model), and emits the real JSON envelope shape.
writeFileSync(
  CLAUDE_STUB,
  `#!/usr/bin/env bash
set -euo pipefail
prompt="$(cat)"
printf '%s\\n---\\n' "$prompt" >> "${CONTROL}/prompts"
printf 'x\\n' >> "${CONTROL}/authorings"
printf '{"result":"A drum and bass producer with a long run behind them.","total_cost_usd":0.01,"usage":{"input_tokens":10,"output_tokens":20},"modelUsage":{}}'
`,
  { mode: 0o755 },
);

// A stub \`fluncle\`: answers \`draft-bio\` with a grounded draft, and \`describe\` according to the
// verdict file — so a test can say "the gate refuses every draft" and watch what the sweep does.
// It records whether each describe carried \`--final-attempt\`.
writeFileSync(
  FLUNCLE_STUB,
  `#!/usr/bin/env bash
set -euo pipefail
verb="\${3:-}"
if [ "$verb" = "draft-bio" ]; then
  printf '{"found":true,"hasFacts":true,"findingCount":2,"name":"Future Signal","prompt":"AUTHOR THE BIO","promptVersion":0}'
  exit 0
fi
final=0
for arg in "$@"; do
  if [ "$arg" = "--final-attempt" ]; then final=1; fi
done
printf '%s\\n' "$final" >> "${CONTROL}/describes"
verdict="$(cat "${CONTROL}/verdict" 2>/dev/null || printf 'pass')"
if [ "$verdict" = "structural" ]; then
  # What the FINAL-ATTEMPT acceptance still refuses: a draft outside the length bounds.
  printf 'error: The bio is too long (612 > 500 chars) [bio_too_long 422]\\n' >&2
  exit 1
fi
if [ "$verdict" = "reject" ] && [ "$final" = "0" ]; then
  printf 'error: The bio fails the voice gate: banned identity word "signal" (VOICE.md 3) [voice_gate 422]\\n' >&2
  exit 1
fi
if [ "$final" = "1" ] && [ "$verdict" = "reject" ]; then
  printf '{"ok":true,"slug":"future-signal","bio":"stored","gateBypassed":true,"voiceViolations":["banned identity word \\\\"signal\\\\""]}'
  exit 0
fi
printf '{"ok":true,"slug":"future-signal","bio":"stored"}'
`,
  { mode: 0o755 },
);

chmodSync(CLAUDE_STUB, 0o755);
chmodSync(FLUNCLE_STUB, 0o755);

process.env["CLAUDE_BIN"] = CLAUDE_STUB;
process.env["FLUNCLE_BIN"] = FLUNCLE_STUB;
process.env["ENTITY_BIO_STATE_DIR"] = STATE_DIR;

const {
  attemptKey,
  attemptLedgerPath,
  bioCostEvent,
  buildRewriteBlock,
  clearAttempts,
  describeOne,
  formatAttemptLedger,
  isAuthorableDraft,
  MAX_BIO_ATTEMPTS,
  parseAttemptLedger,
  planAttempt,
  readBioRejection,
  recordAttempt,
  remainingQueueDepth,
  selectBioWork,
} = await import("./entity-bio-sweep");

afterAll(() => {
  rmSync(RIG, { force: true, recursive: true });
});

const DRAFT = {
  findingCount: 3,
  found: true,
  hasFacts: true,
  name: "Calibre",
  prompt: "You are Fluncle, writing the bio for Calibre…",
  promptVersion: 0,
};

describe("isAuthorableDraft (the Worker-draft gate)", () => {
  test("authors on a resolved draft with a non-empty prompt", () => {
    expect(isAuthorableDraft(DRAFT)).toBe(true);
  });

  test("SKIPS on a null draft (the draft-bio call / gather failed)", () => {
    expect(isAuthorableDraft(null)).toBe(false);
  });

  test("SKIPS on found:false (the Worker did not resolve the slug)", () => {
    expect(isAuthorableDraft({ ...DRAFT, found: false })).toBe(false);
  });

  test("SKIPS on an empty prompt (nothing to author)", () => {
    expect(isAuthorableDraft({ ...DRAFT, prompt: "   " })).toBe(false);
    expect(isAuthorableDraft({ ...DRAFT, prompt: undefined })).toBe(false);
  });

  // The grounding rail (#643): a findings-free CATALOGUE entity Firecrawl knows nothing
  // about arrives with a non-empty prompt (the template always renders) but NOTHING to
  // ground on — refuse it, or the bio would be confabulated (VOICE.md).
  test("SKIPS on a groundless draft (no Firecrawl facts AND no finding titles)", () => {
    expect(isAuthorableDraft({ ...DRAFT, findingCount: 0, hasFacts: false })).toBe(false);
    // …even though the Worker still handed us a resolved, non-empty prompt.
    expect(isAuthorableDraft({ ...DRAFT, findingCount: undefined, hasFacts: undefined })).toBe(
      false,
    );
  });

  test("authors on Firecrawl facts alone (hasFacts:true, no findings)", () => {
    expect(isAuthorableDraft({ ...DRAFT, findingCount: 0, hasFacts: true })).toBe(true);
  });

  test("authors on finding titles alone (findingCount>0, no Firecrawl facts)", () => {
    expect(isAuthorableDraft({ ...DRAFT, findingCount: 2, hasFacts: false })).toBe(true);
  });
});

const AUTHORED = {
  bio: "Calibre is a drum and bass producer.",
  model: "claude-sonnet-4-6",
  promptVersion: 0,
  tokens: 1500,
  usd: 0.042,
};

describe("bioCostEvent (the COST-01 §5 `bio` row)", () => {
  test("records a subsidized/anthropic/tokens row ONLY on a real authored+stored bio", () => {
    const row = bioCostEvent({
      authored: AUTHORED,
      dryRun: false,
      outcome: "authored",
      slug: "calibre",
    });

    expect(row).toEqual({
      costBasis: "subsidized",
      logId: "calibre",
      model: "claude-sonnet-4-6",
      occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as unknown as string,
      quantity: 1500,
      source: "measured",
      step: "bio",
      trackId: null,
      unitType: "tokens",
      usd: 0.042,
      vendor: "anthropic",
    });
  });

  test("scopes the idempotency id by the entity SLUG (a bio has no finding coordinate)", () => {
    const row = bioCostEvent({
      authored: AUTHORED,
      dryRun: false,
      outcome: "authored",
      slug: "shogun-audio",
    });

    if (!row) {
      throw new Error("expected an authored bio to record a cost row");
    }

    expect(costEventId(row)).toBe(`bio:shogun-audio:anthropic:tokens:${row.occurredAt}`);
  });

  test("carries a null usd through unpriced (never laundered to $0)", () => {
    const row = bioCostEvent({
      authored: { ...AUTHORED, usd: null },
      dryRun: false,
      outcome: "authored",
      slug: "calibre",
    });

    expect(row?.usd).toBeNull();
  });

  test("records NOTHING on a dry run (nothing was stored)", () => {
    expect(
      bioCostEvent({ authored: AUTHORED, dryRun: true, outcome: "authored", slug: "calibre" }),
    ).toBeNull();
  });

  test("records NOTHING on an operator-bio no-op, a gate rejection, an exhaustion, or a failure", () => {
    for (const outcome of ["alreadyBio", "exhausted", "gateSkipped", "skipped"] as const) {
      expect(
        bioCostEvent({ authored: AUTHORED, dryRun: false, outcome, slug: "calibre" }),
      ).toBeNull();
    }
  });

  test("records NOTHING when there is no authored bio", () => {
    expect(
      bioCostEvent({ authored: null, dryRun: false, outcome: "authored", slug: "calibre" }),
    ).toBeNull();
  });
});

// ── THE ATTEMPT BUDGET ─────────────────────────────────────────────────────────────────
//
// The bug this replaced: a voice-gate rejection was a plain skip that left the entity queued,
// with nothing anywhere counting the attempts — so "retry" meant "forever". Three entities were
// re-authored ~90 times each over two days, ~270 model calls, and it would never have stopped.
//
// The ruling: an entity gets THREE authoring attempts, ever — the initial draft plus two
// rewrites — and the third draft LANDS rather than being discarded. The count persists across
// ticks, because each tick is a fresh process with nothing in memory.

describe("the attempt ledger (the count that survives a tick)", () => {
  test("round-trips through the on-disk TSV, so a fresh process reads what the last one spent", () => {
    const ledger = new Map();

    recordAttempt(ledger, "artist", "future-signal", 1700000000);
    recordAttempt(ledger, "artist", "future-signal", 1700000060);
    recordAttempt(ledger, "label", "invaderz-transmissions", 1700000120);

    const reloaded = parseAttemptLedger(formatAttemptLedger(ledger));

    expect(reloaded.get(attemptKey("artist", "future-signal"))?.attempts).toBe(2);
    expect(reloaded.get(attemptKey("label", "invaderz-transmissions"))?.attempts).toBe(1);
  });

  test("a corrupt or truncated ledger degrades to NO memory, never to a throw", () => {
    const ledger = parseAttemptLedger("\nnot-a-row\nartist:x\tNaN\t0\nartist:y\t2\t123\n\t\t\n");

    expect([...ledger.keys()]).toEqual(["artist:y"]);
    expect(parseAttemptLedger("")).toEqual(new Map());
  });

  test("kind-qualifies the key, so an artist and a label sharing a slug keep separate budgets", () => {
    const ledger = new Map();

    recordAttempt(ledger, "artist", "shogun", 1);

    expect(planAttempt(ledger, "artist", "shogun").spent).toBe(1);
    expect(planAttempt(ledger, "label", "shogun").spent).toBe(0);
  });

  test("plans attempts 1..3, marks the LAST one final, and calls the 4th exhausted", () => {
    const ledger = new Map();

    expect(planAttempt(ledger, "artist", "x")).toMatchObject({
      attempt: 1,
      exhausted: false,
      final: false,
    });

    recordAttempt(ledger, "artist", "x", 1);
    expect(planAttempt(ledger, "artist", "x")).toMatchObject({ attempt: 2, final: false });

    recordAttempt(ledger, "artist", "x", 2);
    expect(planAttempt(ledger, "artist", "x")).toMatchObject({
      attempt: MAX_BIO_ATTEMPTS,
      exhausted: false,
      final: true,
    });

    recordAttempt(ledger, "artist", "x", 3);
    expect(planAttempt(ledger, "artist", "x").exhausted).toBe(true);
  });

  test("a landed bio CLEARS the budget, so a re-queued entity starts fresh", () => {
    const ledger = new Map();

    recordAttempt(ledger, "artist", "x", 1);
    clearAttempts(ledger, "artist", "x");

    expect(planAttempt(ledger, "artist", "x")).toMatchObject({ attempt: 1, exhausted: false });
  });
});

describe("selectBioWork (an exhausted entity must not block the queue)", () => {
  const QUEUE = [{ slug: "spent" }, { slug: "fresh" }, { slug: "also-fresh" }];

  test("drops exhausted rows BEFORE the cap, so the head of the batch is the next WORKABLE row", () => {
    const ledger = new Map();

    for (let i = 0; i < MAX_BIO_ATTEMPTS; i += 1) {
      recordAttempt(ledger, "artist", "spent", i);
    }

    const { exhausted, work } = selectBioWork(QUEUE, ledger, "artist", 1);

    expect(exhausted.map((row) => row.slug)).toEqual(["spent"]);
    // Without this a cap-1 sweep would spend every tick refusing the same head forever —
    // trading an infinite retry loop for a permanent stall, which is worse.
    expect(work.map((row) => row.slug)).toEqual(["fresh"]);
  });

  test("passes an untouched queue straight through, capped", () => {
    const { exhausted, work } = selectBioWork(QUEUE, new Map(), "artist", 2);

    expect(exhausted).toEqual([]);
    expect(work.map((row) => row.slug)).toEqual(["spent", "fresh"]);
  });
});

describe("readBioRejection + buildRewriteBlock (why a rewrite is aimed, not blind)", () => {
  test("reads the voice-gate reason out of a raw CLI error", () => {
    expect(
      readBioRejection('error: The bio fails the voice gate: banned identity word "signal" (§3)'),
    ).toBe('banned identity word "signal" (§3)');
  });

  test("reads it out of a JSON-escaped one too, tail and all", () => {
    expect(
      readBioRejection(
        '{"code":"voice_gate","message":"The bio fails the voice gate: banned identity word \\"signal\\" (§3)"}',
      ),
    ).toBe('banned identity word "signal" (§3)');
  });

  test("reads a length rejection", () => {
    expect(readBioRejection("error: The bio is too long (612 > 500 chars)")).toBe(
      "The bio is too long (612 > 500 chars)",
    );
  });

  test("returns nothing when there is no recognisable reason", () => {
    expect(readBioRejection("connection reset")).toBeUndefined();
  });

  test("the FIRST attempt gets no rewrite block — it is not a rewrite", () => {
    expect(buildRewriteBlock("anything", 1)).toBe("");
  });

  test("a rewrite is handed the exact reason to fix", () => {
    const block = buildRewriteBlock('banned identity word "signal"', 2);

    expect(block).toContain("YOUR LAST DRAFT WAS REJECTED");
    expect(block).toContain('banned identity word "signal"');
  });

  test("a rewrite with no recoverable reason still says it was refused", () => {
    expect(buildRewriteBlock(undefined, 3)).toContain("refused by the voice gate");
  });
});

describe("remainingQueueDepth", () => {
  test("subtracts finished AND exhausted rows — an exhausted row is no longer work", () => {
    expect(remainingQueueDepth(10, { alreadyBio: 1, authored: 2, exhausted: 3 })).toBe(4);
  });

  test("never goes negative", () => {
    expect(remainingQueueDepth(1, { alreadyBio: 1, authored: 2, exhausted: 3 })).toBe(0);
  });
});

// ── THE REAL LOOP, END TO END ──────────────────────────────────────────────────────────
//
// `describeOne` driven against the stub `fluncle` + `claude` binaries, with the ledger on disk.
// Each `tick()` is a separate call that reads the ledger back off disk first — which is what a
// real cron tick is: a fresh process that remembers nothing except what was written down.

function verdict(value: "pass" | "reject" | "structural"): void {
  writeFileSync(join(CONTROL, "verdict"), value, "utf8");
}

function readLines(file: string): string[] {
  try {
    return readFileSync(join(CONTROL, file), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** How many times the model was actually called. */
function authorings(): number {
  return readLines("authorings").length;
}

/** Every describe the stub saw, as "did it carry --final-attempt". */
function describes(): boolean[] {
  return readLines("describes").map((line) => line === "1");
}

function prompts(): string[] {
  try {
    return readFileSync(join(CONTROL, "prompts"), "utf8").split("\n---\n").filter(Boolean);
  } catch {
    return [];
  }
}

function loadLedger() {
  try {
    return parseAttemptLedger(readFileSync(attemptLedgerPath(), "utf8"));
  } catch {
    return new Map();
  }
}

/** One cron tick over one entity: reload the ledger off disk, run the REAL loop, persist. */
async function tick(slug: string) {
  return describeOne("artist", { slug }, { ledger: loadLedger(), ledgerPath: attemptLedgerPath() });
}

describe("describeOne (the bounded re-author, across ticks)", () => {
  beforeEach(() => {
    rmSync(CONTROL, { force: true, recursive: true });
    rmSync(STATE_DIR, { force: true, recursive: true });
    mkdirSync(CONTROL, { recursive: true });
  });

  test("a gate-PASSING entity is authored exactly once and leaves no budget behind", async () => {
    verdict("pass");

    const result = await tick("future-signal");

    // Unchanged from before this slice: one author, one describe, no --final-attempt, no marker.
    expect(result.outcome).toBe("authored");
    expect(result.gateBypassed).toBe(false);
    expect(authorings()).toBe(1);
    expect(describes()).toEqual([false]);
    expect(loadLedger().size).toBe(0);
  });

  test("a gate-REFUSING entity is authored at most three times, and the THIRD draft is stored", async () => {
    verdict("reject");

    const result = await tick("future-signal");

    expect(authorings()).toBe(MAX_BIO_ATTEMPTS);
    // The third describe is the one that carried --final-attempt, and it landed.
    expect(describes()).toEqual([false, false, true]);
    expect(result.outcome).toBe("authored");
    // …and the acceptance is reported, never silent.
    expect(result.gateBypassed).toBe(true);
  });

  test("the rewrites are TOLD what the gate refused (a blind retry never converges)", async () => {
    verdict("reject");
    await tick("future-signal");

    const [first, second, third] = prompts();

    expect(first).not.toContain("YOUR LAST DRAFT WAS REJECTED");
    expect(second).toContain('banned identity word "signal"');
    expect(third).toContain("YOUR LAST DRAFT WAS REJECTED");
  });

  test("a FOURTH authoring never happens on a later tick", async () => {
    // The one way an entity survives its whole budget still bio-less: even the final draft is
    // refused on a STRUCTURAL ground the acceptance keeps enforcing (here, too long). It stays
    // queued, so the cron keeps meeting it — and must never author for it again.
    verdict("structural");

    expect((await tick("future-signal")).outcome).toBe("exhausted");
    expect(authorings()).toBe(MAX_BIO_ATTEMPTS);

    for (let i = 0; i < 5; i += 1) {
      expect((await tick("future-signal")).outcome).toBe("exhausted");
    }

    // Five more ticks, zero more model calls. This is the whole point of the slice.
    expect(authorings()).toBe(MAX_BIO_ATTEMPTS);
  });

  test("an exhausted entity costs NOTHING — no draft fetch, no model call", async () => {
    verdict("structural");
    await tick("future-signal");

    const describesAfterBudget = describes().length;

    await tick("future-signal");

    expect(authorings()).toBe(MAX_BIO_ATTEMPTS);
    expect(describes().length).toBe(describesAfterBudget);
  });

  test("the budget survives a tick that died mid-author — it is burned BEFORE the model call", async () => {
    verdict("reject");

    // One attempt, persisted, then the "process" ended without finishing the entity.
    const ledger = new Map();

    recordAttempt(ledger, "artist", "future-signal", 1);
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(attemptLedgerPath(), `${formatAttemptLedger(ledger)}\n`, "utf8");

    // The next tick resumes with what is LEFT (2); it does not refund three fresh calls.
    await tick("future-signal");

    expect(authorings()).toBe(MAX_BIO_ATTEMPTS - 1);
  });

  test("a DRY RUN spends no budget — the operator pre-flight is not an attempt", async () => {
    verdict("pass");

    const result = await describeOne("artist", { slug: "future-signal" }, { dryRun: true });

    expect(result.outcome).toBe("authored");
    expect(authorings()).toBe(1);
    // No ledger was passed, so nothing was counted and nothing was written.
    expect(() => readFileSync(attemptLedgerPath(), "utf8")).toThrow();
  });
});
