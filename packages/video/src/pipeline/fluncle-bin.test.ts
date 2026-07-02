import { delimiter, join } from "node:path";

import { describe, expect, test } from "bun:test";

import { fluncleBin, fluncleSpawnEnv } from "./fluncle-bin";

describe("fluncleBin", () => {
  test("FLUNCLE_BIN override wins", () => {
    const prev = process.env.FLUNCLE_BIN;
    process.env.FLUNCLE_BIN = "/opt/custom/fluncle";
    try {
      expect(fluncleBin()).toBe("/opt/custom/fluncle");
    } finally {
      if (prev === undefined) {
        delete process.env.FLUNCLE_BIN;
      } else {
        process.env.FLUNCLE_BIN = prev;
      }
    }
  });

  test("resolves to a concrete binary or the bare name, never the workspace shim", () => {
    const resolved = fluncleBin();
    expect(resolved.includes(join("node_modules", ".bin"))).toBe(false);
  });
});

describe("fluncleSpawnEnv", () => {
  test("strips every node_modules/.bin segment from PATH", () => {
    const prev = process.env.PATH;
    process.env.PATH = [
      "/repo/node_modules/.bin",
      "/usr/local/bin",
      "/repo/packages/video/node_modules/.bin",
      "/usr/bin",
    ].join(delimiter);
    try {
      const path = fluncleSpawnEnv().PATH ?? "";
      expect(path.split(delimiter)).toEqual(["/usr/local/bin", "/usr/bin"]);
    } finally {
      process.env.PATH = prev;
    }
  });

  test("keeps the rest of the environment intact", () => {
    expect(fluncleSpawnEnv().HOME).toBe(process.env.HOME);
  });
});
