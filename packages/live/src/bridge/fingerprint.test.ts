// The fingerprint module's two untestable-by-eye halves: the s16le chunk-boundary
// reassembly (a sample's two bytes can land in different ffmpeg stdout chunks) and the
// four never-crash fetch rails (a fetch/decode miss must yield null frames, never throw —
// the show goes on and the operator nudges past an unmatched track).
//
// No ffmpeg (synthetic bytes; the decode tests point FLUNCLE_FFMPEG at a binary that is
// not there) and no network (globalThis.fetch is mocked, as plan.test.ts does, over the
// package's no-network preload). Deliberately NOT covered: the bytes → real mel frames
// success path, which needs a decoder — that stays proven by the fixture accuracy run
// (accuracy.ts, excluded from `bun test`).

import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  createS16leSink,
  fingerprintFile,
  fingerprintPlan,
  fingerprintPlanFullSong,
  fingerprintPreview,
  fingerprintSourceAudio,
} from "./fingerprint";

/** Encode signed 16-bit samples little-endian, the way ffmpeg's `-f s16le` pipe does. */
function encodeS16le(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  for (let i = 0; i < values.length; i++) {
    const v = values[i] & 0xffff;
    out[i * 2] = v & 0xff;
    out[i * 2 + 1] = (v >> 8) & 0xff;
  }
  return out;
}

/** Feed a byte stream to a fresh sink in the given cuts and read the samples back. */
function drain(bytes: Uint8Array, cuts: number[], seed?: number): number[] {
  const sink = createS16leSink(seed);
  let at = 0;
  for (const cut of [...cuts, bytes.length]) {
    sink.push(bytes.subarray(at, cut));
    at = cut;
  }
  return Array.from(sink.finish());
}

describe("createS16leSink", () => {
  const signal = [0, 1, -1, 1000, -1000, 32767, -32768, 12345, -12345, 7, -7];
  const expected = signal.map((v) => v / 32768);

  test("decodes a whole stream to little-endian signed samples", () => {
    expect(drain(encodeS16le(signal), [])).toEqual(expected);
  });

  test("reassembles identically no matter where the chunk boundary falls", () => {
    const bytes = encodeS16le(signal);
    // Every cut, so every odd (mid-sample) boundary is exercised, not just the even ones.
    for (let cut = 1; cut < bytes.length; cut++) {
      expect(drain(bytes, [cut])).toEqual(expected);
    }
  });

  test("carries the low byte of a straddling sample across the boundary", () => {
    const sink = createS16leSink();
    sink.push(Uint8Array.from([0x00])); // low byte of -32768, alone at the chunk edge
    expect(Array.from(sink.finish())).toEqual([]); // nothing emitted yet
    sink.push(Uint8Array.from([0x80]));
    expect(Array.from(sink.finish())).toEqual([-1]);
  });

  test("an empty chunk with a leftover pending is a no-op, not a dropped sample", () => {
    const bytes = encodeS16le(signal);
    const sink = createS16leSink();
    sink.push(bytes.subarray(0, 3)); // odd cut → one byte held
    sink.push(new Uint8Array(0));
    sink.push(new Uint8Array(0));
    sink.push(bytes.subarray(3));
    expect(Array.from(sink.finish())).toEqual(expected);
  });

  test("round-trips the sign extremes", () => {
    expect(drain(Uint8Array.from([0x00, 0x80]), [])).toEqual([-1]); // 0x8000 → -1.0
    expect(drain(Uint8Array.from([0xff, 0x7f]), [])[0]).toBeCloseTo(0.99997, 5); // 0x7FFF
    expect(drain(Uint8Array.from([0x00, 0x00]), [])).toEqual([0]);
  });

  test("holds a dangling final byte instead of emitting a half sample", () => {
    const samples = drain(Uint8Array.from([0x00, 0x80, 0x2a]), []);
    expect(samples).toEqual([-1]); // the odd trailing byte never becomes a sample
  });

  test("an empty stream finishes empty", () => {
    expect(drain(new Uint8Array(0), [])).toEqual([]);
    expect(createS16leSink(4).finish().length).toBe(0);
  });

  test("grows past its seed, preserving every earlier sample", () => {
    const ramp = Array.from({ length: 500 }, (_, i) => i - 250); // 500 ≫ the 4-sample seed
    const samples = drain(encodeS16le(ramp), [], 4);
    expect(samples.length).toBe(ramp.length); // finish() trims to the sample count
    expect(samples).toEqual(ramp.map((v) => v / 32768));
  });
});

