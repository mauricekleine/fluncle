import { describe, expect, it } from "vitest";
import { pruneManifestModules } from "./prune-worker-manifest";

const modules = {
  "assets/route-a.js": { type: "esm" },
  "assets/route-a.js.map": { type: "sourcemap" },
  "index.js": { type: "esm" },
  "index.js.map": { type: "sourcemap" },
};

describe("pruneManifestModules", () => {
  it("drops source maps Sentry deleted after upload and keeps every module on disk", () => {
    const onDisk = new Set(["assets/route-a.js", "index.js"]);
    const result = pruneManifestModules(modules, (path) => onDisk.has(path));

    expect(Object.keys(result.kept)).toEqual(["assets/route-a.js", "index.js"]);
    expect(result.pruned).toEqual(["assets/route-a.js.map", "index.js.map"]);
    expect(result.missing).toEqual([]);
  });

  it("leaves a build without uploaded source maps unchanged", () => {
    const result = pruneManifestModules(modules, () => true);

    expect(result.kept).toEqual(modules);
    expect(result.pruned).toEqual([]);
  });

  it("reports a missing code module instead of dropping it, so the build fails before deploy", () => {
    const onDisk = new Set(["index.js", "index.js.map"]);
    const result = pruneManifestModules(modules, (path) => onDisk.has(path));

    expect(result.missing).toEqual(["assets/route-a.js"]);
    expect(result.pruned).toEqual(["assets/route-a.js.map"]);
  });
});
