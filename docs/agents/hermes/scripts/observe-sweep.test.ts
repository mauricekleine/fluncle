// Unit tests for the pure helpers in observe-sweep.ts — the authoring PROMPT (where the
// vibe-neighbour layer + the closer-variation rails live) and the echo-move reader that
// drives the re-author pass. The box scripts are self-contained (they cannot import the
// workspace) and live outside any package's test runner, so this file uses `bun:test`:
//
//   bun test docs/agents/hermes/scripts/observe-sweep.test.ts
//
// The layer's RISK is that the neighbours get templated instead of informing, so the
// prompt's anti-sameness instruction is load-bearing product behaviour, not prose — it is
// asserted here, and enforced for real by the Worker's echo gate (its own tests in
// apps/web/src/lib/server/observation-echo.test.ts). The registry-default lockstep is
// pinned separately by prompt-drift.test.ts.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAttemptLedger, selectWork } from "./attempt-ledger";

// ── THE STUB RIG ───────────────────────────────────────────────────────────────────────
//
// On disk and pointed at by env BEFORE the sweep module is evaluated: FLUNCLE_BIN / CLAUDE_BIN /
// OBSERVE_STATE_DIR are read at module load, which is why the sweep is imported dynamically below.

const RIG = mkdtempSync(join(tmpdir(), "observe-sweep-test-"));
const STATE_DIR = join(RIG, "state");
const CONTROL = join(RIG, "control");
const FLUNCLE_STUB = join(RIG, "fluncle");
const CLAUDE_STUB = join(RIG, "claude");

mkdirSync(CONTROL, { recursive: true });

writeFileSync(
  CLAUDE_STUB,
  `#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
printf 'x\\n' >> "${CONTROL}/authorings"
if [ "$(cat "${CONTROL}/claude-verdict" 2>/dev/null || printf 'up')" = "down" ]; then
  printf 'API Error: 529 overloaded_error\\n' >&2
  exit 1
fi
printf '{"result":"Future Signal built this one out of patience, fam.","total_cost_usd":0.01,"usage":{"input_tokens":10,"output_tokens":20},"modelUsage":{}}'
`,
  { mode: 0o755 },
);

// `stores` records only the deliveries the Worker ACCEPTED — i.e. the reads that were actually
// rendered. It must stay EMPTY for a finding whose drafts the gate refused.
writeFileSync(
  FLUNCLE_STUB,
  `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "admin" ] && [ "\${2:-}" = "tracks" ] && [ "\${3:-}" = "observe" ] && [ "\${4:-}" = "--queue" ]; then
  if [ "$(cat "${CONTROL}/queue-mode" 2>/dev/null || printf 'empty')" = "work" ]; then
    printf '{"ok":true,"tracks":[{"trackId":"t-1"}]}'
  else
    printf '{"ok":true,"tracks":[]}'
  fi
  exit 0
fi
if [ "\${1:-}" = "tracks" ] && [ "\${2:-}" = "get" ]; then
  printf '{"track":{"artists":["Future Signal"],"title":"Fractals","logId":"011.5.9D","trackId":"t-1"}}'
  exit 0
fi
if [ "\${1:-}" = "admin" ] && [ "\${3:-}" = "context" ]; then
  printf '{"contextNote":"A 2016 single."}'
  exit 0
fi
verdict="$(cat "${CONTROL}/verdict" 2>/dev/null || printf 'pass')"
if [ "$verdict" = "infra403" ]; then
  printf 'error: request failed with 403 forbidden\\n' >&2
  exit 1
fi
if [ "$verdict" = "voice" ]; then
  printf 'error: The observation script fails the voice gate: banned identity word "signal" [voice_gate 422]\\n' >&2
  exit 1
fi
if [ "$verdict" = "echo" ]; then
  printf 'error: observation_echoes_neighbours: it lifts "out of patience fam" straight from 012.1.0A [422]\\n' >&2
  exit 1
fi
printf '%s\\n' "\${4:-?}" >> "${CONTROL}/stores"
printf '{"ok":true,"logId":"011.5.9D"}'
`,
  { mode: 0o755 },
);

chmodSync(CLAUDE_STUB, 0o755);
chmodSync(FLUNCLE_STUB, 0o755);

process.env["CLAUDE_BIN"] = CLAUDE_STUB;
process.env["FLUNCLE_BIN"] = FLUNCLE_STUB;
process.env["OBSERVE_STATE_DIR"] = STATE_DIR;
// No agent token, so the prompt fetch AND the neighbourhood read both fall back without a network.
delete process.env["FLUNCLE_API_TOKEN"];

const {
  buildAuthoringPrompt,
  MAX_OBSERVE_ATTEMPTS,
  observeKey,
  observeOne,
  readEchoedMove,
}: typeof import("./observe-sweep") = await import("./observe-sweep");

type Neighbor = import("./observe-sweep").Neighbor;

afterAll(() => {
  rmSync(RIG, { force: true, recursive: true });
});

