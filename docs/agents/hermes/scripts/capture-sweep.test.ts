// Unit tests for the pure helpers in capture-sweep.ts — the box-script sweep is
// self-contained (it can't import the workspace) and lives outside any package's
// test runner, so this file uses `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/capture-sweep.test.ts
//
// `main()` is guarded behind `import.meta.main` in the sweep, so importing it here is
// side-effect free (no yt-dlp spawn, no R2, no network). Keep this green when touching
// the sticky-proxy builder, the duration guard, the key builder, or the candidate ranker.
import { describe, expect, test } from "bun:test";
import {
  buildSourceAudioKey,
  buildStickyProxyUrl,
  contentTypeForExt,
  durationWithinTolerance,
  needsBpmRederive,
  pickCandidate,
} from "./capture-sweep";

describe("buildStickyProxyUrl", () => {
  test("appends __sessid.<logId> to the username and url-encodes user + pass", () => {
    const url = buildStickyProxyUrl({
      host: "gw.example",
      logId: "004.7.2I",
      password: "p@ss:w/rd",
      port: "823",
      username: "user123",
    });

    // The session suffix pins one exit IP for the whole download (a rotating session
    // 403s the media bytes). logId chars (alnum + dot) survive encoding intact.
    expect(url).toBe("http://user123__sessid.004.7.2I:p%40ss%3Aw%2Frd@gw.example:823");
  });

  test("url-encodes a username that itself carries @ / : so the authority can't be spoofed", () => {
    const url = buildStickyProxyUrl({
      host: "gw.example",
      logId: "010.2.9Z",
      password: "secret",
      port: "823",
      username: "acct@corp",
    });

    // The whole username+suffix is encoded as one unit, so the raw `@` cannot terminate
    // the authority early.
    expect(url).toBe("http://acct%40corp__sessid.010.2.9Z:secret@gw.example:823");
  });
});

describe("durationWithinTolerance", () => {
  const opts = { tolerancePct: 0.03, toleranceSec: 3 };

  test("accepts an exact match", () => {
    expect(durationWithinTolerance(200, 200_000, opts)).toBe(true);
  });

  test("accepts within the ±3s floor", () => {
    expect(durationWithinTolerance(202.5, 200_000, opts)).toBe(true);
  });

  test("accepts within the ±3% band for a long track (band > 3s)", () => {
    // 400s target → 3% = 12s allowed, so 410s passes even though it's > 3s off.
    expect(durationWithinTolerance(410, 400_000, opts)).toBe(true);
  });

  test("rejects a gross mismatch (a 157s clip vs a 388s song — the Apify-clip trap)", () => {
    expect(durationWithinTolerance(157, 388_000, opts)).toBe(false);
  });

  test("rejects when there is no reference duration to guard against", () => {
    expect(durationWithinTolerance(200, undefined, opts)).toBe(false);
    expect(durationWithinTolerance(200, 0, opts)).toBe(false);
  });

  test("rejects a non-finite or zero candidate", () => {
    expect(durationWithinTolerance(Number.NaN, 200_000, opts)).toBe(false);
    expect(durationWithinTolerance(0, 200_000, opts)).toBe(false);
  });
});

describe("buildSourceAudioKey", () => {
  test("builds analysis/source/<logId>/<sha>.<ext> and normalizes the ext", () => {
    expect(buildSourceAudioKey("004.7.2I", "abc123", ".WEBM")).toBe(
      "analysis/source/004.7.2I/abc123.webm",
    );
    expect(buildSourceAudioKey("F-0001", "deadbeef", "opus")).toBe(
      "analysis/source/F-0001/deadbeef.opus",
    );
  });
});

describe("pickCandidate", () => {
  const opts = { tolerancePct: 0.03, toleranceSec: 3 };

  test("returns null when no candidate passes the duration guard", () => {
    const chosen = pickCandidate(
      [
        { durationSec: 157, id: "clip", title: "Some Song" },
        { durationSec: 600, id: "extended", title: "Some Song (Extended)" },
      ],
      388_000,
      opts,
    );
    expect(chosen).toBeNull();
  });

  test("de-ranks a same-length remix in favour of the plain match", () => {
    const chosen = pickCandidate(
      [
        { durationSec: 388, id: "remix", title: "Some Song (Calibre Remix)" },
        { durationSec: 388, id: "orig", title: "Some Song" },
      ],
      388_000,
      opts,
    );
    expect(chosen?.id).toBe("orig");
  });

  test("prefers an official / - Topic upload among in-tolerance candidates", () => {
    const chosen = pickCandidate(
      [
        { durationSec: 389, id: "reupload", title: "Some Song (fan reupload)" },
        { durationSec: 388, id: "topic", title: "Some Song - Topic" },
      ],
      388_000,
      opts,
    );
    expect(chosen?.id).toBe("topic");
  });

  test("falls back to the closest duration when scores tie", () => {
    const chosen = pickCandidate(
      [
        { durationSec: 391, id: "far", title: "Some Song" },
        { durationSec: 388, id: "near", title: "Some Song" },
      ],
      388_000,
      opts,
    );
    expect(chosen?.id).toBe("near");
  });
});

describe("needsBpmRederive", () => {
  test("re-derives only when the BPM is genuinely missing", () => {
    expect(needsBpmRederive(null)).toBe(true);
    expect(needsBpmRederive(undefined)).toBe(true);
    expect(needsBpmRederive(0)).toBe(true);
    expect(needsBpmRederive(-5)).toBe(true);
    expect(needsBpmRederive(Number.NaN)).toBe(true);
  });

  test("NEVER re-derives over a real BPM (incl. a real 160, deliberately not fake)", () => {
    expect(needsBpmRederive(174)).toBe(false);
    expect(needsBpmRederive(160)).toBe(false);
    expect(needsBpmRederive(87.5)).toBe(false);
  });
});

describe("contentTypeForExt", () => {
  test("maps common yt-dlp audio extensions", () => {
    expect(contentTypeForExt("webm")).toBe("audio/webm");
    expect(contentTypeForExt(".opus")).toBe("audio/opus");
    expect(contentTypeForExt("m4a")).toBe("audio/mp4");
    expect(contentTypeForExt("mp3")).toBe("audio/mpeg");
    expect(contentTypeForExt("xyz")).toBe("application/octet-stream");
  });
});
