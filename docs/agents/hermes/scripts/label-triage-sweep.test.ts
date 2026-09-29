import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildResearchPrompt,
  claudeArgs,
  decide,
  parseResearchReply,
  planBatches,
  postDiscordAlert,
  RESEARCH_DEFAULTS,
  type ResearchedLabel,
  researchConfig,
  researchEnv,
  type CarryStore,
  fileCarryStore,
  type RoundDeps,
  runSweep,
  summarize,
  type TriageLabel,
  type TriagePayload,
} from "./label-triage-sweep";

const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function label(slug: string, checkedDaysAgo?: number, verdict = "unclear"): TriageLabel {
  return {
    mbLabelId: `mbid-${slug}`,
    name: slug,
    seedState: "undecided",
    slug,
    triageCheckedAt:
      checkedDaysAgo === undefined ? null : new Date(NOW - checkedDaysAgo * DAY).toISOString(),
    triageVerdict: checkedDaysAgo === undefined ? null : verdict,
  };
}

function neverLooked(count: number): TriageLabel[] {
  return Array.from({ length: count }, (_, index) => label(`new-${index}`));
}

describe("the gate decision", () => {
  test("holds below the threshold", () => {
    const verdict = decide(neverLooked(39), { now: NOW, threshold: 40 });

    expect(verdict.fire).toBe(false);
    expect(verdict.neverLooked).toBe(39);
    expect(verdict.reason).toContain("below the threshold");
  });

  test("fires at exactly the threshold", () => {
    expect(decide(neverLooked(40), { now: NOW, threshold: 40 }).fire).toBe(true);
  });

  test("counts ONLY never-looked labels toward the threshold", () => {
    const pile = [
      ...neverLooked(5),
      ...Array.from({ length: 100 }, (_, i) => label(`old-${i}`, 1)),
    ];
    const verdict = decide(pile, { now: NOW, threshold: 40 });

    expect(verdict.undecided).toBe(105);
    expect(verdict.fire).toBe(false);
  });

  test("a pile of only recently-looked labels never fires by itself", () => {
    const verdict = decide(
      Array.from({ length: 500 }, (_, i) => label(`stuck-${i}`, 2)),
      { now: NOW, threshold: 40 },
    );

    expect(verdict.fire).toBe(false);
    expect(verdict.candidates).toEqual([]);
  });

  test("a label past the staleness window rides along once a round fires", () => {
    const pile = [...neverLooked(40), label("stale", 31), label("fresh", 2)];
    const verdict = decide(pile, { now: NOW, staleDays: 30, threshold: 40 });

    expect(verdict.fire).toBe(true);
    expect(verdict.stale).toBe(1);
    expect(verdict.candidates.map((row) => row.slug)).toContain("stale");
    expect(verdict.candidates.map((row) => row.slug)).not.toContain("fresh");
  });

  test("the staleness boundary is inclusive, so a label cannot sit one hour short forever", () => {
    const pile = [label("exactly", 30)];

    expect(decide(pile, { now: NOW, staleDays: 30, threshold: 1 }).stale).toBe(1);
    expect(decide(pile, { now: NOW, staleDays: 31, threshold: 1 }).stale).toBe(0);
  });

  test("orders candidates never-looked first, then stalest", () => {
    const pile = [label("recent", 40), label("ancient", 200), label("fresh-eyes")];
    const verdict = decide(pile, { now: NOW, staleDays: 30, threshold: 1 });

    expect(verdict.candidates.map((row) => row.slug)).toEqual(["fresh-eyes", "ancient", "recent"]);
  });

  test("treats an unparseable cursor as never-looked rather than skipping the label", () => {
    const pile: TriageLabel[] = [{ ...label("broken"), triageCheckedAt: "not-a-date" }];
    const verdict = decide(pile, { now: NOW, threshold: 1 });

    expect(verdict.candidates.map((row) => row.slug)).toEqual(["broken"]);
  });

  test("an empty pile holds and names no candidates", () => {
    const verdict = decide([], { now: NOW, threshold: 40 });

    expect(verdict.fire).toBe(false);
    expect(verdict.undecided).toBe(0);
    expect(verdict.candidates).toEqual([]);
  });
});

