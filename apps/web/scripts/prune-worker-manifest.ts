import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const WORKER_OUTPUT = join(
  import.meta.dirname,
  "..",
  ".cloudflare",
  "output",
  "v0",
  "workers",
  "default",
);

type ManifestModule = { type: string };

export type PruneResult = {
  kept: Record<string, ManifestModule>;
  missing: string[];
  pruned: string[];
};

export function pruneManifestModules(
  modules: Record<string, ManifestModule>,
  exists: (path: string) => boolean,
): PruneResult {
  const kept: Record<string, ManifestModule> = {};
  const missing: string[] = [];
  const pruned: string[] = [];

  for (const [path, module] of Object.entries(modules)) {
    if (exists(path)) {
      kept[path] = module;
    } else if (module.type === "sourcemap") {
      pruned.push(path);
    } else {
      missing.push(path);
    }
  }

  return { kept, missing, pruned };
}

function main(): void {
  const configPath = join(WORKER_OUTPUT, "worker.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    manifest: { modules: Record<string, ManifestModule> };
  };
  const { kept, missing, pruned } = pruneManifestModules(config.manifest.modules, (path) =>
    existsSync(join(WORKER_OUTPUT, "bundle", path)),
  );

  if (missing.length > 0) {
    console.error(
      `prune-worker-manifest: ${missing.length} Worker modules are listed but missing, so cf deploy --prebuilt would fail:\n${missing.join("\n")}`,
    );
    process.exit(1);
  }

  if (pruned.length > 0) {
    config.manifest.modules = kept;
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  console.log(
    `prune-worker-manifest: ${Object.keys(kept).length} modules kept, ${pruned.length} uploaded source maps dropped.`,
  );
}

if (import.meta.main) {
  main();
}
