import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const DOCKERFILE = "docs/agents/hermes/Dockerfile";
const PIN_WATCH = join(import.meta.dir, "..", "pin-watch", "rebuild-hermes.sh");

function deriveBakedPathsFunction(): string {
  const source = readFileSync(PIN_WATCH, "utf8");
  const start = source.indexOf("derive_baked_paths() {");
  const end = source.indexOf("\n}\n", start);

  if (start < 0 || end < 0) {
    throw new Error("rebuild-hermes.sh has no derive_baked_paths function");
  }

  return source.slice(start, end + 2);
}

function derive(repoDir: string, dockerfile: string): string[] {
  const run = spawnSync(
    "bash",
    ["-c", `set -euo pipefail\n${deriveBakedPathsFunction()}\nderive_baked_paths`],
    { encoding: "utf8", env: { ...process.env, DOCKERFILE: dockerfile, REPO_DIR: repoDir } },
  );

  if (run.status !== 0) {
    throw new Error(`derive_baked_paths failed: ${run.stderr}`);
  }

  return run.stdout.split("\n").filter(Boolean);
}

function dockerCopySources(dockerfile: string): string[] {
  const statements: string[] = [];
  let pending = "";

  for (const line of dockerfile.split("\n")) {
    if (/^\s*#/.test(line)) {
      continue;
    }

    const continued = /\\\s*$/.test(line);
    pending += `${line.replace(/\\\s*$/, "")} `;

    if (!continued) {
      statements.push(pending.trim());
      pending = "";
    }
  }

  const sources = new Set<string>();

  for (const statement of statements) {
    const [instruction, ...args] = statement.split(/\s+/);

    if (instruction?.toUpperCase() !== "COPY" || statement.includes("--from=")) {
      continue;
    }

    const paths = args.filter((arg) => !arg.startsWith("--"));

    for (const source of paths.slice(0, -1)) {
      sources.add(source.replace(/\/+$/, ""));
    }
  }

  return [...sources].sort();
}

describe("pin-watch's baked-path fingerprint", () => {
  test("covers every COPY source in the Hermes Dockerfile, continuation lines included", () => {
    const derived = derive(REPO_ROOT, DOCKERFILE);

    expect(derived).toEqual(dockerCopySources(readFileSync(join(REPO_ROOT, DOCKERFILE), "utf8")));
    expect(derived).toContain("apps/web/scripts/lib/device-db-schema.ts");
    expect(derived).toContain("apps/web/src/lib/server/db-dump.ts");

    for (const path of derived) {
      expect(existsSync(join(REPO_ROOT, path))).toBe(true);
    }
  });

  test("the fallback set covers every derived path, so a parse failure can only over-rebuild", () => {
    const source = readFileSync(PIN_WATCH, "utf8");
    const block = /BAKED_PATHS_FALLBACK=\(\n([\s\S]*?)\n\)/.exec(source)?.[1] ?? "";
    const fallback = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    expect(fallback.length).toBeGreaterThan(0);

    for (const path of derive(REPO_ROOT, DOCKERFILE)) {
      expect(fallback.some((root) => path === root || path.startsWith(`${root}/`))).toBe(true);
    }
  });

  test("joins continuations, skips flags, comments and --from stages, and trims trailing slashes", () => {
    const dir = mkdtempSync(join(tmpdir(), "pin-watch-baked-"));

    try {
      writeFileSync(
        join(dir, "Dockerfile"),
        [
          "FROM scratch",
          "COPY --chown=1000:1000 one.ts \\",
          "     two/ \\",
          "# a comment inside the continuation \\",
          "     three.ts /dest/",
          "copy four.ts /dest/four.ts",
          "COPY --from=builder \\",
          "     /built /dest/",
          "RUN echo COPY not-a-source.ts /dest/",
          "",
        ].join("\n"),
      );

      expect(derive(dir, "Dockerfile")).toEqual(["four.ts", "one.ts", "three.ts", "two"]);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
