// Unit tests for decodeWav's truncation guard (bun:test). A truncated download
// leaves a data-chunk header that still declares the ORIGINAL byte count; the
// decoder must refuse it with a named diagnosis rather than reading past the
// buffer and throwing an opaque RangeError.

import { expect, test } from "bun:test";

import { decodeWav } from "./analyze-audio";

/**
 * Build a minimal 16-bit mono PCM WAV. `declaredDataBytes` is what the data-chunk
 * header claims; `actualDataBytes` is how many payload bytes are actually written.
 * When they differ the file is TRUNCATED (header over-declares).
 */
function buildWav(opts: {
  actualDataBytes: number;
  declaredDataBytes?: number;
  numChannels?: number;
  sampleRate?: number;
  bitsPerSample?: number;
}): Buffer {
  const numChannels = opts.numChannels ?? 1;
  const sampleRate = opts.sampleRate ?? 22050;
  const bitsPerSample = opts.bitsPerSample ?? 16;
  const declared = opts.declaredDataBytes ?? opts.actualDataBytes;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + declared, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(declared, 40); // the DECLARED size (may over-declare)

  return Buffer.concat([header, Buffer.alloc(opts.actualDataBytes)]);
}

test("decodeWav: a well-formed wav decodes to the declared frame count", () => {
  const dataBytes = 200; // 100 s16 mono frames
  const decoded = decodeWav(buildWav({ actualDataBytes: dataBytes }));
  expect(decoded.sampleRate).toBe(22050);
  expect(decoded.samples.length).toBe(100);
});

test("decodeWav: header over-declaring the data size throws a named truncation error", () => {
  // Declares 100000 data bytes; only 40 are present → truncated.
  const buf = buildWav({ actualDataBytes: 40, declaredDataBytes: 100000 });
  expect(() => decodeWav(buf)).toThrow(/truncated wav/);
  expect(() => decodeWav(buf)).toThrow(/declares 100000 bytes but only 40/);
});

test("decodeWav: a header declaring LESS than is present is fine (trailing bytes tolerated)", () => {
  // Declares 200 bytes but 400 follow — normal (e.g. trailing chunks). Uses the
  // declared 200 → 100 frames, and never reads past the buffer.
  const decoded = decodeWav(buildWav({ actualDataBytes: 400, declaredDataBytes: 200 }));
  expect(decoded.samples.length).toBe(100);
});

test("decodeWav: a non-RIFF buffer still throws the format error, not truncation", () => {
  expect(() => decodeWav(Buffer.alloc(64))).toThrow(/not a RIFF\/WAVE file/);
});
