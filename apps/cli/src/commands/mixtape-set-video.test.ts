import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCompleteXml,
  DEFAULT_PART_SIZE,
  MAX_PART_ATTEMPTS,
  MAX_PARTS,
  MIN_PART_SIZE,
  planMultipart,
  putPart,
  renditionFfmpegArgs,
  SET_VIDEO_RENDITION,
} from "./mixtape-set-video";

// CI has NO ffmpeg, so every test here exercises the PURE logic only — the multipart
// part-splitting, the completion XML, and the ffmpeg arg SHAPE (a string array, never
// invoked). The one test that actually shells out to ffmpeg is skip-guarded on a
// `ffmpeg -version` probe so CI (no ffmpeg) skips it and a dev box (has ffmpeg) runs it.
const hasFfmpeg = (() => {
  try {
    return (
      Bun.spawnSync(["ffmpeg", "-version"], { stderr: "ignore", stdout: "ignore" }).exitCode === 0
    );
  } catch {
    return false;
  }
})();

describe("planMultipart", () => {
  test("a sub-part-size file is one part covering the whole range", () => {
    const plan = planMultipart(123);

    expect(plan.partCount).toBe(1);
    expect(plan.parts).toEqual([{ end: 123, partNumber: 1, size: 123, start: 0 }]);
  });

  test("splits into contiguous, gapless, ascending parts", () => {
    // Part sizes must clear R2's 5MB floor, so size in units of it.
    const u = MIN_PART_SIZE;
    const total = u * 2 + 7;
    const plan = planMultipart(total, u);

    expect(plan.partCount).toBe(3);
    expect(plan.parts).toEqual([
      { end: u, partNumber: 1, size: u, start: 0 },
      { end: u * 2, partNumber: 2, size: u, start: u },
      { end: total, partNumber: 3, size: 7, start: u * 2 },
    ]);

    // Contiguous + complete coverage.
    let cursor = 0;
    for (const part of plan.parts) {
      expect(part.start).toBe(cursor);
      cursor = part.end;
    }
    expect(cursor).toBe(total);
  });

  test("an exact multiple yields no trailing empty part", () => {
    const u = MIN_PART_SIZE;
    const plan = planMultipart(u * 2, u);

    expect(plan.partCount).toBe(2);
    expect(plan.parts.at(-1)).toEqual({ end: u * 2, partNumber: 2, size: u, start: u });
  });

  test("floors the part size at R2's 5MB minimum", () => {
    const plan = planMultipart(MIN_PART_SIZE * 3, 1024);

    expect(plan.partSize).toBe(MIN_PART_SIZE);
    expect(plan.partCount).toBe(3);
  });

  test("grows the part size so a huge file stays within the 10k-part cap", () => {
    // With the default part size this would need > MAX_PARTS parts; the plan must grow
    // the part size instead of overflowing the cap.
    const huge = DEFAULT_PART_SIZE * (MAX_PARTS + 500);
    const plan = planMultipart(huge);

    expect(plan.partCount).toBeLessThanOrEqual(MAX_PARTS);
    expect(plan.partSize).toBeGreaterThan(DEFAULT_PART_SIZE);
  });

  test("a realistic ~1.6GB rendition splits into the default part size", () => {
    const plan = planMultipart(1_600_000_000);

    expect(plan.partSize).toBe(DEFAULT_PART_SIZE);
    expect(plan.partCount).toBe(Math.ceil(1_600_000_000 / DEFAULT_PART_SIZE));
  });

  test("rejects a non-positive or non-integer size", () => {
    expect(() => planMultipart(0)).toThrow(/positive integer/);
    expect(() => planMultipart(-5)).toThrow(/positive integer/);
    expect(() => planMultipart(1.5)).toThrow(/positive integer/);
  });
});

describe("buildCompleteXml", () => {
  test("emits parts in ascending partNumber order regardless of input order", () => {
    const xml = buildCompleteXml([
      { etag: '"etag-2"', partNumber: 2 },
      { etag: '"etag-1"', partNumber: 1 },
      { etag: '"etag-3"', partNumber: 3 },
    ]);

    expect(xml).toBe(
      "<CompleteMultipartUpload>" +
        "<Part><PartNumber>1</PartNumber><ETag>&quot;etag-1&quot;</ETag></Part>" +
        "<Part><PartNumber>2</PartNumber><ETag>&quot;etag-2&quot;</ETag></Part>" +
        "<Part><PartNumber>3</PartNumber><ETag>&quot;etag-3&quot;</ETag></Part>" +
        "</CompleteMultipartUpload>",
    );
  });

  test("escapes XML-special characters in an ETag", () => {
    const xml = buildCompleteXml([{ etag: 'a&b<c>"d', partNumber: 1 }]);

    expect(xml).toContain("<ETag>a&amp;b&lt;c&gt;&quot;d</ETag>");
    expect(xml).not.toContain("a&b<c>");
  });

  test("an empty part list still yields a valid wrapper", () => {
    expect(buildCompleteXml([])).toBe("<CompleteMultipartUpload></CompleteMultipartUpload>");
  });
});