describe("the run summary", () => {
  test("leads with the verdict and carries every count the operator reads", () => {
    const line = summarize(decide([...neverLooked(41), label("stale", 40)], { now: NOW }));

    expect(line).toStartWith("LABEL TRIAGE GATE: FIRE");
    expect(line).toContain("undecided=42");
    expect(line).toContain("never-looked=41");
    expect(line).toContain("stale=1");
    expect(line).toContain("candidates=42");
  });

  test("says HOLD when it held, so a quiet run is not mistaken for a broken one", () => {
    expect(summarize(decide(neverLooked(1), { now: NOW }))).toStartWith("LABEL TRIAGE GATE: HOLD");
  });
});

describe("what the gate counts", () => {
  test("a label with no MusicBrainz identity never counts toward the threshold or the worklist", () => {
    const pile = [...neverLooked(3), { ...label("no-mbid"), mbLabelId: null }];
    const verdict = decide(pile, { now: NOW, threshold: 4 });

    expect(verdict.fire).toBe(false);
    expect(verdict.excluded).toBe(1);
    expect(verdict.candidates.map((row) => row.slug)).not.toContain("no-mbid");
  });

  test("a label already carrying artist rules is a settled partial and stays out of the round", () => {
    const pile = [...neverLooked(3), { ...label("seeded"), carriesArtistRules: true }];
    const verdict = decide(pile, { now: NOW, threshold: 1 });

    expect(verdict.excluded).toBe(1);
    expect(verdict.candidates.map((row) => row.slug)).not.toContain("seeded");
  });
});

describe("the round's cost bounds", () => {
  test("never researches more than the label cap or the batch cap", () => {
    const config = {
      ...researchConfig({}),
      batchSize: 4,
      maxBatches: 2,
      maxLabels: 30,
    };

    expect(planBatches(neverLooked(50), config).map((batch) => batch.length)).toEqual([4, 4]);
    expect(planBatches(neverLooked(5), { ...config, maxLabels: 3 }).flat()).toHaveLength(3);
  });

  test("reads its knobs from the unit's env and falls back on nonsense", () => {
    const config = researchConfig({
      LABEL_TRIAGE_BATCH_SIZE: "5",
      LABEL_TRIAGE_MAX_BATCHES: "zero",
      LABEL_TRIAGE_MAX_LABELS: "-3",
    });

    expect(config.batchSize).toBe(5);
    expect(config.maxBatches).toBe(RESEARCH_DEFAULTS.maxBatches);
    expect(config.maxLabels).toBe(RESEARCH_DEFAULTS.maxLabels);
  });
});

describe("the research process", () => {
  test("holds no Fluncle token, no webhook and no database credential", () => {
    const env = researchEnv(
      {
        CLAUDE_CODE_OAUTH_TOKEN: "claude",
        DISCOGS_USER_TOKEN: "discogs",
        DISCORD_ALERT_WEBHOOK: "hook",
        FLUNCLE_API_TOKEN: "agent-token",
        HOME: "/opt/data/home",
        PATH: "/usr/bin",
        TURSO_AUTH_TOKEN: "turso",
      },
      "/tmp/batch",
    );

    expect(env).toMatchObject({
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "claude",
      DISCOGS_USER_TOKEN: "discogs",
      PATH: "/usr/bin",
    });
    expect(env).not.toHaveProperty("FLUNCLE_API_TOKEN");
    expect(env).not.toHaveProperty("DISCORD_ALERT_WEBHOOK");
    expect(env).not.toHaveProperty("TURSO_AUTH_TOKEN");
  });

  test("gets its own HOME, so the sweep secrets file is not under its home directory", () => {
    const env = researchEnv({ HOME: "/opt/data/home" }, "/tmp/batch");

    expect(env.HOME).toBe("/tmp/batch");
    expect(env.XDG_CACHE_HOME).toBe("/opt/data/home/.cache");
  });

  test("may run the evidence command, and reads only its working directory and the skill", () => {
    const args = claudeArgs(researchConfig({}));
    const allowed = args[args.indexOf("--allowedTools") + 1];

    expect(allowed).toBe("Bash(fluncle admin labels evidence:*)");
    expect(args).toContain("--restricted");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--add-dir") + 1]).toBe("/opt/claude/skills/fluncle-label-triage");
    expect(args).toContain("--max-turns");
  });

  test("the brief names the skill, the evidence command and every label's exact MBID", () => {
    const prompt = buildResearchPrompt([label("hospital")], researchConfig({}));

    expect(prompt).toContain(RESEARCH_DEFAULTS.skillPath);
    expect(prompt).toContain("fluncle admin labels evidence <mb_label_id> --json");
    expect(prompt).toContain("--census --json");
    expect(prompt).toContain("Do not write fetchers");
    expect(prompt).toContain("`mbid-hospital`");
  });

  test("reads the structured verdicts and drops malformed rows", () => {
    const reply = parseResearchReply(
      JSON.stringify({
        structured_output: {
          verdicts: [
            {
              confidence: "high",
              evidence: "Apple: Jungle/Drum'n'bass",
              slug: "a",
              verdict: "dnb",
            },
            { confidence: "certain", evidence: "x", slug: "b", verdict: "dnb" },
          ],
        },
        total_cost_usd: 1.5,
        usage: { cache_read_input_tokens: 900, input_tokens: 10, output_tokens: 90 },
      }),
    );

    expect(reply.ok).toBe(true);
    expect(reply.ok && reply.labels.map((row) => row.slug)).toEqual(["a"]);
    expect(reply.spend).toEqual({ tokens: 1000, usd: 1.5 });
  });

  test("an auth error reply is named as one, so the round stops spending", () => {
    const reply = parseResearchReply(
      JSON.stringify({ is_error: true, result: "OAuth token has expired", subtype: "error" }),
    );

    expect(reply.ok).toBe(false);
    expect(!reply.ok && reply.reason).toBe("claude_auth");
  });
});

