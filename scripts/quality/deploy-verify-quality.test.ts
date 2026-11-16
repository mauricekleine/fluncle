import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyMainQuality, waitForMainQuality } from "./deploy-verify-quality.mjs";

const sha = "a".repeat(40);
const successfulRun = {
  conclusion: "success",
  event: "push",
  head_branch: "main",
  head_repository: { full_name: "mauricekleine/fluncle" },
  head_sha: sha,
  id: 123,
  path: ".github/workflows/quality-checks.yml",
  run_attempt: 1,
  status: "completed",
};

function response(runs: object[]) {
  return Response.json({ workflow_runs: runs });
}

describe("main Quality publication proof", () => {
  test("accepts the successful exact-SHA main push, including lanes reused by main", async () => {
    await expect(
      waitForMainQuality({
        fetchImpl: async () => response([successfulRun]),
        sha,
        token: "test-token",
        write: () => {},
      }),
    ).resolves.toEqual({ verified: true });
  });

  test.each(["failure", "cancelled", "timed_out", "skipped"])(
    "refuses a completed %s run and names its evidence",
    async (conclusion) => {
      await expect(
        waitForMainQuality({
          fetchImpl: async () => response([{ ...successfulRun, conclusion }]),
          sha,
          token: "test-token",
        }),
      ).rejects.toThrow("actions/runs/123");
    },
  );

  test("waits for pending evidence and accepts its eventual success", async () => {
    let clock = 0;
    const replies = [
      [],
      [{ ...successfulRun, conclusion: null, status: "in_progress" }],
      [successfulRun],
    ];
    await expect(
      waitForMainQuality({
        deadlineMs: 100,
        fetchImpl: async () => response(replies.shift() ?? []),
        intervalMs: 10,
        now: () => clock,
        sha,
        sleep: async (ms) => {
          clock += ms;
        },
        token: "test-token",
        write: () => {},
      }),
    ).resolves.toEqual({ verified: true });
    expect(clock).toBe(20);
  });

  test.each([
    { head_sha: "b".repeat(40) },
    { head_branch: "feature" },
    { event: "pull_request" },
    { path: ".github/workflows/other.yml" },
    { head_repository: { full_name: "someone/fork" } },
    { conclusion: null, status: "in_progress" },
  ])("cannot substitute unrelated or unfinished evidence: %j", async (other) => {
    let clock = 0;
    await expect(
      waitForMainQuality({
        deadlineMs: 25,
        fetchImpl: async () => response([{ ...successfulRun, ...other }]),
        intervalMs: 10,
        now: () => clock,
        sha,
        sleep: async (ms) => {
          clock += ms;
        },
        token: "test-token",
        write: () => {},
      }),
    ).rejects.toThrow("main Quality timed out");
    expect(clock).toBe(25);
  });

  test("a newer failed run supersedes an older success", async () => {
    await expect(
      waitForMainQuality({
        fetchImpl: async () =>
          response([successfulRun, { ...successfulRun, conclusion: "failure", id: 124 }]),
        sha,
        token: "test-token",
      }),
    ).rejects.toThrow("actions/runs/124");
  });

  test("an API error cannot authorize publication", async () => {
    await expect(
      waitForMainQuality({
        fetchImpl: async () => new Response("denied", { status: 403 }),
        sha,
        token: "test-token",
      }),
    ).rejects.toThrow("HTTP 403");
  });

  test.each([
    { FLUNCLE_DEPLOY_GITHUB_TOKEN: "test-token", FLUNCLE_DEPLOY_SKIP_MAIN_QUALITY: "1" },
    {},
  ])("warns without claiming proof when explicitly bypassed or unconfigured: %j", async (env) => {
    let output = "";
    await expect(
      verifyMainQuality({
        env,
        write: (text) => {
          output += text;
        },
      }),
    ).resolves.toEqual({ verified: false });
    expect(output).toContain("WARNING:");
  });
});

describe("deploy build boundary", () => {
  test.each([
    {
      branch: "main",
      conclusion: "success",
      exit: 0,
      override: "",
      tests: false,
      token: "test-token",
    },
    {
      branch: "preview",
      conclusion: "success",
      exit: 0,
      override: "",
      tests: true,
      token: "test-token",
    },
    {
      branch: "main",
      conclusion: "failure",
      exit: 1,
      override: "",
      tests: false,
      token: "test-token",
    },
    { branch: "main", conclusion: "failure", exit: 0, override: "", tests: true, token: "" },
    {
      branch: "main",
      conclusion: "failure",
      exit: 0,
      override: "1",
      tests: true,
      token: "test-token",
    },
  ])("runs the correct checks for %j", ({ branch, conclusion, token, override, tests, exit }) => {
    const root = mkdtempSync(join(tmpdir(), "deploy-quality-"));
    try {
      const log = join(root, "commands");
      const preload = join(root, "github.mjs");
      writeFileSync(
        preload,
        `globalThis.fetch = async () => Response.json(${JSON.stringify({ workflow_runs: [{ ...successfulRun, conclusion }] })});\n`,
      );
      writeFileSync(
        join(root, "bun"),
        '#!/bin/sh\ncase "$1" in\n*build-commit.ts) printf "%s" "$WORKERS_CI_COMMIT_SHA" ;;\n*) printf "%s\\n" "$*" >> "$DEPLOY_TEST_LOG" ;;\nesac\n',
        { mode: 0o755 },
      );
      const gate = fileURLToPath(new URL("./deploy-gate.mjs", import.meta.url));
      const result = spawnSync("node", ["--import", preload, gate], {
        encoding: "utf8",
        env: {
          ...process.env,
          DEPLOY_TEST_LOG: log,
          FLUNCLE_DEPLOY_GITHUB_TOKEN: token,
          FLUNCLE_DEPLOY_SKIP_MAIN_QUALITY: override,
          PATH: `${root}:${process.env.PATH}`,
          WORKERS_CI_BRANCH: branch,
          WORKERS_CI_COMMIT_SHA: sha,
        },
      });
      expect(result.status).toBe(exit);
      if (exit === 0) {
        const commands = readFileSync(log, "utf8");
        expect(commands.includes("run test ")).toBe(tests);
        expect(commands).toContain("run typecheck ");
        expect(commands).toContain("run format:check");
        expect(commands).toContain("run lint");
      } else {
        expect(result.stderr).toContain("actions/runs/123");
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("publication checks main Quality before invoking Cloudflare", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../apps/web/package.json", import.meta.url), "utf8"),
    );
    const commands: string[] = pkg.scripts["deploy:cf"].split(" && ");
    const publication = commands.findIndex((command) => command.includes("cf deploy --prebuilt"));
    expect(commands[publication - 1]).toBe("node ../../scripts/quality/deploy-verify-quality.mjs");
  });
});