const FINDING = {
  artists: ["Calibre"],
  galaxy: { name: "The Drift" },
  label: "Signature",
  releaseDate: "2008-03-01",
  title: "Mr Right On",
};

const CONTEXT = "Signature Recordings, 2008.\nTexture: half-step, patient.";

const NEIGHBORS: Neighbor[] = [
  { logId: "012.2.4L", script: "My shoulders went before I'd clocked the coordinate." },
  { logId: "012.1.0A", script: "The pads hang like weather over a patient half-step." },
];

describe("buildAuthoringPrompt", () => {
  test("carries the context note as the primary fuel", () => {
    const prompt = buildAuthoringPrompt(FINDING, CONTEXT);

    expect(prompt).toContain("CONTEXT NOTE");
    expect(prompt).toContain("Texture: half-step, patient.");
  });

  test("lays out the sonic neighbourhood with each neighbour's standing script", () => {
    const prompt = buildAuthoringPrompt(FINDING, CONTEXT, NEIGHBORS);

    expect(prompt).toContain("THE SONIC NEIGHBOURHOOD");
    expect(prompt).toContain(`012.2.4L: "My shoulders went before I'd clocked the coordinate."`);
    expect(prompt).toContain(`012.1.0A: "The pads hang like weather over a patient half-step."`);
    // The load-bearing half: the neighbourhood is a list of what is TAKEN, not a template.
    expect(prompt).toContain("ALREADY TAKEN");
    expect(prompt).toContain("SPENT");
  });

  test("no neighbourhood block when the region is empty (the pre-layer prompt)", () => {
    const prompt = buildAuthoringPrompt(FINDING, CONTEXT, []);

    expect(prompt).not.toContain("THE SONIC NEIGHBOURHOOD");
  });

  test("breaks the closer formula: the worn sign-off is named, the kin names rotate", () => {
    const prompt = buildAuthoringPrompt(FINDING, CONTEXT);

    // The audit's 32/61 verbatim closer, named as worn through — with variation, not deletion:
    // the crew turn stays required, the kin vocabulary rotates, no-sign-off is allowed.
    expect(prompt).toContain("enjoy, cosmonauts");
    expect(prompt).toContain("worn through");
    expect(prompt).toContain("junglist, raver, fam, cosmonaut");
    expect(prompt).toContain("no sign-off");
    // The "hope" crutch (51/61) and the opener register (34/61 on "I…") are both addressed.
    expect(prompt).toContain('Drop "hope" as a reflex');
    expect(prompt).toContain("VARY THE OPENER");
  });

  test("the re-author pass hands the model its own spent move", () => {
    const prompt = buildAuthoringPrompt(FINDING, CONTEXT, NEIGHBORS, "my shoulders went before");

    expect(prompt).toContain("YOUR LAST ATTEMPT WAS REJECTED");
    expect(prompt).toContain('"my shoulders went before"');
  });
});

describe("readEchoedMove", () => {
  test("pulls the lifted phrase out of the Worker's human-readable error", () => {
    expect(
      readEchoedMove(
        'The observation echoes its sonic neighbourhood: it lifts "my shoulders went before" straight from 012.2.4L.',
      ),
    ).toBe("my shoulders went before");
  });

  test("tolerates the JSON-escaped quoting the --json envelope emits", () => {
    expect(
      readEchoedMove(
        '{"message":"it lifts \\"the drop landed sideways\\" straight from 012.1.0A"}',
      ),
    ).toBe("the drop landed sideways");
  });

  test("returns undefined for an overlap-only rejection (no lifted phrase to name)", () => {
    expect(readEchoedMove("it reuses 42% of 012.1.0A's words")).toBeUndefined();
  });
});

describe("run-ledger summary counters", () => {
  test("the real tick counts one attempted finding and one rendered output", () => {
    rmSync(CONTROL, { force: true, recursive: true });
    rmSync(STATE_DIR, { force: true, recursive: true });
    mkdirSync(CONTROL, { recursive: true });
    writeFileSync(join(CONTROL, "queue-mode"), "work", "utf8");
    verdict("pass");
    claudeVerdict("up");

    const result = spawnSync(process.execPath, [join(import.meta.dir, "observe-sweep.ts")], {
      encoding: "utf8",
      env: { ...process.env, FLUNCLE_API_TOKEN: "" },
    });
    const summary = JSON.parse(result.stdout.trim()) as Record<string, unknown>;

    expect(result.status).toBe(0);
    expect(summary).toMatchObject({
      checked: 1,
      errors: 0,
      failed: 0,
      produced: 1,
      queueRemaining: 0,
      rendered: 1,
    });
    // `observe --queue --limit 50` returns only a capped page. `queueRemaining` is retained as
    // domain evidence, but the sweep cannot cheaply know the total outstanding backlog.
    expect("queueDepth" in summary).toBe(false);
    expect("queue_depth" in summary).toBe(false);
    expect("expectedIntervalMs" in summary).toBe(false);
    expect("expected_interval_ms" in summary).toBe(false);
  });
});

