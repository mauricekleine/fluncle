import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costEventId } from "./cost-emit";
import { countDistressLines } from "./fluncle-healthcheck";

const RIG = mkdtempSync(join(tmpdir(), "entity-bio-sweep-test-"));
const STATE_DIR = join(RIG, "state");
const CONTROL = join(RIG, "control");
const FLUNCLE_STUB = join(RIG, "fluncle");
const CLAUDE_STUB = join(RIG, "claude");

const PROCESS_FIXTURE_TIMEOUT_MS = 15_000;

mkdirSync(CONTROL, { recursive: true });

writeFileSync(
  CLAUDE_STUB,
  `#!/usr/bin/env bash
set -euo pipefail
prompt="$(cat)"
if [ -n "\${PHASE_TIMELINE:-}" ]; then printf 'external\\n' >> "$PHASE_TIMELINE"; fi
printf '%s\\n---\\n' "$prompt" >> "${CONTROL}/prompts"
printf 'x\\n' >> "${CONTROL}/authorings"
if [ "$(cat "${CONTROL}/claude-verdict" 2>/dev/null || printf 'up')" = "down" ]; then
  printf 'API Error: 529 overloaded_error\\n' >&2
  exit 1
fi
printf '{"result":"A drum and bass producer with a long run behind them.","total_cost_usd":0.01,"usage":{"input_tokens":10,"output_tokens":20},"modelUsage":{}}'
`,
  { mode: 0o755 },
);

