// Verifies the two-pass loudnorm (normalizeAndEncode) and the bounded
// preview-audio cache helpers. The loudnorm tests synthesize a local test tone
// with ffmpeg rather than fetching a real preview, so they run offline and
// fast; they self-skip if ffmpeg isn't on PATH (this package always needs
// ffmpeg for real use, but a bare `bun test` sandbox may not have it).

import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  deletePreviewAudio,
  downloadPreview,
  normalizeAndEncode,
  sweepPreviewAudioCache,
} from "./download-preview";

const FFMPEG = process.env.FLUNCLE_FFMPEG ?? "ffmpeg";
const hasFfmpeg = spawnSync(FFMPEG, ["-version"]).status === 0;

/** Re-measure a file's integrated loudness with a single loudnorm measure-only pass. */
function measureIntegratedLoudness(file: string): number {
  const probe = spawnSync(
    FFMPEG,
    ["-i", file, "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"],
    { encoding: "utf8" },
  );
  const match = /\{[\s\S]*\}/.exec(probe.stderr ?? "");
  if (!match) {
    throw new Error(`no loudnorm JSON in probe stderr:\n${probe.stderr}`);
  }
  const measured = JSON.parse(match[0]) as { input_i: string };
  return Number.parseFloat(measured.input_i);
}

describe.skipIf(!hasFfmpeg)("normalizeAndEncode (two-pass loudnorm)", () => {
  test("converges near the -14 LUFS target on a synthetic tone", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fluncle-loudnorm-"));
    try {
      const src = path.join(dir, "tone.wav");
      const out = path.join(dir, "tone.m4a");
      // A -20 dBFS sine tone: quiet enough that the -1.5 dBTP ceiling never
      // engages, so the two-pass gain lands on the -14 LUFS integrated target.
      const gen = spawnSync(FFMPEG, [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=1000:duration=3",
        "-af",
        "volume=-20dB",
        "-ar",
        "44100",
        src,
      ]);
      expect(gen.status).toBe(0);

      await normalizeAndEncode(src, out);

      const outputLoudness = measureIntegratedLoudness(out);
      expect(Math.abs(outputLoudness - -14)).toBeLessThan(1.5);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  }, 30_000);

  test("is deterministic: measuring the same source twice yields the same stats", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fluncle-loudnorm-det-"));
    try {
      const src = path.join(dir, "tone.wav");
      const outA = path.join(dir, "a.m4a");
      const outB = path.join(dir, "b.m4a");
      spawnSync(FFMPEG, [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=2",
        "-af",
        "volume=-18dB",
        "-ar",
        "44100",
        src,
      ]);

      await normalizeAndEncode(src, outA);
      await normalizeAndEncode(src, outB);

      const loudnessA = measureIntegratedLoudness(outA);
      const loudnessB = measureIntegratedLoudness(outB);
      expect(Math.abs(loudnessA - loudnessB)).toBeLessThan(0.1);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  }, 30_000);
});

describe("sweepPreviewAudioCache", () => {
  test("keeps only the N most-recently-modified .m4a files and never touches other files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fluncle-sweep-"));
    try {
      // 5 previews, ages oldest -> newest, plus a non-preview file that must survive.
      const names = ["a.m4a", "b.m4a", "c.m4a", "d.m4a", "e.m4a"];
      const now = Date.now() / 1000;
      for (const [index, name] of names.entries()) {
        await writeFile(path.join(dir, name), "x");
        // Stagger mtimes so sort order is deterministic: a oldest, e newest.
        const mtime = now - (names.length - index) * 60;
        await utimes(path.join(dir, name), mtime, mtime);
      }
      await writeFile(path.join(dir, ".gitkeep"), "");

      const deleted = await sweepPreviewAudioCache(3, dir);

      expect(deleted.sort()).toEqual(["a.m4a", "b.m4a"]);
      const remaining = (await readdir(dir)).sort();
      expect(remaining).toEqual([".gitkeep", "c.m4a", "d.m4a", "e.m4a"]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("keep >= file count deletes nothing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fluncle-sweep-noop-"));
    try {
      await writeFile(path.join(dir, "only.m4a"), "x");

      const deleted = await sweepPreviewAudioCache(8, dir);

      expect(deleted).toEqual([]);
      expect(await readdir(dir)).toEqual(["only.m4a"]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("a missing directory returns an empty list rather than throwing", async () => {
    const deleted = await sweepPreviewAudioCache(8, "/nonexistent/fluncle-sweep-dir");

    expect(deleted).toEqual([]);
  });
});

describe("downloadPreview (fetch headers)", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // Drive downloadPreview through a swapped fetch that captures the request init
  // and returns a non-ok response, so it throws before any ffmpeg work — enough
  // to assert the auth headers reach the fetch (or are absent on the live path).
  function installCapturingFetch(): { calls: { init: RequestInit | undefined; url: string }[] } {
    const calls: { init: RequestInit | undefined; url: string }[] = [];
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ init, url });
      return { ok: false, status: 404, statusText: "Not Found" } as Response;
    }) as typeof fetch;
    return { calls };
  }

  test("forwards the provided headers to the fetch", async () => {
    const { calls } = installCapturingFetch();

    let error: unknown;
    await downloadPreview("https://www.fluncle.com/api/admin/tracks/x/preview-audio", "trk", {
      authorization: "Bearer agent-token",
    }).catch((e: unknown) => {
      error = e;
    });

    expect((error as Error | undefined)?.message).toMatch(/GET preview failed with 404/);
    expect((calls[0]?.init?.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer agent-token",
    );
  });

  test("passes no headers on the live-preview path (backward compatible)", async () => {
    const { calls } = installCapturingFetch();

    let error: unknown;
    await downloadPreview("https://cdn.deezer.com/live.mp3", "trk").catch((e: unknown) => {
      error = e;
    });

    expect((error as Error | undefined)?.message).toMatch(/GET preview failed with 404/);
    expect(calls[0]?.init?.headers).toBeUndefined();
  });
});

describe("deletePreviewAudio", () => {
  test("deletes the track's m4a and returns true", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fluncle-delete-"));
    try {
      await writeFile(path.join(dir, "track123.m4a"), "x");

      const result = await deletePreviewAudio("track123", dir);

      expect(result).toBe(true);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("a missing file returns false rather than throwing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fluncle-delete-missing-"));
    try {
      const result = await deletePreviewAudio("nope", dir);

      expect(result).toBe(false);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
