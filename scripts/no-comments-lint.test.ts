import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

const BUN_CANARY = Bun.fileURLToPath(new URL("bun-canary.ts", import.meta.url));
const REPOSITORY = Bun.fileURLToPath(new URL("../", import.meta.url));
const PLUGIN = Bun.fileURLToPath(new URL("../tools/oxlint/no-comments/index.ts", import.meta.url));

const FORBIDDEN = `const first = 1;
// line
/* block */
const View = () => <div>{/* jsx */}<span /></div>;
const second = 2; // trailing
void first;
void View;
void second;
`;

const FIXED = `const first = 1;


const View = () => <div><span /></div>;
const second = 2;
void first;
void View;
void second;
`;

const ALLOWED = `#!/usr/bin/env node
// @vitest-environment jsdom
// oxlint-disable-next-line no-console -- executable fixture output
console.log("allowed");
// eslint-disable-next-line no-console -- executable fixture output
console.log("allowed");
// @ts-expect-error deliberate invalid assignment
const invalid: string = 1;
const imported = import(/* @vite-ignore */ "./runtime.js");
void invalid;
void imported;
`;

const DIAGNOSTIC = /no-comments(?:\(no-comments\)|\/no-comments)/gu;

type RunResult = {
  readonly exitCode: number;
  readonly fixed?: string;
  readonly output: string;
};

async function runLint(fixture: string, fix: boolean): Promise<RunResult> {
  const directory = await mkdtemp(join(tmpdir(), "fluncle-no-comments-lint-"));
  const filename = join(directory, "fixture.tsx");
  const config = join(directory, "oxlint.json");
  await Bun.write(filename, fixture);
  await Bun.write(
    config,
    `${JSON.stringify({
      jsPlugins: [{ name: "no-comments", specifier: PLUGIN }],
      rules: { "no-comments/no-comments": "error" },
    })}\n`,
  );

  try {
    const run = Bun.spawn(
      [
        process.execPath,
        BUN_CANARY,
        "lint",
        "--no-script",
        "--config",
        config,
        ...(fix ? ["--fix"] : []),
        filename,
      ],
      {
        cwd: REPOSITORY,
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    return {
      exitCode,
      output: `${stdout}${stderr}`,
      ...(fix ? { fixed: await readFile(filename, "utf8") } : {}),
    };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

const forbiddenRun = await runLint(FORBIDDEN, false);
const fixedRun = await runLint(FORBIDDEN, true);
const allowedRun = await runLint(ALLOWED, false);

test("the no-comments rule reports every comment form", () => {
  expect(forbiddenRun.exitCode, forbiddenRun.output).not.toBe(0);
  expect(forbiddenRun.output.match(DIAGNOSTIC)?.length ?? 0, forbiddenRun.output).toBe(4);
});

test("the no-comments rule removes comments without damaging their surroundings", () => {
  expect(fixedRun.exitCode, fixedRun.output).toBe(0);
  expect(fixedRun.fixed).toBe(FIXED);
  expect(fixedRun.output).not.toMatch(DIAGNOSTIC);
});

test("the no-comments rule allows the directives used by the repository", () => {
  expect(allowedRun.exitCode, allowedRun.output).toBe(0);
  expect(allowedRun.output).not.toMatch(DIAGNOSTIC);
});
