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
  filterRejectedCandidates,
  buildSearchQuery,
  buildSourceAudioKey,
  buildStickyProxyUrl,
  classifyChannelTrust,
  contentTypeForExt,
  durationWithinTolerance,
  extractSourceAudioSha256,
  isTopicChannel,
  needsReenrichAfterCapture,
  normalizeChannelName,
  pickCandidate,
  rankCandidates,
  shouldReenrichAfterCapture,
  verifyCaptureFile,
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

describe("isTopicChannel", () => {
  test("recognizes an auto-generated <Artist> - Topic channel (whatever the spacing)", () => {
    expect(isTopicChannel("Cyantific - Topic")).toBe(true);
    expect(isTopicChannel("Netsky - Topic")).toBe(true);
    expect(isTopicChannel("Chase & Status-Topic")).toBe(true);
    expect(isTopicChannel("  Sub Focus - Topic  ")).toBe(true);
  });

  test("does not fire on a normal channel that merely mentions 'topic'", () => {
    expect(isTopicChannel("UKF Drum & Bass")).toBe(false);
    expect(isTopicChannel("Topical News Network")).toBe(false);
    expect(isTopicChannel("Hot Topic Records")).toBe(false);
    expect(isTopicChannel(undefined)).toBe(false);
  });
});

describe("buildSearchQuery", () => {
  test("variant 0 keeps the historic shape: every artist joined + the full title", () => {
    expect(
      buildSearchQuery({ artists: ["Commix", "Nu:Tone", "Logistics"], title: "Coffee" }, 0),
    ).toBe("Commix Nu:Tone Logistics Coffee");
    // Whitespace is collapsed but nothing is dropped — a currently-matching row cannot regress.
    expect(buildSearchQuery({ artists: ["Sub Focus"], title: "Scarecrow" }, 0)).toBe(
      "Sub Focus Scarecrow",
    );
  });

  test("variant 1 de-constrains a multi-artist credit to the PRIMARY artist only", () => {
    expect(
      buildSearchQuery({ artists: ["Commix", "Nu:Tone", "Logistics"], title: "Coffee" }, 1),
    ).toBe("Commix Coffee");
  });

  test("variant 1 strips a trailing version parenthetical/bracket", () => {
    expect(buildSearchQuery({ artists: ["Technimatic"], title: "Parallel (radio edit)" }, 1)).toBe(
      "Technimatic Parallel",
    );
    expect(buildSearchQuery({ artists: ["Artist"], title: "Song [VIP Mix]" }, 1)).toBe(
      "Artist Song",
    );
    // A bare (non-parenthetical) version word like "VIP" is part of the real title — kept.
    expect(buildSearchQuery({ artists: ["Nu:Tone"], title: "Missing Link VIP" }, 1)).toBe(
      "Nu:Tone Missing Link VIP",
    );
  });

  test("variant 1 equals variant 0 for a single-artist clean title — the caller skips the retry", () => {
    const finding = { artists: ["Sub Focus"], title: "Scarecrow" };
    expect(buildSearchQuery(finding, 1)).toBe(buildSearchQuery(finding, 0));
  });

  test("tolerates a missing artist list or title without throwing", () => {
    expect(buildSearchQuery({ title: "Untitled" }, 0)).toBe("Untitled");
    expect(buildSearchQuery({ artists: ["Solo"] }, 1)).toBe("Solo");
    expect(buildSearchQuery({}, 1)).toBe("");
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

describe("extractSourceAudioSha256 — the wrong-audio re-capture memory", () => {
  const sha = "a".repeat(64);

  test("round-trips buildSourceAudioKey: the hash slot comes back out", () => {
    expect(extractSourceAudioSha256(buildSourceAudioKey("004.7.2I", sha, "webm"))).toBe(sha);
    expect(extractSourceAudioSha256(buildSourceAudioKey(`catalogue/mb_x`, sha, "opus"))).toBe(sha);
  });

  test("lowercases and tolerates a missing key", () => {
    expect(extractSourceAudioSha256(`catalogue/mb_x/${"F".repeat(64)}.mp3`)).toBe("f".repeat(64));
    expect(extractSourceAudioSha256(undefined)).toBeNull();
  });

  test("rejects a basename that is not a 64-hex digest — no false bad-audio match", () => {
    // A pre-hash legacy key, or any non-digest basename, must not read as a reject hash.
    expect(extractSourceAudioSha256("004.7.2I/notahash.webm")).toBeNull();
    expect(extractSourceAudioSha256("catalogue/x/deadbeef.opus")).toBeNull();
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

  test("trusts an <Artist> - Topic art-track channel (the label-delivered master)", () => {
    const trust = classifyChannelTrust(
      {
        channel: "Cyantific - Topic",
        channelId: "UC_topic",
        durationSec: 200,
        id: "x",
        title: "Quiet Star",
      },
      { label: "Hospital Records" },
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

describe("pickCandidate", () => {
  const opts = { tolerancePct: 0.03, toleranceSec: 3 };

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

  test("TRUST NO LONGER WAIVES THE DURATION GUARD: a padded trusted upload is now REJECTED", () => {
    // Demoted trust (docs/the-ear.md § Wrong audio): the old +60s trusted pad was the 005.9.9L
    // hole, so it is gone. A trusted label upload 22s over the 191.7s master (which the removed pad
    // once accepted) now fails the SYMMETRIC guard just like an untrusted one. When only padded
    // uploads exist, `pickCandidate` returns null → the sweep lands `unmatched` rather than storing
    // a possibly-wrong file; the fingerprint gate would have been the only thing standing between it
    // and a bad capture, and correctness runs toward not downloading at all.
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
      ],
      { durationMs: 191_724, label: "1991" },
      opts,
    );
    expect(chosen).toBeNull();
  });

  test("trust still RANKS equals: the trusted same-length master wins over an untrusted re-upload", () => {
    // Trust survives as a ranking tiebreak among candidates that all pass the symmetric guard —
    // the label upload beats a random re-host of the same-length master (identity safety), even
    // though the fingerprint gate now backstops the identity check.
    const chosen = pickCandidate(
      [
        { channel: "randochan", durationSec: 192, id: "reupload", title: "1991 - If Only" },
        { channel: "UKF Drum & Bass", durationSec: 192, id: "ukf", title: "1991 - If Only" },
      ],
      { durationMs: 191_724, label: "1991" },
      opts,
    );
    expect(chosen?.trust).toBe(2);
    expect(chosen?.candidate.id).toBe("ukf");
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

  test("prefers an <Artist> - Topic art-track over a curated-aggregator upload of the same length", () => {
    // Both pass the guard and both are tier-2 trust; the Topic upload wins on the `official`
    // tiebreak (the label-delivered master), which its bare title alone would never have earned.
    const chosen = pickCandidate(
      [
        {
          channel: "UKF Drum & Bass",
          durationSec: 281,
          id: "ukf",
          title: "Cyantific - Quiet Star",
        },
        { channel: "Cyantific - Topic", durationSec: 281, id: "topic", title: "Quiet Star" },
      ],
      { durationMs: 281_213, label: "Hospital Records" },
      opts,
    );
    expect(chosen?.candidate.id).toBe("topic");
    expect(chosen?.trust).toBe(2);
  });

  test("a Topic art-track does NOT rescue a wrong-length upload — the guard still rejects it", () => {
    // Topic recognition is a RANKING signal only; it never relaxes the duration guard. A Topic
    // upload 100s off the master is filtered out exactly like any other candidate.
    const chosen = pickCandidate(
      [{ channel: "Cyantific - Topic", durationSec: 381, id: "topic", title: "Quiet Star" }],
      { durationMs: 281_213 },
      opts,
    );
    expect(chosen).toBeNull();
  });
});

describe("rankCandidates", () => {
  const opts = { tolerancePct: 0.03, toleranceSec: 3 };

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

describe("filterRejectedCandidates — the pre-download memory filter", () => {
  const entry = (id: string) => ({ candidate: { durationSec: 388, id, title: "T" }, trust: 0 });

  test("skips remembered video ids BEFORE spending the attempt budget", () => {
    // v1 is in the bad-audio memory. With a budget of 2, the walk must get v2 + v3 — a budget cut
    // FIRST would hand back [v1, v2], wasting an attempt slot on a candidate the memory already
    // ruled out.
    const attempts = filterRejectedCandidates(
      [entry("v1"), entry("v2"), entry("v3")],
      new Set(["v1"]),
      2,
    );

    expect(attempts.map((a) => a.candidate.id)).toEqual(["v2", "v3"]);
  });

  test("every candidate remembered → nothing to attempt (the sweep lands unmatched)", () => {
    const attempts = filterRejectedCandidates([entry("v1"), entry("v2")], new Set(["v1", "v2"]), 3);

    expect(attempts).toEqual([]);
  });

  test("an empty memory is a plain budget slice", () => {
    const attempts = filterRejectedCandidates(
      [entry("v1"), entry("v2"), entry("v3"), entry("v4")],
      new Set(),
      3,
    );

    expect(attempts.map((a) => a.candidate.id)).toEqual(["v1", "v2", "v3"]);
  });
});

describe("verifyCaptureFile", () => {
  test("ABSTAINS (no-reference) when there is no preview fingerprint to check against", () => {
    // A track with no preview source ⇒ the gate never blocks; it stamps `unverified`. This is the
    // one branch reachable without an fpcalc binary (CI has none); the match/mismatch verdicts ride
    // `slidingWindowMatch`, unit-tested exhaustively in fingerprint-match.test.ts.
    expect(verifyCaptureFile(null, "/nonexistent/audio.webm")).toBe("no-reference");
  });

  test("ABSTAINS when the capture cannot be fingerprinted (fpcalc absent / bad decode)", () => {
    // With a real preview fp but a file fpcalc cannot read, the verdict is `no-reference` (abstain),
    // never a false `mismatch` — the gate degrades honestly.
    expect(verifyCaptureFile([1, 2, 3], "/nonexistent/audio.webm")).toBe("no-reference");
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
