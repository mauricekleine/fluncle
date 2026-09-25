import { lstat, readFile } from "node:fs/promises";

const REPOSITORY = Bun.fileURLToPath(new URL("../", import.meta.url));
const CONFIGS = [
  { path: "", required: true },
  { path: "apps/web/", required: false },
] as const;

type Override = { files?: string[]; rules?: Record<string, string> };

async function enabledPatterns(prefix: string, required: boolean): Promise<string[]> {
  const config = Bun.JSONC.parse(
    await readFile(`${REPOSITORY}${prefix}.oxlintrc.json`, "utf8"),
  ) as {
    overrides?: Override[];
  };
  const overrides = (config.overrides ?? []).filter(
    (entry) => entry.rules?.["no-comments/no-comments"] === "error",
  );
  if (overrides.length === 0 && !required) {
    return [];
  }
  if (overrides.length !== 1 || !Array.isArray(overrides[0]?.files)) {
    throw new Error(
      `Expected one enabled no-comments override with a files list in ${prefix}.oxlintrc.json`,
    );
  }
  return overrides[0].files.map((pattern) => `${prefix}${pattern}`);
}

export async function noCommentsScopePatterns(): Promise<readonly string[]> {
  const lists = await Promise.all(
    CONFIGS.map(({ path, required }) => enabledPatterns(path, required)),
  );
  return lists.flat();
}

export async function noCommentsScope(): Promise<readonly Bun.Glob[]> {
  return (await noCommentsScopePatterns()).map((pattern) => new Bun.Glob(pattern));
}

export function inScope(path: string, scope: readonly Bun.Glob[]): boolean {
  return scope.some((glob) => glob.match(path));
}

export async function trackedScopedFiles(scope: readonly Bun.Glob[]): Promise<readonly string[]> {
  const process = Bun.spawn(["git", "ls-files", "-z"], {
    cwd: REPOSITORY,
    stdout: "pipe",
  });
  const output = await new Response(process.stdout).text();
  if ((await process.exited) !== 0) {
    throw new Error("git ls-files failed");
  }
  const candidates = output
    .split("\0")
    .filter(
      (path) =>
        path !== "" &&
        inScope(path, scope) &&
        !path.startsWith(".agents/skills/") &&
        !path.startsWith(".claude/skills/") &&
        !path.startsWith("apps/web/drizzle/"),
    );
  const files: string[] = [];
  for (const path of candidates) {
    if (!(await lstat(`${REPOSITORY}/${path}`)).isSymbolicLink()) {
      files.push(path);
    }
  }
  return files;
}

export { REPOSITORY };