// ── THE ATTEMPT BUDGET, END TO END ─────────────────────────────────────────────────────
//
// `observeOne` driven against the stub binaries, with the ledger on disk. Each `tick()` is a
// separate call that reads the ledger back off disk — what a real cron tick is.
//
// The bug: a voice-gate rejection left the finding queued with nothing counting the tries, so
// "retry" meant "forever", and the rejection could be UNSATISFIABLE because the scan read the
// finding's own artist name. THE NAME EXEMPTION fixes that case; this bounds every other one.

function verdict(value: "pass" | "voice" | "echo" | "infra403"): void {
  writeFileSync(join(CONTROL, "verdict"), value, "utf8");
}

function claudeVerdict(value: "up" | "down"): void {
  writeFileSync(join(CONTROL, "claude-verdict"), value, "utf8");
}

function readLines(file: string): string[] {
  try {
    return readFileSync(join(CONTROL, file), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

const authorings = () => readLines("authorings").length;
/** The reads that were actually RENDERED — must stay empty for a refused finding. */
const stores = () => readLines("stores");
const ledgerPath = () => join(STATE_DIR, "attempts");

async function tick(id: string) {
  const ledger = readAttemptLedger(ledgerPath());

  return observeOne({ trackId: id }, { ledger, ledgerPath: ledgerPath() });
}

describe("observeOne (the bounded re-author, across ticks)", () => {
  beforeEach(() => {
    rmSync(CONTROL, { force: true, recursive: true });
    rmSync(STATE_DIR, { force: true, recursive: true });
    mkdirSync(CONTROL, { recursive: true });
    claudeVerdict("up");
  });

  test("a gate-PASSING finding is authored once and leaves no budget behind", async () => {
    verdict("pass");

    expect((await tick("t-1")).outcome).toBe("rendered");
    expect(authorings()).toBe(1);
    expect(readAttemptLedger(ledgerPath()).size).toBe(0);
  });

  test("a gate-REFUSING finding is authored for at most three passes, then never again", async () => {
    verdict("voice");

    for (let i = 1; i < MAX_OBSERVE_ATTEMPTS; i += 1) {
      expect((await tick("t-1")).outcome).toBe("gateSkipped");
    }

    expect((await tick("t-1")).outcome).toBe("exhausted");
    expect(authorings()).toBe(MAX_OBSERVE_ATTEMPTS);

    for (let i = 0; i < 5; i += 1) {
      expect((await tick("t-1")).outcome).toBe("exhausted");
    }

    expect(authorings()).toBe(MAX_OBSERVE_ATTEMPTS);
  });

  // THE OPERATOR'S RULING (2026-07-30): no final-attempt bypass. An observation is optional
  // editorial, and rendering gate-failed copy would also spend Cartesia credits to publish it.
  test("NOTHING is ever rendered for a finding whose drafts the gate refused", async () => {
    verdict("voice");

    for (let i = 0; i < MAX_OBSERVE_ATTEMPTS + 3; i += 1) {
      await tick("t-1");
    }

    expect(stores()).toEqual([]);
  });

  test("an ECHO refusal spends the budget too", async () => {
    verdict("echo");

    expect((await tick("t-1")).outcome).toBe("echoSkipped");
    expect(readAttemptLedger(ledgerPath()).get("t-1")?.attempts).toBe(1);
  });

  // An expired agent token returns 403 on every delivery. It must leave the finding queued (it
  // does) WITHOUT charging the budget — the Worker never read these drafts.
  test("an infra 403 leaves the finding queued and spends NOTHING", async () => {
    verdict("infra403");

    for (let i = 0; i < 6; i += 1) {
      expect((await tick("t-1")).outcome).toBe("gateSkipped");
    }

    expect(readAttemptLedger(ledgerPath()).size).toBe(0);

    verdict("pass");
    expect((await tick("t-1")).outcome).toBe("rendered");
  });

  test("a transport/model failure never spends an attempt", async () => {
    verdict("pass");
    claudeVerdict("down");

    for (let i = 0; i < 4; i += 1) {
      expect((await tick("t-1")).outcome).toBe("skipped");
    }

    expect(readAttemptLedger(ledgerPath()).size).toBe(0);

    claudeVerdict("up");
    expect((await tick("t-1")).outcome).toBe("rendered");
  });

  test("an exhausted finding does not block the cap-1 queue behind it", async () => {
    verdict("voice");

    for (let i = 0; i < MAX_OBSERVE_ATTEMPTS; i += 1) {
      await tick("t-dead");
    }

    const ledger = readAttemptLedger(ledgerPath());
    const queue = [{ trackId: "t-dead" }, { trackId: "t-live" }];
    const { exhausted, work } = selectWork(queue, ledger, observeKey, 1, MAX_OBSERVE_ATTEMPTS);

    expect(exhausted.map((row) => row.trackId)).toEqual(["t-dead"]);
    expect(work.map((row) => row.trackId)).toEqual(["t-live"]);

    verdict("pass");
    const result = await observeOne(work[0] ?? {}, { ledger, ledgerPath: ledgerPath() });

    expect(result.outcome).toBe("rendered");
  });
});
