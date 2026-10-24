import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessReuse, createProof } from "./source-proof.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture(path = "catalogue.txt") {
  const root = mkdtempSync(join(tmpdir(), "quality-proof-"));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_EMAIL: "fixture@example.com",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.com",
        GIT_COMMITTER_NAME: "Fixture",
      },
    }).trim();
  git("init", "--quiet");
  writeFileSync(join(root, "catalogue.txt"), "base");
  git("add", ".");
  const base = git("commit-tree", git("write-tree"), "-m", "base");
  writeFileSync(join(root, path), "changed");
  git("add", ".");
  const tree = git("write-tree");
  const head = git("commit-tree", tree, "-p", base, "-m", "PR head");
  const synthetic = git("commit-tree", tree, "-p", base, "-p", head, "-m", "synthetic PR merge");
  git("update-ref", "HEAD", synthetic);
  const repository = "example/catalogue";
  const proof = createProof({
    attempt: 1,
    base,
    head,
    pr: 7,
    repository,
    root,
    runId: 42,
    sha: synthetic,
  });
  if (!proof) {
    throw new Error("Fixture did not create a synthetic merge proof");
  }
  const sha = git("commit-tree", tree, "-p", base, "-m", "squash merge");
  git("update-ref", "HEAD", sha);
  const context = {
    base,
    event: "push",
    now: Date.parse("2026-10-24T12:00:00Z"),
    ref: "refs/heads/main",
    repository,
    root,
    sha,
  };
  const responses: Record<string, unknown> = {
    "/actions/runs/42/artifacts?per_page=100": {
      artifacts: [{ expired: false, id: 9, name: "quality-source-proof", size_in_bytes: 512 }],
    },
    "/actions/runs/42/attempts/1/jobs?per_page=100": {
      jobs: [
        "Selected quality lanes",
        "Public flows when selected (1/4)",
        "Public flows when selected (2/4)",
        "Public flows when selected (3/4)",
        "Public flows when selected (4/4)",
        "Lint, Format, and Typecheck",
      ].map((name) => ({ conclusion: "success", name, status: "completed" })),
    },
    "/actions/workflows/quality-checks.yml": { id: 12 },
    [`/actions/workflows/quality-checks.yml/runs?event=pull_request&head_sha=${head}&status=success&per_page=100`]:
      {
        workflow_runs: [
          {
            conclusion: "success",
            created_at: "2026-10-24T10:40:00Z",
            event: "pull_request",
            head_repository: { full_name: repository },
            head_sha: head,
            id: 42,
            path: ".github/workflows/quality-checks.yml",
            run_attempt: 1,
            status: "completed",
            updated_at: "2026-10-24T11:00:00Z",
            workflow_id: 12,
          },
        ],
      },
    [`/commits/${sha}/pulls`]: [
      {
        base: { ref: "main", repo: { full_name: repository } },
        head: { repo: { full_name: repository }, sha: head },
        merge_commit_sha: sha,
        merged_at: "2026-10-24T11:05:00Z",
        number: 7,
      },
    ],
    [`/git/commits/${synthetic}`]: {
      parents: [{ sha: base }, { sha: head }],
      sha: synthetic,
      tree: { sha: tree },
    },
  };
  const source = {
    json: async (route: string) => {
      if (!(route in responses)) {
        throw new Error(`Unexpected GitHub API route ${route}`);
      }
      return responses[route];
    },
    proof: async () => proof,
  };
  const runs = (
    responses[
      `/actions/workflows/quality-checks.yml/runs?event=pull_request&head_sha=${head}&status=success&per_page=100`
    ] as { workflow_runs: Array<Record<string, unknown>> }
  ).workflow_runs;
  const jobs = (
    responses["/actions/runs/42/attempts/1/jobs?per_page=100"] as {
      jobs: Array<Record<string, unknown>>;
    }
  ).jobs;
  const run = runs[0];
  if (!run) {
    throw new Error("Missing fixture run");
  }
  return { context, git, head, jobs, proof, responses, run, source, synthetic, tree };
}

