import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildAnalyzeArgs, extFromKey } from "./enrich-sweep";

const SCRIPT = "/opt/hermes-skills/fluncle-track-enrichment/scripts/analyze-track.ts";

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

describe("enrich sweep summary", () => {
  async function run(mode: "empty" | "failure"): Promise<{
    exitCode: number;
    summary: Record<string, unknown>;
  }> {
    const dir = mkdtempSync(join(tmpdir(), "enrich-sweep-test-"));
    const fluncle = join(dir, "fluncle");
    const runner = join(dir, "admission-runner");
    writeFileSync(
      fluncle,
      '#!/usr/bin/env bash\nif [ "$ENRICH_STUB_MODE" = "failure" ]; then\n  printf "queue unavailable\\n" >&2\n  exit 1\nfi\nprintf \'{"tracks":[]}\\n\'\n',
    );
    writeFileSync(runner, '#!/usr/bin/env bash\nshift 3\n"$@"\n');
    chmodSync(fluncle, 0o755);
    chmodSync(runner, 0o755);

    try {
      const proc = Bun.spawn(
        [process.execPath, new URL("./enrich-sweep.ts", import.meta.url).pathname],
        {
          env: {
            ...process.env,
            DATABASE_ADMISSION_RUNNER: runner,
            ENRICH_STUB_MODE: mode,
            FLUNCLE_API_TOKEN: "",
            FLUNCLE_BIN: fluncle,
          },
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      const [exitCode, stdout] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      return { exitCode, summary: JSON.parse(stdout) as Record<string, unknown> };
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }

  test("a genuine queue failure reports errors:1 and exits non-zero", async () => {
    const { exitCode, summary } = await run("failure");

    expect(exitCode).not.toBe(0);
    expect(summary).toMatchObject({ errors: 1, ok: false, reason: "enrich_failed" });
    expect(summary).not.toHaveProperty("failed");
  });

  test("a capped empty queue does not publish queue_depth", async () => {
    const { exitCode, summary } = await run("empty");

    expect(exitCode).toBe(0);
    expect(summary).toMatchObject({ checked: 0, errors: 0, failed: 0, ok: true });
    expect(summary).not.toHaveProperty("queue_depth");
  });
});