type Harness = {
  alerts: string[];
  carry: CarryStore & { slugs: string[] };
  deps: RoundDeps;
  lines: string[];
  recorded: Array<{ payload: TriagePayload; slug: string }>;
  researched: string[][];
};

function harness(
  research: (slugs: string[], index: number) => ResearchedLabel[] | Error | "auth",
): Harness {
  const alerts: string[] = [];
  const recorded: Harness["recorded"] = [];
  const researched: string[][] = [];

  const carry = {
    read: () => carry.slugs,
    slugs: [] as string[],
    write: (slugs: string[]) => {
      carry.slugs = slugs;
    },
  };

  return {
    alerts,
    carry,
    deps: {
      alert: async (text) => {
        alerts.push(text);

        return true;
      },
      calibration: async () => ({ disabled: ["Atlantic"], enabled: ["Hospital"], globalRules: [] }),
      record: async (slug, payload) => {
        recorded.push({ payload, slug });
      },
      research: async (batch, { index }) => {
        const slugs = batch.map((row) => row.slug);
        researched.push(slugs);
        const outcome = research(slugs, index);

        if (outcome === "auth") {
          return {
            detail: "OAuth token has expired",
            ok: false,
            reason: "claude_auth",
            spend: { tokens: 0, usd: null },
          };
        }
        if (outcome instanceof Error) {
          throw outcome;
        }

        return { labels: outcome, ok: true, spend: { tokens: 1000, usd: 0.5 } };
      },
    },
    lines: [],
    recorded,
    researched,
  };
}

const FIRE_ENV = {
  LABEL_TRIAGE_BATCH_SIZE: "2",
  LABEL_TRIAGE_CONCURRENCY: "1",
  LABEL_TRIAGE_MAX_BATCHES: "2",
  LABEL_TRIAGE_THRESHOLD: "3",
};

function sweep(h: Harness, pile = neverLooked(4), env: Record<string, string> = FIRE_ENV) {
  return runSweep(env, pile, h.deps, {
    carry: h.carry,
    now: new Date(NOW),
    print: (line) => h.lines.push(line),
    roundId: "box-test",
  });
}

function finalSummary(h: Harness): Record<string, unknown> {
  return JSON.parse(h.lines.at(-1) ?? "{}") as Record<string, unknown>;
}

const verdictFor = (slug: string, overrides: Partial<ResearchedLabel> = {}): ResearchedLabel => ({
  confidence: "high",
  evidence: `evidence for ${slug}`,
  slug,
  verdict: "not_dnb",
  ...overrides,
});

