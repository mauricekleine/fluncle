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
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
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

    expect(samples.length).toBeGreaterThan(SAMPLE_RATE * 6);

    let peak = 0;
    for (let i = 0; i < samples.length; i += 512) {
      peak = Math.max(peak, Math.abs(samples[i] ?? 0));
    }
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(1);
  });
});

describe.skipIf(!hasFfmpeg)("loadLocalFile (the --audio-file loader)", () => {
  test("returns bytes + inferred mime + decoded samples", () => {
    const wav = join(workdir, "load.wav");
    writeClickWav(wav, { bpm: 174, seconds: 8 });

    const loaded = loadLocalFile(wav);

    expect(loaded.bytes.length).toBeGreaterThan(44);
    expect(loaded.mime).toBe("audio/wav");
    expect(loaded.samples.length).toBeGreaterThan(SAMPLE_RATE * 6);
  });
});

describe.skipIf(!hasFfmpeg)("analyze-track --audio-file (end-to-end arg routing)", () => {
  test("skips preview resolution and emits BPM/key/features JSON from the local song", () => {
    const wav = join(workdir, "song.wav");

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

    expect(output.previews).toHaveLength(1);
    expect(output.previews[0]?.source).toBe("audio-file");
    expect(output.bpmSource).toBe("audio-file");

    expect(typeof output.bpm).toBe("number");
    expect(output.bpm).toBeGreaterThanOrEqual(160);
    expect(output.bpm).toBeLessThanOrEqual(185);
    expect(output.bpm).toBeGreaterThan(168);
    expect(output.bpm).toBeLessThan(180);

    expect(output.features).toMatchObject({
      centroidHz: expect.any(Number),
      highRatio: expect.any(Number),
      midFlatness: expect.any(Number),
      onsetRate: expect.any(Number),
      subBassRatio: expect.any(Number),
    });
  });
});