writeFileSync(
  FLUNCLE_STUB,
  `#!/usr/bin/env bash
set -euo pipefail
verb="\${3:-}"
if [[ " $* " = *" --queue "* ]]; then
  printf '[{"id":"artist-1","name":"Future Signal","slug":"future-signal"}]'
  exit 0
fi
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
  bioSweepOk,
  buildBioFatalSummary,
  buildRewriteBlock,
  clearAttempts,
  createBioSweepSummary,
  describeOne,
  exhaustedRecapLine,
  formatAttemptLedger,
  isAuthorableDraft,
  MAX_BIO_ATTEMPTS,
  parseAttemptLedger,
  planAttempt,
  readBioRejection,
  recordBioOutcome,
  recordAttempt,
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

  test("SKIPS on a groundless draft (no Firecrawl facts AND no finding titles)", () => {
    expect(isAuthorableDraft({ ...DRAFT, findingCount: 0, hasFacts: false })).toBe(false);

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

    expect(work.map((row) => row.slug)).toEqual(["fresh"]);
  });

  test("passes an untouched queue straight through, capped", () => {
    const { exhausted, work } = selectBioWork(QUEUE, new Map(), "artist", 2);

    expect(exhausted).toEqual([]);
    expect(work.map((row) => row.slug)).toEqual(["spent", "fresh"]);
  });
});

describe("shared bio sweep canonical counters", () => {
  test.each(["artist", "label", "album"] as const)(
    "%s gets checked/produced/errors and deliberately omits capped queue depth",
    (kind) => {
      const summary = createBioSweepSummary(kind);

      recordBioOutcome(summary, "authored");
      recordBioOutcome(summary, "alreadyBio");
      recordBioOutcome(summary, "gateSkipped");
      recordBioOutcome(summary, "skipped");

      expect(summary).toMatchObject({
        authored: 1,
        checked: 4,
        errors: 0,
        failed: 1,
        kind,
        produced: 1,
      });

      expect(summary).not.toHaveProperty("queue_depth");
    },
  );

  test("exhausted page rows are not checked until they are actually passed to describeOne", () => {
    const summary = createBioSweepSummary("artist");

    summary.exhausted = 3;
    recordBioOutcome(summary, "authored", true);

    expect(summary.checked).toBe(1);
    expect(summary.produced).toBe(1);
    expect(summary.bypassedGate).toBe(1);
  });

  test("a measured no-work tick preserves checked: 0, never null", () => {
    const summary = createBioSweepSummary("label");

    expect(summary.checked).toBe(0);
    expect(summary.checked).not.toBeNull();
    expect(summary.produced).toBe(0);
    expect(summary.errors).toBe(0);
  });

  test("a dry-run author counts as checked/authored but never as produced", () => {
    const summary = createBioSweepSummary("album");

    recordBioOutcome(summary, "authored", false, false);

    expect(summary.checked).toBe(1);
    expect(summary.authored).toBe(1);
    expect(summary.produced).toBe(0);
  });

  test("a tick that recorded an error reports ok:false", () => {
    const summary = createBioSweepSummary("artist");

    summary.errors += 1;

    expect(bioSweepOk(summary)).toBe(false);
  });

  test("a clean tick still reports ok:true", () => {
    expect(bioSweepOk(createBioSweepSummary("artist"))).toBe(true);
  });

  test("a fatal run reports errors without guessing work counters", () => {
    expect(buildBioFatalSummary()).toMatchObject({
      checked: null,
      errors: 1,
      failed: null,
      produced: null,
    });
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

  test("…and is told to hold the register, so it cannot dodge the word by going flat", () => {
    expect(buildRewriteBlock("anything", 2)).toContain("Keep the dossier register");
  });

  test("a rewrite with no recoverable reason still says it was refused", () => {
    expect(buildRewriteBlock(undefined, 3)).toContain("refused by the voice gate");
  });
});

function verdict(value: "pass" | "reject" | "structural"): void {
  writeFileSync(join(CONTROL, "verdict"), value, "utf8");
}

function claudeVerdict(value: "up" | "down"): void {
  writeFileSync(join(CONTROL, "claude-verdict"), value, "utf8");
}

async function tickWithStrain(slug: string): Promise<{ lines: string[]; strain: number }> {
  const lines: string[] = [];
  const original = console.error;

  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };

  try {
    await tick(slug);
  } finally {
    console.error = original;
  }

  return { lines, strain: countDistressLines(lines.join("\n"), 1) };
}

function readLines(file: string): string[] {
  try {
    return readFileSync(join(CONTROL, file), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function authorings(): number {
  return readLines("authorings").length;
}

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

async function tick(slug: string) {
  return describeOne("artist", { slug }, { ledger: loadLedger(), ledgerPath: attemptLedgerPath() });
}

describe("describeOne (the bounded re-author, across ticks)", () => {
  beforeEach(() => {
    rmSync(CONTROL, { force: true, recursive: true });
    rmSync(STATE_DIR, { force: true, recursive: true });
    mkdirSync(CONTROL, { recursive: true });
  });

  test(
    "a gate-PASSING entity is authored exactly once and leaves no budget behind",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    async () => {
      verdict("pass");

      const result = await tick("future-signal");

      expect(result.outcome).toBe("authored");
      expect(result.gateBypassed).toBe(false);
      expect(authorings()).toBe(1);
      expect(describes()).toEqual([false]);
      expect(loadLedger().size).toBe(0);
    },
  );

  test(
    "a gate-REFUSING entity is authored at most three times, and the THIRD draft is stored",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    async () => {
      verdict("reject");

      const result = await tick("future-signal");

      expect(authorings()).toBe(MAX_BIO_ATTEMPTS);

      expect(describes()).toEqual([false, false, true]);
      expect(result.outcome).toBe("authored");

      expect(result.gateBypassed).toBe(true);
    },
  );

  test(
    "the rewrites are TOLD what the gate refused (a blind retry never converges)",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    async () => {
      verdict("reject");
      await tick("future-signal");

      const [first, second, third] = prompts();

      expect(first).not.toContain("YOUR LAST DRAFT WAS REJECTED");
      expect(second).toContain('banned identity word "signal"');
      expect(third).toContain("YOUR LAST DRAFT WAS REJECTED");
    },
  );

  test(
    "a FOURTH authoring never happens on a later tick",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    async () => {
      verdict("structural");

      expect((await tick("future-signal")).outcome).toBe("exhausted");
      expect(authorings()).toBe(MAX_BIO_ATTEMPTS);

      for (let i = 0; i < 5; i += 1) {
        expect((await tick("future-signal")).outcome).toBe("exhausted");
      }

      expect(authorings()).toBe(MAX_BIO_ATTEMPTS);
    },
  );

  test(
    "an exhausted entity costs NOTHING — no draft fetch, no model call",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    async () => {
      verdict("structural");
      await tick("future-signal");

      const describesAfterBudget = describes().length;

      await tick("future-signal");

      expect(authorings()).toBe(MAX_BIO_ATTEMPTS);
      expect(describes().length).toBe(describesAfterBudget);
    },
  );

  test(
    "a partly-spent budget resumes where it left off across ticks",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    async () => {
      verdict("reject");

      const ledger = new Map();

      recordAttempt(ledger, "artist", "future-signal", 1);
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(attemptLedgerPath(), `${formatAttemptLedger(ledger)}\n`, "utf8");

      await tick("future-signal");

      expect(authorings()).toBe(MAX_BIO_ATTEMPTS - 1);
    },
  );
});

describe("the transport/model failure never spends an attempt", () => {
  beforeEach(() => {
    rmSync(CONTROL, { force: true, recursive: true });
    rmSync(STATE_DIR, { force: true, recursive: true });
    mkdirSync(CONTROL, { recursive: true });
    claudeVerdict("up");
  });

  test(
    "a failing `claude -p` leaves the budget untouched, however many ticks it fails for",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    async () => {
      verdict("pass");
      claudeVerdict("down");

      for (let i = 0; i < 4; i += 1) {
        expect((await tick("future-signal")).outcome).toBe("skipped");
      }

      expect(authorings()).toBe(4);
      expect(loadLedger().size).toBe(0);
    },
  );

  test(
    "…so the entity still gets its FULL budget once the model comes back",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    async () => {
      verdict("reject");
      claudeVerdict("down");
      await tick("future-signal");
      await tick("future-signal");

      const wasted = authorings();

      claudeVerdict("up");

      const result = await tick("future-signal");

      expect(authorings() - wasted).toBe(MAX_BIO_ATTEMPTS);
      expect(describes()).toEqual([false, false, true]);
      expect(result.outcome).toBe("authored");
      expect(result.gateBypassed).toBe(true);
    },
  );

  test(
    "a model failure on the LAST attempt does not exhaust the entity",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    async () => {
      verdict("reject");

      claudeVerdict("up");
      const ledger = new Map();

      recordAttempt(ledger, "artist", "future-signal", 1);
      recordAttempt(ledger, "artist", "future-signal", 2);
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(attemptLedgerPath(), `${formatAttemptLedger(ledger)}\n`, "utf8");

      claudeVerdict("down");
      expect((await tick("future-signal")).outcome).toBe("skipped");
      expect(loadLedger().get(attemptKey("artist", "future-signal"))?.attempts).toBe(2);

      claudeVerdict("up");
      const result = await tick("future-signal");

      expect(result.outcome).toBe("authored");
      expect(result.gateBypassed).toBe(true);
    },
  );
});

describe("what the sweep's logs say to the /status strain detector", () => {
  beforeEach(() => {
    rmSync(CONTROL, { force: true, recursive: true });
    rmSync(STATE_DIR, { force: true, recursive: true });
    mkdirSync(CONTROL, { recursive: true });
    claudeVerdict("up");
  });

  test(
    "a clean authoring tick reads as ZERO strain",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    async () => {
      verdict("pass");

      expect((await tickWithStrain("future-signal")).strain).toBe(0);
    },
  );

  test(
    "rewriting and then LANDING reads as ZERO strain — it is a healthy tick",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    async () => {
      verdict("reject");

      const { lines, strain } = await tickWithStrain("future-signal");

      expect(lines.join("\n")).toContain("FINAL-ATTEMPT ACCEPTANCE");
      expect(strain).toBe(0);
    },
  );

  test(
    "EXHAUSTING an entity DOES read as strain — it is a permanent write-off",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    async () => {
      verdict("structural");

      expect((await tickWithStrain("future-signal")).strain).toBeGreaterThan(0);
    },
  );

  test(
    "a transport/model failure DOES read as strain — nothing else is watching it now",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    async () => {
      verdict("pass");
      claudeVerdict("down");

      expect((await tickWithStrain("future-signal")).strain).toBeGreaterThan(0);
    },
  );

  test("the per-tick exhausted RECAP is silent — it would otherwise nag forever", () => {
    const recap = exhaustedRecapLine("artist", [{ slug: "future-signal" }, { slug: "other" }]);

    expect(recap).toContain("2 exhausted artist(s)");
    expect(countDistressLines(recap)).toBe(0);
  });

  test(
    "a DRY RUN spends no budget — the operator pre-flight is not an attempt",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    async () => {
      verdict("pass");

      const result = await describeOne("artist", { slug: "future-signal" }, { dryRun: true });

      expect(result.outcome).toBe("authored");
      expect(authorings()).toBe(1);

      expect(() => readFileSync(attemptLedgerPath(), "utf8")).toThrow();
    },
  );
});

describe("the phased orchestrator under a due-work deferral", () => {
  test("a deferred bio queue is a paused tick that authors nothing", () => {
    const pendingRig = mkdtempSync(join(tmpdir(), "entity-bio-pending-"));
    const runner = join(pendingRig, "phase-runner");
    const fluncle = join(pendingRig, "fluncle");
    writeFileSync(
      runner,
      `#!/usr/bin/env bash
set -euo pipefail
shift 2
if [ "\${1:-}" = "--" ]; then shift; fi
"$@"
`,
      { mode: 0o755 },
    );
    writeFileSync(
      fluncle,
      `#!/usr/bin/env bash
if [[ " $* " = *" --queue "* ]]; then
  printf '{"code":"due_work_maintenance_pending","message":"Due-work maintenance is still converging","ok":false}\\n'
  exit 1
fi
printf 'unexpected fluncle call: %s\\n' "$*" >&2
exit 2
`,
      { mode: 0o755 },
    );

    try {
      const result = spawnSync(
        process.execPath,
        [join(import.meta.dir, "entity-bio-sweep.ts"), "--kind", "label"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            DATABASE_ADMISSION_RUNNER: runner,
            ENTITY_BIO_STATE_DIR: join(pendingRig, "state"),
            FLUNCLE_API_TOKEN: "",
            FLUNCLE_BIN: fluncle,
          },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        checked: 0,
        errors: 0,
        gateState: "paused",
        kind: "label",
        ok: true,
        partial: false,
        produced: 0,
        reason: "due_work_repair_pending",
        throttled: true,
      });
    } finally {
      rmSync(pendingRig, { force: true, recursive: true });
    }
  });
});

describe("the recurring phased orchestrator", () => {
  beforeEach(() => {
    rmSync(CONTROL, { force: true, recursive: true });
    rmSync(STATE_DIR, { force: true, recursive: true });
    mkdirSync(CONTROL, { recursive: true });
    claudeVerdict("up");
    verdict("pass");
  });

  test(
    "batches queue and draft reads before authoring, then batches delivery",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    () => {
      const timeline = join(CONTROL, "phase-timeline");
      const runner = join(RIG, "phase-runner");
      writeFileSync(
        runner,
        `#!/usr/bin/env bash
set -euo pipefail
shift 2
if [ "\${1:-}" = "--" ]; then shift; fi
case " $* " in
  *" --admission-phase read "*) label=read ;;
  *" --admission-phase write "*) label=writes ;;
  *) exit 2 ;;
esac
printf 'acquire\\n%s\\n' "$label" >> "$PHASE_TIMELINE"
"$@"
status="$?"
printf 'release\\n' >> "$PHASE_TIMELINE"
exit "$status"
`,
        { mode: 0o755 },
      );
      const sweep = join(import.meta.dir, "entity-bio-sweep.ts");
      const result = spawnSync(process.execPath, [sweep, "--kind", "artist"], {
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_ADMISSION_RUNNER: runner,
          ENTITY_BIO_STATE_DIR: STATE_DIR,
          FLUNCLE_API_TOKEN: "",
          PHASE_TIMELINE: timeline,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(timeline, "utf8").trim().split("\n")).toEqual([
        "acquire",
        "read",
        "release",
        "external",
        "acquire",
        "writes",
        "release",
      ]);
      expect(JSON.parse(result.stdout)).toMatchObject({
        authored: 1,
        checked: 1,
        kind: "artist",
        ok: true,
        produced: 1,
      });
    },
  );
});
