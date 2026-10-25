import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SKILL_PATH = ".agents/skills/fluncle-label-triage/references/worker-rulings.md";

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
): Promise<{ briefs: string[]; peaks: Record<string, number> }> {
  const source = readFileSync(join(import.meta.dir, script), "utf8").replace(
    "export const meta",
    "const meta",
  );
  const briefs: string[] = [];
  let inFlight = 0;
  const peaks: Record<string, number> = {};
  const agent = async (prompt: string, options: { phase?: string }) => {
    const index = briefs.push(prompt);
    inFlight += 1;
    const phase = options.phase ?? "Verify";
    peaks[phase] = Math.max(peaks[phase] ?? 0, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;

    return { verdicts: options.phase === "Research" && index === 1 ? research : [] };
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
    roundDir: "/state/label-triage/round-42",
    rules: "/r.txt",
    total: 3,
    ...extra,
  };

  await run(JSON.stringify(args), agent, parallel, noop, noop);

  return { briefs, peaks };
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
  for (const script of ["triage-workflow.js", "verify-workflow.js"]) {
    test(`${script} supplies one batch command, a durable manifest and a short rulings reference`, async () => {
      const briefs = await renderBriefs(script, [mixed]);
      expect(briefs).toHaveLength(script === "triage-workflow.js" ? 3 : 2);
      for (const brief of briefs) {
        expect(brief).toContain(SKILL_PATH);
        expect(brief).toContain("once with the file-read tool");
        expect(brief).not.toContain("fluncle-label-triage/SKILL.md");
        expect(brief).toContain("fluncle admin labels evidence <mb_label_id> [<mb_label_id> ...]");
        expect(brief).toContain("--out '/state/label-triage/round-42/");
        expect(brief).toContain("--manifest '/state/label-triage/round-42/manifest.jsonl'");
        expect(brief).toContain("Read the printed text summaries first");
        expect(brief).toContain("blocking completion tool");
        expect(brief).toContain("Do not write fetchers.");
        expect(brief).toContain("A collection failure is not an `unclear` genre ruling.");
        expect(brief).toContain("sources.<name>");
        expect(brief).toContain("ok|partial|error|no_link|not_configured|skipped");
        expect(brief).toContain("Nullable:");
        for (const field of [
          "sources.musicbrainz.data.releases.releases[]",
          "sources.discogs.data.releases.sample[]",
          "sources.discogs.data.releases.topArtists[]",
          "sources.discogs.data.styles.styles[]",
          "sources.beatport.data.genres[]",
          "sources.apple.data.releases[]",
          "year:number|null",
          "primaryGenreName?:string",
        ]) {
          expect(brief).toContain(field);
        }
        expect(brief).toContain("Supplemental lookups also run in the foreground");
        expect(brief).toContain("one artist per Bash call");
        expect(brief).toContain("If no blocking completion tool is available");
        expect(brief).toContain("return the missing lookup to the coordinator");
        expect(brief).not.toContain("--json");
        expect(brief).not.toContain("ws/2/release?label=");
      }
      expect(briefs.at(-1)).toContain("--census");
      if (script === "triage-workflow.js") {
        expect(briefs.at(-1)).toContain("curl --fail --max-time 30");
        expect(briefs.at(-1)).toContain("parses only a successful response");
        expect(briefs.at(-1)).toContain("Optional upstream `media`/`tracks` arrays may be absent");
      }
    });
  }

  for (const script of ["triage-workflow.js", "verify-workflow.js"]) {
    test(`${script} requires a durable roundDir`, async () => {
      await expect(runWorkflow(script, [], { roundDir: undefined })).rejects.toThrow(
        "roundDir must name a durable round directory outside session scratch",
      );
    });

    test(`${script} scales each slice deadline below the Bash tool timeout`, async () => {
      const research = Array.from({ length: 6 }, (_, index) => ({
        ...mixed,
        slug: `mixed-${index}`,
      }));
      const { briefs } = await runWorkflow(script, research, {
        batch: 10,
        censusBatch: 5,
        total: 12,
      });
      expect(briefs.map((brief) => Number(/--timeout (\d+)/.exec(brief)?.[1]))).toEqual(
        script === "triage-workflow.js" ? [540, 480, 540, 240] : [540, 480],
      );
      for (const brief of briefs) {
        expect(brief).toContain("Bash tool timeout 600000");
      }
    });
  }

  test("the worker rulings fit in one short file read", () => {
    const text = readFileSync(join(import.meta.dir, "../references/worker-rulings.md"), "utf8");
    expect(Buffer.byteLength(text)).toBeLessThan(5000);
    expect(text).toContain("## Standing boundary");
    expect(text).toContain("## Oracle ladder");
    expect(text).toContain("sources.musicbrainz.data.releases.releases[]");
    expect(text).toContain("sources.discogs.data.releases.sample[]");
    expect(text).toContain("sources.discogs.data.styles.styles[]");
    expect(text).toContain("sources.beatport.data.genres[]");
    expect(text).toContain("sources.apple.data.releases[]");
  });

  for (const script of ["triage-workflow.js", "verify-workflow.js"]) {
    test.each([
      { concurrency: 2, expected: 2 },
      { concurrency: undefined, expected: 6 },
    ])(
      `${script} caps every phase at $expected workers and completes every batch`,
      async ({ concurrency, expected }) => {
        const research = Array.from({ length: 7 }, (_, index) => ({
          ...mixed,
          slug: `mixed-${index}`,
        }));
        const { briefs, peaks } = await runWorkflow(script, research, {
          batch: 1,
          censusBatch: 1,
          concurrency,
          total: 7,
        });

        if (script === "triage-workflow.js") {
          expect(peaks).toEqual({ Census: expected, Research: expected });
          expect(briefs.length).toBe(14);
        } else {
          expect(peaks).toEqual({ Verify: expected });
          expect(briefs.length).toBe(7);
        }
      },
    );
  }
});