describe("a round that fired", () => {
  test("a round that recorded zero proposals exits non-zero, reads failed on /status and alerts Discord", async () => {
    const posts: Array<{ body: string; url: string }> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      posts.push({ body: typeof init?.body === "string" ? init.body : "", url });

      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const h = harness(() => []);
    h.deps.alert = (text) => postDiscordAlert(text, "https://discord.test/hook", fakeFetch);

    const exitCode = await sweep(h);
    const summary = finalSummary(h);

    expect(exitCode).toBe(1);
    expect(summary).toMatchObject({
      alerted: true,
      ok: false,
      produced: 0,
      reason: "zero_proposals",
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe("https://discord.test/hook");
    expect(JSON.parse(posts[0]?.body ?? "{}").content).toContain("recorded 0/4 proposals");
  });

  test("records every verdict under one round id and stays healthy", async () => {
    const h = harness((slugs) => slugs.map((slug) => verdictFor(slug)));

    expect(await sweep(h)).toBe(0);
    expect(h.recorded.map((row) => row.slug)).toEqual(["new-0", "new-1", "new-2", "new-3"]);
    expect(new Set(h.recorded.map((row) => row.payload.roundId))).toEqual(new Set(["box-test"]));
    expect(finalSummary(h)).toMatchObject({ batches: 2, ok: true, produced: 4, tokens: 2000 });
    expect(h.alerts).toEqual([]);
  });

  test("one failed batch fails the run and alerts, while the other batch's proposals still land", async () => {
    const h = harness((slugs, index) =>
      index === 1 ? new Error("claude -p exited 1") : slugs.map((slug) => verdictFor(slug)),
    );

    expect(await sweep(h)).toBe(1);
    expect(h.recorded).toHaveLength(2);
    expect(finalSummary(h)).toMatchObject({ batchesFailed: 1, ok: false, reason: "batch_failed" });
    expect(h.alerts[0]).toContain("1/2 batches failed");
  });

  test("a batch that leaves a label without a verdict counts as failed", async () => {
    const h = harness((slugs) => slugs.slice(0, 1).map((slug) => verdictFor(slug)));

    expect(await sweep(h)).toBe(1);
    expect(finalSummary(h)).toMatchObject({ missed: 2, ok: false });
  });

  test("a Claude auth failure stops the round before it spends another batch", async () => {
    const h = harness(() => "auth");

    expect(await sweep(h)).toBe(1);
    expect(h.researched).toHaveLength(1);
    expect(finalSummary(h)).toMatchObject({ ok: false, reason: "claude_auth" });
  });

  test("an unreadable calibration fails the run before any model call", async () => {
    const h = harness(() => []);
    h.deps.calibration = async () => {
      throw new Error("403");
    };

    expect(await sweep(h)).toBe(1);
    expect(h.researched).toEqual([]);
    expect(finalSummary(h)).toMatchObject({ ok: false, reason: "calibration_unreadable" });
  });

  test("a verdict for a label outside the batch is never recorded", async () => {
    const h = harness((slugs) => [
      ...slugs.map((slug) => verdictFor(slug)),
      verdictFor("stranger"),
    ]);

    await sweep(h);

    expect(h.recorded.map((row) => row.slug)).not.toContain("stranger");
  });

  test("the recorded payload drops inert rules and keeps a reason only on unclear", async () => {
    const h = harness((slugs) =>
      slugs.map((slug) =>
        verdictFor(slug, {
          reason: "mixed",
          rules: [
            {
              artistMbid: "a",
              artistName: "A",
              evidence: "",
              firstCreditCount: 4,
              verdict: "block",
            },
            {
              artistMbid: "b",
              artistName: "B",
              evidence: "",
              firstCreditCount: 0,
              verdict: "block",
            },
          ],
          verdict: "dnb",
        }),
      ),
    );

    await sweep(h);
    const payload = h.recorded[0]?.payload;

    expect(payload?.rules?.map((rule) => rule.artistMbid)).toEqual(["a"]);
    expect(payload).not.toHaveProperty("reason");
  });
});

describe("a round that held", () => {
  test("ends on a healthy JSON summary so /status reads the hold as a run", async () => {
    const h = harness(() => []);

    expect(await sweep(h, neverLooked(2))).toBe(0);
    expect(h.lines[0]).toStartWith("LABEL TRIAGE GATE: HOLD");
    expect(finalSummary(h)).toMatchObject({ gate: "hold", ok: true });
    expect(h.researched).toEqual([]);
  });
});

describe("the host unit", () => {
  const unit = readFileSync(
    join(import.meta.dir, "..", "label-triage-timer", "fluncle-label-triage.service"),
    "utf8",
  );
  const knob = (name: string) => new RegExp(`^Environment=${name}=(\\d+)$`, "m").exec(unit)?.[1];

  test("passes every cost knob it sets into the container", () => {
    for (const name of unit.matchAll(/^Environment=(LABEL_TRIAGE_[A-Z_]+)=/gm)) {
      expect(unit).toContain(`-e ${name[1]} `);
    }
  });

  test("gives a fired round time for every batch wave before systemd kills it", () => {
    const config = researchConfig({
      LABEL_TRIAGE_BATCH_TIMEOUT_SECS: knob("LABEL_TRIAGE_BATCH_TIMEOUT_SECS"),
      LABEL_TRIAGE_CONCURRENCY: knob("LABEL_TRIAGE_CONCURRENCY"),
      LABEL_TRIAGE_MAX_BATCHES: knob("LABEL_TRIAGE_MAX_BATCHES"),
    });
    const waves = Math.ceil(config.maxBatches / config.concurrency);
    const timeout = Number(/^TimeoutStartSec=(\d+)$/m.exec(unit)?.[1]);

    expect(timeout).toBeGreaterThan(waves * config.batchTimeoutSecs + 300);
  });

  test("states the same defaults the sweep falls back on", () => {
    expect(Number(knob("LABEL_TRIAGE_MAX_LABELS"))).toBe(RESEARCH_DEFAULTS.maxLabels);
    expect(Number(knob("LABEL_TRIAGE_BATCH_SIZE"))).toBe(RESEARCH_DEFAULTS.batchSize);
    expect(Number(knob("LABEL_TRIAGE_MAX_BATCHES"))).toBe(RESEARCH_DEFAULTS.maxBatches);
    expect(Number(knob("LABEL_TRIAGE_CONCURRENCY"))).toBe(RESEARCH_DEFAULTS.concurrency);
  });
});

describe("unfinished work", () => {
  test("labels a failed batch left behind fire the next run even below the threshold", async () => {
    const h = harness((slugs, index) =>
      index === 1 ? new Error("claude -p exited 1") : slugs.map((slug) => verdictFor(slug)),
    );
    await sweep(h);

    expect(h.carry.slugs).toEqual(["new-2", "new-3"]);

    const stamped = ["new-0", "new-1"].map((slug) => label(slug, 0, "not_dnb"));
    const next = harness((slugs) => slugs.map((slug) => verdictFor(slug)));
    next.carry.slugs = h.carry.slugs;
    const exitCode = await sweep(next, [...stamped, label("new-2"), label("new-3")]);

    expect(exitCode).toBe(0);
    expect(next.researched.flat()).toEqual(["new-2", "new-3"]);
    expect(next.carry.slugs).toEqual([]);
  });

  test("never-looked labels past the round's cap are carried rather than left for the threshold", async () => {
    const h = harness((slugs) => slugs.map((slug) => verdictFor(slug)));

    await sweep(h, neverLooked(6));

    expect(h.recorded).toHaveLength(4);
    expect(h.carry.slugs).toEqual(["new-4", "new-5"]);
  });

  test("a carried label triaged elsewhere drops out, and the hold prunes it so it cannot fire later", async () => {
    const h = harness(() => []);
    h.carry.slugs = ["looked-elsewhere"];

    expect(await sweep(h, [...neverLooked(1), label("looked-elsewhere", 1)])).toBe(0);
    expect(finalSummary(h)).toMatchObject({ carried: 0, gate: "hold" });
    expect(h.carry.slugs).toEqual([]);
  });

  test("an unreadable carry-over fails the run loudly instead of holding", async () => {
    const h = harness(() => []);
    h.carry.read = () => {
      throw new SyntaxError("Unexpected end of JSON input");
    };

    expect(await sweep(h, neverLooked(1))).toBe(1);
    expect(finalSummary(h)).toMatchObject({ ok: false, reason: "carry_unreadable" });
    expect(h.alerts).toHaveLength(1);
  });

  test("a carry-over that cannot be saved fails the run loudly", async () => {
    const h = harness((slugs) => slugs.map((slug) => verdictFor(slug)));
    h.carry.write = () => {
      throw new Error("read-only file system");
    };

    expect(await sweep(h, neverLooked(6))).toBe(1);
    expect(finalSummary(h)).toMatchObject({
      carryWritten: false,
      ok: false,
      reason: "carry_unwritten",
    });
    expect(h.alerts).toHaveLength(1);
  });
});

describe("the carry-over file", () => {
  const dir = mkdtempSync(join(tmpdir(), "label-triage-carry-"));
  const path = join(dir, "carry.json");

  test("a missing file means nothing is carried", () => {
    expect(fileCarryStore(join(dir, "absent.json")).read()).toEqual([]);
  });

  test("round-trips the slugs it saved", () => {
    fileCarryStore(path).write(["a", "b"]);

    expect(fileCarryStore(path).read()).toEqual(["a", "b"]);
  });

  test("a truncated file is an error, never an empty carry-over", () => {
    writeFileSync(path, '{"slugs":["a"');

    expect(() => fileCarryStore(path).read()).toThrow();
    rmSync(dir, { force: true, recursive: true });
  });
});
