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
  bpmIsMissing,
  buildSourceAudioKey,
  buildStickyProxyUrl,
  classifyChannelTrust,
  contentTypeForExt,
  durationAcceptable,
  durationWithinTolerance,
  needsReenrichAfterCapture,
  normalizeChannelName,
  pickCandidate,
  rankCandidates,
  shouldReenrichAfterCapture,
} from "./capture-sweep";

describe("buildStickyProxyUrl", () => {
  test("appends __sessid.<sessionId> to the username and url-encodes user + pass", () => {
    const url = buildStickyProxyUrl({
      host: "gw.example",
      password: "p@ss:w/rd",
      port: "823",
      sessionId: "004.7.2I",
      username: "user123",
    });

    // The session suffix pins one exit IP for the whole download (a rotating session
    // 403s the media bytes). logId chars (alnum + dot) survive encoding intact.
    expect(url).toBe("http://user123__sessid.004.7.2I:p%40ss%3Aw%2Frd@gw.example:823");
  });

  test("url-encodes a username that itself carries @ / : so the authority can't be spoofed", () => {
    const url = buildStickyProxyUrl({
      host: "gw.example",
      password: "secret",
      port: "823",
      sessionId: "010.2.9Z",
      username: "acct@corp",
    });

    // The whole username+suffix is encoded as one unit, so the raw `@` cannot terminate
    // the authority early.
    expect(url).toBe("http://acct%40corp__sessid.010.2.9Z:secret@gw.example:823");
  });

  test("sanitizes a catalogue track id (mb_<uuid>) to the alnum+dot session charset", () => {
    const url = buildStickyProxyUrl({
      host: "gw.example",
      password: "secret",
      port: "823",
      sessionId: "mb_1f2a3b4c-5d6e-7f80-9a0b-c1d2e3f4a5b6",
      username: "user123",
    });

    // `_` and `-` are stripped (the proxy vendor's session parser is only proven on the
    // Log ID charset); the result stays deterministic per track, which is all
    // stickiness needs.
    expect(url).toBe(
      "http://user123__sessid.mb1f2a3b4c5d6e7f809a0bc1d2e3f4a5b6:secret@gw.example:823",
    );
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
  test("builds <logId>/<sha>.<ext> and normalizes the ext", () => {
    expect(buildSourceAudioKey("004.7.2I", "abc123", ".WEBM")).toBe("004.7.2I/abc123.webm");
    expect(buildSourceAudioKey("F-0001", "deadbeef", "opus")).toBe("F-0001/deadbeef.opus");
  });

  test("a catalogue row keys under catalogue/<trackId>/ — a namespace no Log ID can collide with", () => {
    expect(buildSourceAudioKey("catalogue/mb_1f2a3b4c", "abc123", "webm")).toBe(
      "catalogue/mb_1f2a3b4c/abc123.webm",
    );
  });
});

describe("normalizeChannelName", () => {
  test("reduces a label/channel to a stable comparable token", () => {
    expect(normalizeChannelName("UKF Drum & Bass")).toBe("ukf");
    expect(normalizeChannelName("Hospital Records")).toBe("hospital");
    expect(normalizeChannelName("Hospital")).toBe("hospital");
    expect(normalizeChannelName("Liquicity")).toBe("liquicity");
    expect(normalizeChannelName("1991")).toBe("1991");
  });
});

describe("classifyChannelTrust", () => {
  test("trusts the artist's own channel by id (the strongest signal)", () => {
    const trust = classifyChannelTrust(
      { channel: "Some Artist", channelId: "UC_artist", durationSec: 200, id: "x", title: "t" },
      { artistYoutubeChannelIds: ["UC_artist"], label: "Some Label" },
    );
    expect(trust).toBe(2);
  });

  test("trusts a curated aggregator channel by name", () => {
    const trust = classifyChannelTrust(
      { channel: "UKF Drum & Bass", durationSec: 200, id: "x", title: "t" },
      {},
    );
    expect(trust).toBe(2);
  });

  test("trusts a channel whose name equals the finding's label", () => {
    const trust = classifyChannelTrust(
      { channel: "1991", durationSec: 200, id: "x", title: "t" },
      { label: "1991" },
    );
    expect(trust).toBe(2);
  });

  test("a merely-verified channel is a soft tier 1 (does not relax duration)", () => {
    const trust = classifyChannelTrust(
      { channel: "GALAXIES MUSIC", durationSec: 200, id: "x", title: "t", verified: true },
      { label: "1991" },
    );
    expect(trust).toBe(1);
  });

  test("an unknown, unverified channel is untrusted", () => {
    const trust = classifyChannelTrust(
      { channel: "EDM Old&New", durationSec: 200, id: "x", title: "t" },
      { label: "1991" },
    );
    expect(trust).toBe(0);
  });
});

describe("durationAcceptable", () => {
  const opts = { tolerancePct: 0.03, toleranceSec: 3, trustedPadSec: 60 };

  test("untrusted takes the strict symmetric guard", () => {
    expect(durationAcceptable(214, 191_724, 0, opts)).toBe(false); // 22s over → rejected
    expect(durationAcceptable(192, 191_724, 0, opts)).toBe(true);
  });

  test("trusted tolerates intro/outro padding above the master (the 'If Only' case)", () => {
    // 191.7s master, 214s label video (22.3s of padding) → accepted for a trusted channel.
    expect(durationAcceptable(214, 191_724, 2, opts)).toBe(true);
  });

  test("trusted stays tight BELOW (a shorter upload is a radio edit, not the master)", () => {
    expect(durationAcceptable(150, 191_724, 2, opts)).toBe(false);
  });

  test("trusted is still BOUNDED — an hour-long DJ set on the same channel is rejected", () => {
    expect(durationAcceptable(3549, 191_724, 2, opts)).toBe(false);
  });
});

describe("pickCandidate", () => {
  const opts = { tolerancePct: 0.03, toleranceSec: 3, trustedPadSec: 60 };

  test("returns null when no candidate passes the duration guard", () => {
    const chosen = pickCandidate(
      [
        { durationSec: 157, id: "clip", title: "Some Song" },
        { durationSec: 600, id: "extended", title: "Some Song (Extended)" },
      ],
      { durationMs: 388_000 },
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
      { durationMs: 388_000 },
      opts,
    );
    expect(chosen?.candidate.id).toBe("orig");
  });

  test("prefers an official / - Topic upload among in-tolerance candidates", () => {
    const chosen = pickCandidate(
      [
        { durationSec: 389, id: "reupload", title: "Some Song (fan reupload)" },
        { durationSec: 388, id: "topic", title: "Some Song - Topic" },
      ],
      { durationMs: 388_000 },
      opts,
    );
    expect(chosen?.candidate.id).toBe("topic");
  });

  test("falls back to the closest duration when scores tie", () => {
    const chosen = pickCandidate(
      [
        { durationSec: 391, id: "far", title: "Some Song" },
        { durationSec: 388, id: "near", title: "Some Song" },
      ],
      { durationMs: 388_000 },
      opts,
    );
    expect(chosen?.candidate.id).toBe("near");
  });

  test("recovers 'If Only': a trusted label upload padded past the guard is chosen + tier 2", () => {
    // The real 'ytsearch5:1991 if only' shape: four 214s hits (label master is 191.7s) plus a
    // 59-min live set on the artist's channel. Only the trusted channels pass the padded guard;
    // the untrusted 214s re-uploads and the live set are rejected.
    const chosen = pickCandidate(
      [
        {
          channel: "1991",
          channelId: "UCA0G8t",
          durationSec: 214,
          id: "artist",
          title: "1991 - If Only",
          verified: true,
        },
        {
          channel: "UKF Drum & Bass",
          durationSec: 214,
          id: "ukf",
          title: "1991 - If Only",
          verified: true,
        },
        { channel: "GALAXIES MUSIC", durationSec: 214, id: "junk1", title: "1991 - If Only" },
        { channel: "EDM Old&New", durationSec: 214, id: "junk2", title: "1991 - If Only" },
        {
          channel: "1991",
          channelId: "UCA0G8t",
          durationSec: 3549,
          id: "set",
          title: "1991 @ circuitGROUNDS | EDC Vegas 2026",
        },
      ],
      { durationMs: 191_724, label: "1991" },
      opts,
    );
    // A trusted channel is chosen (the guard let the 22s padding through); the untrusted
    // 214s re-uploads and the 3549s live set are excluded.
    expect(chosen?.trust).toBe(2);
    expect(["artist", "ukf"]).toContain(chosen?.candidate.id);
  });

  test("trust does NOT override a wrong-version title: an untrusted clean master beats a trusted remix", () => {
    const chosen = pickCandidate(
      [
        // In-tolerance so it survives the guard — the sort (clean-title first) must still sink it.
        {
          channel: "UKF Drum & Bass",
          durationSec: 388,
          id: "trusted-remix",
          title: "Some Song (VIP Mix)",
        },
        { channel: "randochan", durationSec: 388, id: "untrusted-clean", title: "Some Song" },
      ],
      { durationMs: 388_000 },
      opts,
    );
    expect(chosen?.candidate.id).toBe("untrusted-clean");
  });
});

describe("rankCandidates", () => {
  const opts = { tolerancePct: 0.03, toleranceSec: 3, trustedPadSec: 60 };

  test("returns the full ordered list so the sweep can fall through a DRM/bot-walled top hit", () => {
    // The top hit is a trusted exact-length master (e.g. DRM-locked at download time); the
    // second is an untrusted-but-clean exact-length re-upload the sweep can fall through to.
    const ranked = rankCandidates(
      [
        { channel: "randochan", durationSec: 388, id: "reupload", title: "Some Song" },
        { channel: "UKF Drum & Bass", durationSec: 388, id: "label", title: "Some Song" },
      ],
      { durationMs: 388_000 },
      opts,
    );
    expect(ranked.map((r) => r.candidate.id)).toEqual(["label", "reupload"]);
    expect(ranked[0]?.trust).toBe(2);
  });

  test("returns [] when nothing passes the guard", () => {
    const ranked = rankCandidates(
      [{ durationSec: 157, id: "clip", title: "Some Song" }],
      { durationMs: 388_000 },
      opts,
    );
    expect(ranked).toEqual([]);
  });
});

describe("bpmIsMissing", () => {
  test("true only when the BPM is genuinely missing", () => {
    expect(bpmIsMissing(null)).toBe(true);
    expect(bpmIsMissing(undefined)).toBe(true);
    expect(bpmIsMissing(0)).toBe(true);
    expect(bpmIsMissing(-5)).toBe(true);
    expect(bpmIsMissing(Number.NaN)).toBe(true);
  });

  test("false for a real BPM (incl. a real 160, deliberately not fake)", () => {
    expect(bpmIsMissing(174)).toBe(false);
    expect(bpmIsMissing(160)).toBe(false);
    expect(bpmIsMissing(87.5)).toBe(false);
  });
});

describe("needsReenrichAfterCapture", () => {
  test("re-queues when the BPM is missing, whatever the provenance", () => {
    expect(needsReenrichAfterCapture(null, "full")).toBe(true);
    expect(needsReenrichAfterCapture(undefined, "preview")).toBe(true);
    expect(needsReenrichAfterCapture(0, undefined)).toBe(true);
  });

  test("re-queues a preview-grade (or legacy NULL) row even with a real BPM — closes the race", () => {
    // The capture just landed; the row was enriched from the 30s preview before it. A real
    // BPM alone must not stop the re-derive from the full song now on file.
    expect(needsReenrichAfterCapture(174, "preview")).toBe(true);
    expect(needsReenrichAfterCapture(160, undefined)).toBe(true);
  });

  test("does NOT re-queue a full-analyzed row with a real BPM (no needless work)", () => {
    expect(needsReenrichAfterCapture(174, "full")).toBe(false);
    expect(needsReenrichAfterCapture(87.5, "full")).toBe(false);
  });
});

describe("shouldReenrichAfterCapture — the certification gate on the re-derive", () => {
  test("a CERTIFIED finding behaves exactly like needsReenrichAfterCapture (today's behaviour)", () => {
    // With the brake paused every queued row is a finding, so this is the ONLY path that runs —
    // and it must be byte-identical to the old predicate for every input.
    for (const [bpm, from] of [
      [null, "full"],
      [undefined, "preview"],
      [0, undefined],
      [174, "preview"],
      [160, undefined],
      [174, "full"],
      [87.5, "full"],
    ] as const) {
      expect(shouldReenrichAfterCapture(true, bpm, from)).toBe(
        needsReenrichAfterCapture(bpm, from),
      );
    }
  });

  test("an UNCERTIFIED (catalogue) row is NEVER re-queued — enrichment_status is a certification field", () => {
    // Even the inputs that would re-queue a finding must not, for a catalogue row: writing
    // `enrichmentStatus` on an uncertified track is a 409 (the certification rail), and its
    // enrichment is not a thing that exists.
    expect(shouldReenrichAfterCapture(false, null, "preview")).toBe(false);
    expect(shouldReenrichAfterCapture(false, undefined, undefined)).toBe(false);
    expect(shouldReenrichAfterCapture(false, 174, "full")).toBe(false);
  });

  test("an ABSENT certified flag is treated as not-certified (a malformed row writes nothing)", () => {
    expect(shouldReenrichAfterCapture(undefined, null, "preview")).toBe(false);
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
