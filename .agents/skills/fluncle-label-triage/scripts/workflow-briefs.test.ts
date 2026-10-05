import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SKILL_PATH = ".agents/skills/fluncle-label-triage/SKILL.md";

type Verdict = Record<string, unknown>;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

async function runWorkflow(
  script: string,
  research: Verdict[],
  extra: Record<string, unknown> = {},
): Promise<{ briefs: string[]; peak: number }> {
  const source = readFileSync(join(import.meta.dir, script), "utf8").replace(
    "export const meta",
    "const meta",
  );
  const briefs: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const agent = async (prompt: string, options: { phase?: string }) => {
    briefs.push(prompt);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;

    return { verdicts: options.phase === "Research" ? research : [] };
  };
  const parallel = (thunks: Array<() => Promise<unknown>>) =>
    Promise.all(thunks.map((thunk) => thunk()));
  const noop = () => undefined;
  const dir = mkdtempSync(join(tmpdir(), "label-triage-briefs-"));
  dirs.push(dir);
  const module = join(dir, `${script}.mjs`);
  writeFileSync(
    module,
    `export default async function run(args, agent, parallel, phase, log) {\n${source}\n}`,
  );
  const { default: run } = (await import(module)) as {
    default: (...values: unknown[]) => Promise<unknown>;
  };
  const args = {
    batch: 2,
    disabled: "/d.txt",
    enabled: "/e.txt",
    file: "/u.json",
    rules: "/r.txt",
    total: 3,
    ...extra,
  };

  await run(JSON.stringify(args), agent, parallel, noop, noop);

  return { briefs, peak };
}

async function renderBriefs(script: string, research: Verdict[]): Promise<string[]> {
  return (await runWorkflow(script, research)).briefs;
}

const mixed: Verdict = {
  confidence: "medium",
  evidence: "two-sided",
  name: "Mixed",
  needsCensus: true,
  slug: "mixed",
  verdict: "dnb",
};

describe("worker briefs", () => {
  test("every research and census brief names the skill by path and hands out the evidence command", async () => {
    const briefs = await renderBriefs("triage-workflow.js", [mixed]);

    expect(briefs.length).toBe(3);
    for (const brief of briefs) {
      expect(brief).toContain(SKILL_PATH);
      expect(brief).toContain("fluncle admin labels evidence <mb_label_id>");
      expect(brief).toContain("Do not write fetchers.");
      expect(brief).toContain("A call that times out is a queue, not evidence");
      expect(brief).not.toContain("ws/2/release?label=");
    }
    expect(briefs.at(-1)).toContain("--census --json");
  });

  test("every verify brief names the skill by path and hands out the evidence command", async () => {
    const briefs = await renderBriefs("verify-workflow.js", []);

    expect(briefs.length).toBe(2);
    for (const brief of briefs) {
      expect(brief).toContain(SKILL_PATH);
      expect(brief).toContain("fluncle admin labels evidence <mb_label_id> --census --json");
      expect(brief).toContain("A call that times out is a queue, not evidence");
      expect(brief).not.toContain("ws/2/release?label=");
    }
  });

  test.each(["triage-workflow.js", "verify-workflow.js"])(
    "%s never runs more workers at once than its concurrency cap",
    async (script) => {
      const { briefs, peak } = await runWorkflow(script, [], { batch: 1, concurrency: 2, total: 7 });

      expect(briefs.length).toBe(7);
      expect(peak).toBe(2);
    },
  );
});
