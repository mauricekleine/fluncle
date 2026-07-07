// Focused test for the `--audio-file` full-song seam in analyze-track.ts (RFC
// docs/full-audio-rfc.md § Unit 2). Exercises the factored decode seam
// (`decodeToSamples` / `loadLocalFile`) and the arg-routing (`--audio-file` skips
// preview resolution → the whole pipeline runs on a LOCAL file and never touches the
// network). Importing analyze-track.ts is safe: the CLI pipeline is guarded by
// `if (import.meta.main)`, so the import only loads the exported seam functions.
//
//   bun test packages/skills/fluncle-track-enrichment/scripts/analyze-track.audio-file.test.ts
//
// The ffmpeg-dependent cases skip when ffmpeg is absent (it is a documented skill
// prereq, so on a real box / dev machine they run). No preview / network is involved.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { decodeToSamples, loadLocalFile } from "./analyze-track.ts";

const SAMPLE_RATE = 22050;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const SCRIPT = new URL("./analyze-track.ts", import.meta.url).pathname;

const workdir = mkdtempSync(join(tmpdir(), "analyze-audio-file-test-"));

afterAll(() => {
  rmSync(workdir, { force: true, recursive: true });
});

// Synthesize a real mono 16-bit PCM WAV click-track at a fixed BPM: a short decaying
// tone burst every beat over silence. The onset envelope has a clean periodic peak, so
// `estimateBpm` locks the tempo — a legitimate, deterministic full-song stand-in.
function writeClickWav(path: string, opts: { bpm: number; seconds: number }): void {
  const total = Math.floor(opts.seconds * SAMPLE_RATE);
  const pcm = new Int16Array(total);
  const period = Math.round((60 / opts.bpm) * SAMPLE_RATE);
  const clickLen = Math.round(0.012 * SAMPLE_RATE);

  for (let start = 0; start < total; start += period) {
    for (let i = 0; i < clickLen && start + i < total; i++) {
      const envelope = 1 - i / clickLen;
      pcm[start + i] = Math.round(
        envelope * 28000 * Math.sin((2 * Math.PI * 1800 * i) / SAMPLE_RATE),
      );
    }
  }

  const dataBytes = total * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < total; i++) {
    buf.writeInt16LE(pcm[i] ?? 0, 44 + i * 2);
  }

  writeFileSync(path, buf);
}

describe.skipIf(!hasFfmpeg)("decodeToSamples (the shared decode seam)", () => {
  test("decodes a local audio file to mono PCM Float32 samples", () => {
    const wav = join(workdir, "decode.wav");
    writeClickWav(wav, { bpm: 174, seconds: 8 });

    const samples = decodeToSamples(wav);

    expect(samples).toBeInstanceOf(Float32Array);
    // ~8s of mono 22050 Hz audio — allow slack for ffmpeg's encoder priming/trim.
    expect(samples.length).toBeGreaterThan(SAMPLE_RATE * 6);
    // PCM stays in the normalized [-1, 1] range — sample sparsely (a full-song array is
    // hundreds of thousands of frames; asserting every one just floods the counter).
    let peak = 0;
    for (let i = 0; i < samples.length; i += 512) {
      peak = Math.max(peak, Math.abs(samples[i] ?? 0));
    }
    expect(peak).toBeGreaterThan(0); // the click bursts are audible, not silence
    expect(peak).toBeLessThanOrEqual(1);
  });
});

describe.skipIf(!hasFfmpeg)("loadLocalFile (the --audio-file loader)", () => {
  test("returns bytes + inferred mime + decoded samples", () => {
    const wav = join(workdir, "load.wav");
    writeClickWav(wav, { bpm: 174, seconds: 8 });

    const loaded = loadLocalFile(wav);

    expect(loaded.bytes.length).toBeGreaterThan(44); // header + PCM
    expect(loaded.mime).toBe("audio/wav");
    expect(loaded.samples.length).toBeGreaterThan(SAMPLE_RATE * 6);
  });
});

describe.skipIf(!hasFfmpeg)("analyze-track --audio-file (end-to-end arg routing)", () => {
  test("skips preview resolution and emits BPM/key/features JSON from the local song", () => {
    const wav = join(workdir, "song.wav");
    // 20s so the busiest-12s BPM window + autocorrelation have material.
    writeClickWav(wav, { bpm: 174, seconds: 20 });

    const result = spawnSync(
      process.execPath,
      [SCRIPT, "--artist", "Test Artist", "--title", "Test Tone", "--audio-file", wav],
      { encoding: "utf8", timeout: 60_000 },
    );

    expect(result.status).toBe(0);

    const output = JSON.parse(result.stdout) as {
      bpm: number | null;
      bpmSource: string | null;
      features: Record<string, number>;
      key: string | null;
      previews: Array<{ source: string }>;
    };

    // The whole pipeline ran on the local file — the source is the full-song sentinel,
    // not a Deezer/iTunes preview leg (which the --audio-file path never resolves).
    expect(output.previews).toHaveLength(1);
    expect(output.previews[0]?.source).toBe("audio-file");
    expect(output.bpmSource).toBe("audio-file");

    // A clean 174 BPM click track produces a confident, in-band, non-null tempo.
    expect(typeof output.bpm).toBe("number");
    expect(output.bpm).toBeGreaterThanOrEqual(160);
    expect(output.bpm).toBeLessThanOrEqual(185);
    expect(output.bpm).toBeGreaterThan(168); // ≈174, octave-folded into the DnB band
    expect(output.bpm).toBeLessThan(180);

    // The spectral feature vector is present with its five fields (key may be null —
    // a tonal click track need not clear the key-confidence floor, and that is fine).
    expect(output.features).toMatchObject({
      centroidHz: expect.any(Number),
      highRatio: expect.any(Number),
      midFlatness: expect.any(Number),
      onsetRate: expect.any(Number),
      subBassRatio: expect.any(Number),
    });
  });
});