describe("renditionFfmpegArgs", () => {
  test("encodes the 1080p faststart H.264 + AAC rendition spec", () => {
    const args = renditionFfmpegArgs("/in/master.mov", "/out/set.mp4");

    expect(args.at(0)).toBe("-y");
    expect(args).toContain("/in/master.mov");
    expect(args.at(-1)).toBe("/out/set.mp4");
    expect(args).toContain("libx264");
    expect(args).toContain("aac");
    expect(args).toContain(`scale=-2:${SET_VIDEO_RENDITION.height}`);
    expect(args).toContain(String(SET_VIDEO_RENDITION.crf));
    expect(args).toContain("+faststart");
    // Dense GOP for scrubbing, fps-independent.
    expect(args).toContain(`expr:gte(t,n_forced*${SET_VIDEO_RENDITION.gopSeconds})`);
  });

  test("the input flag precedes the input path (ffmpeg arg order)", () => {
    const args = renditionFfmpegArgs("/in/master.mov", "/out/set.mp4");
    expect(args.indexOf("-i")).toBe(args.indexOf("/in/master.mov") - 1);
  });
});

describe("renditionFfmpegArgs (real ffmpeg)", () => {
  test.if(hasFfmpeg)("derives a playable rendition from a synthetic source", async () => {
    const dir = tmpdir();
    const source = join(dir, `fluncle-set-test-src-${crypto.randomUUID()}.mp4`);
    const out = join(dir, `fluncle-set-test-out-${crypto.randomUUID()}.mp4`);

    try {
      // Generate a 1s test clip (color bars + a 440Hz tone) as the "master".
      const gen = Bun.spawn(
        [
          "ffmpeg",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc=duration=1:size=640x480:rate=30",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=1",
          "-shortest",
          source,
        ],
        { stderr: "ignore", stdout: "ignore" },
      );
      await gen.exited;
      expect(gen.exitCode).toBe(0);

      const derive = Bun.spawn(["ffmpeg", ...renditionFfmpegArgs(source, out)], {
        stderr: "ignore",
        stdout: "ignore",
      });
      await derive.exited;
      expect(derive.exitCode).toBe(0);
      expect(await Bun.file(out).exists()).toBe(true);
      expect((await Bun.file(out).arrayBuffer()).byteLength).toBeGreaterThan(0);
    } finally {
      rmSync(source, { force: true });
      rmSync(out, { force: true });
    }
  });
});

// The load-bearing reliability fix: a single dropped R2 PUT ("socket closed") must be
// retried, not abort the whole multi-hundred-part upload — while a permanent 4xx stops
// immediately. Mocks global fetch + a tmp file (putPart slices the file per part).
describe("putPart retry", () => {
  const tmpFile = join(tmpdir(), `putpart-test-${crypto.randomUUID()}.bin`);
  writeFileSync(tmpFile, Buffer.alloc(2048, 1));
  const part = { end: 2048, partNumber: 3, size: 2048, start: 0 } as const;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
  afterAll(() => {
    rmSync(tmpFile, { force: true });
  });

  test("retries a dropped socket, then returns the ETag on success", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error("The socket connection was closed unexpectedly");
      }
      return new Response(null, { headers: { etag: '"deadbeef"' }, status: 200 });
    }) as unknown as typeof fetch;

    const etag = await putPart("https://r2.example/part", tmpFile, part);
    expect(etag).toBe('"deadbeef"');
    expect(calls).toBe(3); // failed twice, succeeded on the third
  });

  test("does NOT retry a permanent 4xx (bad signature)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("SignatureDoesNotMatch", { status: 403 });
    }) as unknown as typeof fetch;

    await expect(putPart("https://r2.example/part", tmpFile, part)).rejects.toThrow(
      /rejected part/,
    );
    expect(calls).toBe(1); // one attempt, no retry
  });

  test("caps the total attempts at MAX_PART_ATTEMPTS", () => {
    // A guard on the retry budget (the exhaustion path leans on real backoff, too slow for a
    // unit test — the cap is what keeps a bad part from looping forever).
    expect(MAX_PART_ATTEMPTS).toBe(5);
  });
});