describe("PR proof reuse", () => {
  test("a successful synthetic PR tree proves the exact squash-merged main tree", async () => {
    const f = fixture();
    expect(await assessReuse(f.context, f.source)).toMatchObject({
      pr: 7,
      reused: true,
      runId: 42,
      sha: f.context.sha,
    });
  });

  test("the main CLI consumes a zipped GitHub artifact and reports the reused source", () => {
    const f = fixture();
    const bin = join(f.context.root, "bin");
    mkdirSync(bin);
    const finished = new Date(Date.now() - 60000).toISOString();
    f.run.created_at = finished;
    f.run.updated_at = finished;
    const prs = f.responses[`/commits/${f.context.sha}/pulls`] as Array<Record<string, unknown>>;
    for (const pr of prs) {
      pr.merged_at = new Date().toISOString();
    }
    const data = join(f.context.root, "github.json");
    writeFileSync(data, JSON.stringify({ proof: f.proof, responses: f.responses }));
    writeFileSync(
      join(bin, "gh"),
      `#!/usr/bin/env python3
import io,json,os,sys,zipfile
with open(os.environ["PROOF_FIXTURE"]) as file:
    data=json.load(file)
route=sys.argv[-1].removeprefix("repos/example/catalogue")
if route=="/actions/artifacts/9/zip":
    buffer=io.BytesIO()
    with zipfile.ZipFile(buffer,"w") as archive:
        archive.writestr("quality-source-proof.json",json.dumps(data["proof"]))
    sys.stdout.buffer.write(buffer.getvalue())
else:
    print(json.dumps(data["responses"][route]))
`,
      { mode: 0o755 },
    );
    const event = join(f.context.root, "event.json");
    writeFileSync(event, JSON.stringify({ before: f.context.base }));
    const output = join(f.context.root, "output");
    const summary = join(f.context.root, "summary");
    execFileSync("node", [join(import.meta.dir, "source-proof.mjs"), "assess"], {
      cwd: f.context.root,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_PATH: event,
        GITHUB_OUTPUT: output,
        GITHUB_REF: "refs/heads/main",
        GITHUB_REPOSITORY: f.context.repository,
        GITHUB_SHA: f.context.sha,
        GITHUB_STEP_SUMMARY: summary,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        PROOF_FIXTURE: data,
      },
    });
    expect(readFileSync(output, "utf8")).toBe("reused=true\n");
    expect(readFileSync(summary, "utf8")).toContain('"runId":42');
  });

  test("a normal merge with the same validated parents and tree also reuses proof", async () => {
    const f = fixture();
    f.git("update-ref", "HEAD", f.synthetic);
    f.responses[`/commits/${f.synthetic}/pulls`] = f.responses[`/commits/${f.context.sha}/pulls`];
    const prs = f.responses[`/commits/${f.synthetic}/pulls`] as Array<Record<string, unknown>>;
    for (const pr of prs) {
      pr.merge_commit_sha = f.synthetic;
    }
    expect(await assessReuse({ ...f.context, sha: f.synthetic }, f.source)).toMatchObject({
      reused: true,
    });
  });

  test("main moving under a PR invalidates its proof even when the final tree is identical", async () => {
    const f = fixture();
    const movedBase = f.git("commit-tree", f.tree, "-p", f.context.base, "-m", "main advanced");
    const movedMerge = f.git("commit-tree", f.tree, "-p", movedBase, "-m", "later squash merge");
    f.git("update-ref", "HEAD", movedMerge);
    const prs = f.responses[`/commits/${f.context.sha}/pulls`] as Array<Record<string, unknown>>;
    for (const pr of prs) {
      pr.merge_commit_sha = movedMerge;
    }
    f.responses[`/commits/${movedMerge}/pulls`] = prs;
    expect(
      await assessReuse({ ...f.context, base: movedBase, sha: movedMerge }, f.source),
    ).toMatchObject({ reused: false });
  });

  for (const [index, change] of [
    (f: ReturnType<typeof fixture>) => {
      f.proof.tree = "f".repeat(40);
    },
    (f: ReturnType<typeof fixture>) => {
      f.proof.head = "f".repeat(40);
    },
    (f: ReturnType<typeof fixture>) => {
      f.proof.repository = "outside/fork";
    },
    (f: ReturnType<typeof fixture>) => {
      f.proof.runId = 43;
    },
    (f: ReturnType<typeof fixture>) => {
      f.run.workflow_id = 99;
    },
    (f: ReturnType<typeof fixture>) => {
      f.run.run_attempt = 2;
    },
    (f: ReturnType<typeof fixture>) => {
      f.run.conclusion = "failure";
    },
    (f: ReturnType<typeof fixture>) => {
      f.run.updated_at = "2026-10-24T11:10:00Z";
    },
    (f: ReturnType<typeof fixture>) => {
      f.responses[`/git/commits/${f.synthetic}`] = {
        parents: [{ sha: "f".repeat(40) }, { sha: f.head }],
        sha: f.synthetic,
        tree: { sha: f.tree },
      };
    },
  ].entries()) {
    test(`mismatched tree, PR, workflow, or attempt metadata refuses proof reuse (case ${index + 1})`, async () => {
      const f = fixture();
      change(f);
      expect(await assessReuse(f.context, f.source)).toMatchObject({ reused: false });
    });
  }

  test("every shard must finish successfully and missing or duplicate owners cannot prove a run", async () => {
    const f = fixture();
    for (const job of f.jobs.filter((job) => String(job.name).startsWith("Public flows"))) {
      for (const conclusion of ["failure", "skipped", "cancelled", null]) {
        job.conclusion = conclusion;
        expect(await assessReuse(f.context, f.source)).toMatchObject({ reused: false });
      }
      job.conclusion = "success";
    }
    f.jobs.splice(4, 1);
    expect(await assessReuse(f.context, f.source)).toMatchObject({ reused: false });
    const duplicate = f.jobs[1];
    if (!duplicate) {
      throw new Error("Missing fixture shard");
    }
    f.jobs.push(duplicate);
    expect(await assessReuse(f.context, f.source)).toMatchObject({ reused: false });
  });

  test("expired proof, changed controls, multi-commit pushes and unavailable API run fresh validation", async () => {
    const f = fixture();
    expect(
      await assessReuse({ ...f.context, now: f.context.now + 6 * 3600000 }, f.source),
    ).toMatchObject({ reused: false });
    expect(await assessReuse({ ...f.context, base: f.head }, f.source)).toMatchObject({
      reused: false,
    });
    expect(
      await assessReuse(f.context, {
        ...f.source,
        proof: async () => {
          throw new Error("artifact unavailable");
        },
      }),
    ).toMatchObject({ reused: false });
    const controls = fixture("package.json");
    expect(await assessReuse(controls.context, controls.source)).toMatchObject({
      reason: "validation-controls-changed",
      reused: false,
    });
    expect(await assessReuse({ ...f.context, event: "workflow_dispatch" }, f.source)).toMatchObject(
      { reused: false },
    );
  });

  test("proof creation rejects a stale event base and an untested head checkout", () => {
    const f = fixture();
    expect(createProof({ ...f.context, attempt: 1, head: f.head, pr: 7, runId: 42 })).toBeNull();
    f.git("update-ref", "HEAD", f.synthetic);
    expect(
      createProof({
        ...f.context,
        attempt: 1,
        base: f.head,
        head: f.head,
        pr: 7,
        runId: 42,
        sha: f.synthetic,
      }),
    ).toBeNull();
  });
});
