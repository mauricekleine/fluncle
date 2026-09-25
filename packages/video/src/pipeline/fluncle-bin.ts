import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export function fluncleBin(): string {
  const override = process.env.FLUNCLE_BIN;
  if (override) {
    return override;
  }

  const home = process.env.HOME;
  if (home) {
    const installed = join(home, ".local", "bin", "fluncle");
    try {
      accessSync(installed, constants.X_OK);
      return installed;
    } catch {}
  }

  return "fluncle";
}

export function fluncleSpawnEnv(): NodeJS.ProcessEnv {
  const path = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((segment) => !segment.includes(join("node_modules", ".bin")))
    .join(delimiter);

  return { ...process.env, PATH: path };
}
