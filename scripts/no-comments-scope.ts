import { lstat, readFile } from "node:fs/promises";

const REPOSITORY = Bun.fileURLToPath(new URL("../", import.meta.url));
const CONFIG = Bun.fileURLToPath(new URL("../.oxlintrc.json", import.meta.url));

type Override = { files?: string[]; rules?: Record<string, string> };

export async function noCommentsScope(): Promise<readonly Bun.Glob[]> {
  const config = Bun.JSONC.parse(await readFile(CONFIG, "utf8")) as {
    overrides?: Override[];
  };
  const overrides = (config.overrides ?? []).filter(
    (entry) => entry.rules?.["no-comments/no-comments"] === "error",
  );
  if (overrides.length !== 1 || !Array.isArray(overrides[0]?.files)) {
    throw new Error("Expected one enabled no-comments override with a files list");
  }
  return overrides[0].files.map((pattern) => new Bun.Glob(pattern));
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
