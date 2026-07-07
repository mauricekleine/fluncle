// Unit tests for the pure source-selection helpers in enrich-sweep.ts — the box-script
// sweep is self-contained (it can't import the workspace) and lives outside any package's
// test runner, so this file uses `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/enrich-sweep.test.ts
//
// `main()` is guarded behind `import.meta.main` in the sweep, so importing it here is
// side-effect free (no fluncle spawn, no R2, no network). Keep this green when touching
// how the sweep chooses between the captured full song and the 30s preview.
import { describe, expect, test } from "bun:test";

import { buildAnalyzeArgs, extFromKey } from "./enrich-sweep";

const SCRIPT = "/opt/data/skills/fluncle-track-enrichment/scripts/analyze-track.ts";

describe("buildAnalyzeArgs", () => {
  test("preview path (no key): artist + title, no --audio-file", () => {
    expect(buildAnalyzeArgs(SCRIPT, { artist: "Loadstar", title: "Take a Deep Breath" })).toEqual([
      SCRIPT,
      "--artist",
      "Loadstar",
      "--title",
      "Take a Deep Breath",
    ]);
  });

  test("preview path with ISRC: appends --isrc, still no --audio-file", () => {
    expect(
      buildAnalyzeArgs(SCRIPT, { artist: "Loadstar", isrc: "GB5KW1701923", title: "TADB" }),
    ).toEqual([SCRIPT, "--artist", "Loadstar", "--title", "TADB", "--isrc", "GB5KW1701923"]);
  });

  test("full-song path: appends --audio-file so the analyzer reads the whole song", () => {
    const args = buildAnalyzeArgs(SCRIPT, {
      artist: "Loadstar",
      audioFilePath: "/tmp/fluncle-enrich-src-x/source.opus",
      isrc: "GB5KW1701923",
      title: "TADB",
    });

    expect(args).toEqual([
      SCRIPT,
      "--artist",
      "Loadstar",
      "--title",
      "TADB",
      "--isrc",
      "GB5KW1701923",
      "--audio-file",
      "/tmp/fluncle-enrich-src-x/source.opus",
    ]);
  });

  test("an empty audioFilePath is treated as absent (falls back to the preview args)", () => {
    const args = buildAnalyzeArgs(SCRIPT, { artist: "A", audioFilePath: "", title: "B" });

    expect(args).not.toContain("--audio-file");
  });
});

describe("extFromKey", () => {
  test("extracts the extension of a <logId>/<sha256>.<ext> key", () => {
    expect(extFromKey("004.7.2I/abc123.opus")).toBe("opus");
    expect(extFromKey("F-0001/deadbeef.WEBM")).toBe("webm");
    expect(extFromKey("010.2.9Z/hash.m4a")).toBe("m4a");
  });

  test("falls back to 'bin' when the key has no extension", () => {
    expect(extFromKey("004.7.2I/nohash")).toBe("bin");
  });
});
