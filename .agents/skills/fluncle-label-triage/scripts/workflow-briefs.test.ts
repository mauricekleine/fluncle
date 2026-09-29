import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SKILL_PATH = ".agents/skills/fluncle-label-triage/SKILL.md";

type Verdict = Record<string, unknown>;

async function renderBriefs(script: string, research: Verdict[]): Promise<string[]> {
  const source = readFileSync(join(import.meta.dir, script), "utf8").replace(
    "export const meta",
    "const meta",
  );
  const briefs: string[] = [];
  const agent = async (prompt: string, options: { phase?: string }) => {
    briefs.push(prompt);

    return { verdicts: options.phase === "Research" ? research : [] };
  };
  const parallel = (thunks: Array<() => Promise<unknown>>) =>
    Promise.all(thunks.map((thunk) => thunk()));
  const noop = () => undefined;
  const module = join(mkdtempSync(join(tmpdir(), "label-triage-briefs-")), `${script}.mjs`);
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
  };

  await run(JSON.stringify(args), agent, parallel, noop, noop);

  return briefs;
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
      expect(brief).not.toContain("ws/2/release?label=");
    }
  });
});