describe("fingerprint fetch rails", () => {
  const realFetch = globalThis.fetch;
  const realFfmpeg = process.env.FLUNCLE_FFMPEG;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realFfmpeg === undefined) {
      delete process.env.FLUNCLE_FFMPEG;
    } else {
      process.env.FLUNCLE_FFMPEG = realFfmpeg;
    }
  });

  /** Await a call and return whatever it throws (or null) — bun's `.rejects` matcher reads
   * as a non-thenable to the type-aware linter, so capture the error directly. */
  const capture = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
      await run();
      return null;
    } catch (error) {
      return error;
    }
  };

  const missing = (): Response => new Response("no", { status: 404 });

  describe("fingerprintPreview", () => {
    test("asks the public preview relay for the coordinate", async () => {
      const seen: string[] = [];
      globalThis.fetch = mock(async (url: string): Promise<Response> => {
        seen.push(url);
        return missing();
      }) as unknown as typeof fetch;

      await fingerprintPreview("011.9.8I");
      await fingerprintPreview("039.2.2E", "http://127.0.0.1:4180");

      expect(seen).toEqual([
        "https://www.fluncle.com/api/preview/011.9.8I",
        "http://127.0.0.1:4180/api/preview/039.2.2E",
      ]);
    });

    test("a non-OK response yields null frames, never a throw", async () => {
      globalThis.fetch = mock(async (): Promise<Response> => missing()) as unknown as typeof fetch;
      expect(await fingerprintPreview("011.9.8I")).toEqual({ frames: null, logId: "011.9.8I" });
    });

    test("a thrown fetch (offline / DNS fault) yields null frames, never a throw", async () => {
      globalThis.fetch = mock(async (): Promise<Response> => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch;
      expect(await fingerprintPreview("011.9.8I")).toEqual({ frames: null, logId: "011.9.8I" });
    });

    test("a decode failure on an OK response yields null frames, never a throw", async () => {
      process.env.FLUNCLE_FFMPEG = "/nonexistent/ffmpeg";
      globalThis.fetch = mock(
        async (): Promise<Response> => new Response(new Uint8Array([1, 2, 3, 4])),
      ) as unknown as typeof fetch;
      expect(await fingerprintPreview("011.9.8I")).toEqual({ frames: null, logId: "011.9.8I" });
    });
  });

  describe("fingerprintSourceAudio", () => {
    const auth = { base: "http://127.0.0.1:4180", token: "operator-token" };

    test("asks the private source-audio endpoint with the operator bearer", async () => {
      let seenUrl = "";
      let seenAuth: string | undefined;
      globalThis.fetch = mock(async (url: string, init?: RequestInit): Promise<Response> => {
        seenUrl = url;
        seenAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
        return missing();
      }) as unknown as typeof fetch;

      await fingerprintSourceAudio("011.9.8I", auth);

      expect(seenUrl).toBe("http://127.0.0.1:4180/api/v1/admin/tracks/011.9.8I/source-audio");
      expect(seenAuth).toBe("Bearer operator-token");
    });

    test("a non-OK response (uncaptured track) yields null frames, never a throw", async () => {
      globalThis.fetch = mock(async (): Promise<Response> => missing()) as unknown as typeof fetch;
      expect(await fingerprintSourceAudio("011.9.8I", auth)).toEqual({
        frames: null,
        logId: "011.9.8I",
      });
    });

    test("a thrown fetch yields null frames, never a throw", async () => {
      globalThis.fetch = mock(async (): Promise<Response> => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch;
      expect(await fingerprintSourceAudio("011.9.8I", auth)).toEqual({
        frames: null,
        logId: "011.9.8I",
      });
    });
  });

  describe("the bounded pools", () => {
    const auth = { base: "http://127.0.0.1:4180", token: "operator-token" };
    const logIds = ["011.9.8I", "039.2.2E", "007.8.1B", "019.1.7X", "042.3.9Z", "003.5.4Q"];

    /** A mock that answers out of INPUT order (later ids first) and counts in-flight calls. */
    const staggered = (): { fetch: typeof fetch; peak: () => number } => {
      let inFlight = 0;
      let peak = 0;
      const impl = async (url: string): Promise<Response> => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        const index = logIds.findIndex((id) => url.includes(id));
        // Earlier ids wait longest, so every response lands out of order.
        await new Promise((r) => setTimeout(r, (logIds.length - index) * 5));
        inFlight--;
        return missing();
      };
      return { fetch: mock(impl) as unknown as typeof fetch, peak: () => peak };
    };

    test("fingerprintPlan keeps results in input order and honours the concurrency bound", async () => {
      const { fetch: mocked, peak } = staggered();
      globalThis.fetch = mocked;

      const out = await fingerprintPlan(logIds, "http://127.0.0.1:4180", 2);

      expect(out.map((f) => f.logId)).toEqual(logIds);
      expect(out.every((f) => f.frames === null)).toBe(true);
      expect(peak()).toBeLessThanOrEqual(2);
      expect(peak()).toBeGreaterThan(1); // the pool really does run in parallel
    });

    test("fingerprintPlanFullSong keeps results in input order and honours the bound", async () => {
      const { fetch: mocked, peak } = staggered();
      globalThis.fetch = mocked;

      const out = await fingerprintPlanFullSong(logIds, auth, 3);

      expect(out.map((f) => f.logId)).toEqual(logIds);
      expect(out.every((f) => f.frames === null)).toBe(true);
      expect(peak()).toBeLessThanOrEqual(3);
      expect(peak()).toBeGreaterThan(1);
    });

    test("an empty plan returns [] without hanging or fetching", async () => {
      const calls: string[] = [];
      globalThis.fetch = mock(async (url: string): Promise<Response> => {
        calls.push(url);
        return missing();
      }) as unknown as typeof fetch;

      expect(await fingerprintPlan([])).toEqual([]);
      expect(await fingerprintPlanFullSong([], auth)).toEqual([]);
      expect(calls).toEqual([]);
    });
  });

  describe("decode failure", () => {
    test("fingerprintFile REJECTS when the decoder is missing (the harness must know)", async () => {
      process.env.FLUNCLE_FFMPEG = "/nonexistent/ffmpeg";
      const error = await capture(() => fingerprintFile("011.9.8I", "/nonexistent/audio.wav"));
      expect(error).toBeInstanceOf(Error);
    });
  });
});
