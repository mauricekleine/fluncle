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
import { readFileSync } from "node:fs";
import {
  bpmIsMissing,
  buildCaptureConfigFailureSummary,
  buildCaptureFatalSummary,
  buildCaptureSummary,
  captureSessionSeed,
  filterRejectedCandidates,
  buildSearchQuery,
  buildSourceAudioKey,
  buildStickyProxyUrl,
  chooseDownloadRecovery,
  classifyChannelTrust,
  classifyDownloadFailure,
  contentTypeForExt,
  createBotChallengeMeter,
  durationWithinTolerance,
  extractSourceAudioSha256,
  hasForeignVersionMarker,
  isBotChallengeStderr,
  isTopicChannel,
  logBotChallengeRecap,
  needsReenrichAfterCapture,
  normalizeChannelName,
  normalizeSearchQuery,
  noteBotChallenge,
  pickCandidate,
  rankCandidates,
  rerollSessionId,
  shouldReenrichAfterCapture,
  verifyCaptureFile,
} from "./capture-sweep";
// The REAL /status strain detector, imported rather than re-implemented: since #994 this
// sweep's stderr is teed into the marker and scored by these two functions, so the only
// honest way to pin the wording contract is to run the real lines through them.
import { countDistressLines, countSummaryStrain } from "./fluncle-healthcheck";

describe("capture sweep canonical counters", () => {
  const source = readFileSync(new URL("./capture-sweep.ts", import.meta.url), "utf8");

  test("counts the attempted batch, successful captures, and continued item failures", () => {
    const summary = buildCaptureSummary({
      batch: 4,
      botChallenges: 2,
      botChallengesUncleared: 1,
      counts: { done: 2, failed: 1, skipped: 0, unmatched: 1 },
      elapsedMs: 123,
    });

    expect(summary).toMatchObject({
      checked: 4,
      done: 2,
      errors: 0,
      failed: 1,
      produced: 2,
    });
  });

  test("preserves a measured empty batch as checked:0", () => {
    const summary = buildCaptureSummary({
      batch: 0,
      botChallenges: 0,
      botChallengesUncleared: 0,
      counts: { done: 0, failed: 0, skipped: 0, unmatched: 0 },
      elapsedMs: 1,
    });

    expect(summary.checked).toBe(0);
    expect(summary.produced).toBe(0);
  });

  test("never launders the bounded page length or limit into queue_depth", () => {
    expect(source).not.toMatch(/queue_depth\s*:\s*(?:queue\.length|QUEUE_LIMIT)\b/);
  });

  test("omits queue_depth rather than scanning the unindexed capture predicate every tick", () => {
    // `countTrackWork(kind=capture)` scans the growing tracks table and pulls in findings via
    // `f.log_id`; unlike embed, capture has no covering partial queue index. A hot-path scan is
    // not an acceptable price for this gauge, so absence is the contract until an operator-owned
    // index is proven on hosted Turso.
    const summary = buildCaptureSummary({
      batch: 1,
      botChallenges: 0,
      botChallengesUncleared: 0,
      counts: { done: 1, failed: 0, skipped: 0, unmatched: 0 },
      elapsedMs: 1,
    });

    expect(summary).not.toHaveProperty("queue_depth");
    expect(source).not.toMatch(/\bqueue_depth\s*:/);
    expect(source).not.toContain("fetchCaptureQueueDepth");
    expect(source).not.toContain("kind=capture&scope=all&count=true");
  });

  test("configuration and fatal failures are run errors with honest item counts", () => {
    expect(buildCaptureConfigFailureSummary("missing_api_token")).toMatchObject({
      checked: 0,
      errors: 1,
      failed: 0,
      produced: 0,
    });
    expect(buildCaptureFatalSummary(new Error("queue unavailable"))).toMatchObject({
      checked: null,
      errors: 1,
      failed: null,
      produced: null,
    });
  });
});

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

describe("normalizeSearchQuery — the ASCII fold for the ladder's third rung", () => {
  test("folds typographic apostrophes and hyphens to ASCII", () => {
    expect(normalizeSearchQuery("Ownglow Won’t U")).toBe("Ownglow Won't U");
    expect(normalizeSearchQuery("NC‐17 Trioxin")).toBe("NC-17 Trioxin");
  });

  test("strips intra-token dots and colons (S.P.Y, Nu:Tone, goddard.)", () => {
    expect(normalizeSearchQuery("S.P.Y By Your Side")).toBe("SPY By Your Side");
    expect(normalizeSearchQuery("Nu:Tone Tides")).toBe("NuTone Tides");
    expect(normalizeSearchQuery("goddard. Way Up")).toBe("goddard Way Up");
  });

  test("maps & to a space and collapses the result", () => {
    expect(normalizeSearchQuery("Optiv & BTK Zero Tolerance")).toBe("Optiv BTK Zero Tolerance");
  });

  test("leaves a plain ASCII query untouched", () => {
    expect(normalizeSearchQuery("Technimatic Mirror Image")).toBe("Technimatic Mirror Image");
  });
});

describe("hasForeignVersionMarker — a finding's own version never de-ranks its candidates", () => {
  test("a remix finding keeps its remix candidates clean", () => {
    expect(
      hasForeignVersionMarker("By Your Side (Logistics remix)", "By Your Side (Logistics remix)"),
    ).toBe(false);
  });

  test("a marker the finding does NOT carry still flags the candidate", () => {
    expect(hasForeignVersionMarker("Song (live at Fabric)", "Song")).toBe(true);
    expect(hasForeignVersionMarker("Song (instrumental)", "Song (remix)")).toBe(true);
  });

  test("a clean candidate is never flagged, with or without a finding title", () => {
    expect(hasForeignVersionMarker("Mirror Image", "Mirror Image")).toBe(false);
    expect(hasForeignVersionMarker("Mirror Image", undefined)).toBe(false);
  });

  test("marker matching is case-insensitive both ways", () => {
    expect(hasForeignVersionMarker("Song (REMIX)", "Song (remix)")).toBe(false);
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

describe("isBotChallengeStderr — the IP-reputation verdict, classified apart from DRM/403", () => {
  test("matches every observed challenge phrasing from the box journal", () => {
    expect(
      isBotChallengeStderr(
        "ERROR: [youtube] tup6Bgf8oQw: Sign in to confirm you\u2019re not a bot. Use --cookies-from-browser",
      ),
    ).toBe(true);
    expect(
      isBotChallengeStderr("ERROR: [youtube] L_qSTRTRULU: Please sign in. Use --cookies"),
    ).toBe(true);
    expect(isBotChallengeStderr("confirm you're not a bot")).toBe(true);
  });

  test("never fires on DRM, plain 403s, or dead videos — those keep their own handling", () => {
    expect(isBotChallengeStderr("ERROR: this video is DRM protected")).toBe(false);
    expect(isBotChallengeStderr("HTTP Error 403: Forbidden")).toBe(false);
    expect(isBotChallengeStderr("ERROR: [youtube] TpUSlHUoivc: This video is not available")).toBe(
      false,
    );
    expect(isBotChallengeStderr("")).toBe(false);
  });
});

describe("classifyDownloadFailure — the flags the recovery decision runs on", () => {
  test("anchors the 403 to the two forms yt-dlp actually prints", () => {
    expect(
      classifyDownloadFailure("ERROR: unable to download: HTTP Error 403: Forbidden").is403,
    ).toBe(true);
    expect(classifyDownloadFailure("giving up after 3 retries (status code 403)").is403).toBe(true);
  });

  test("a bare 403 ANYWHERE in stderr is no longer a 403 verdict", () => {
    // The regression this fixes: `\b403\b` matched a video id, a byte count, a URL — and the
    // download handler tested `is403` first, so such a line stole the branch.
    expect(
      classifyDownloadFailure("ERROR: [youtube] x403abc: This video is unavailable").is403,
    ).toBe(false);
    expect(classifyDownloadFailure("[download] 403 bytes written").is403).toBe(false);
  });

  test("still classifies the plain challenge and the DRM/bot-wall recoverability", () => {
    const flags = classifyDownloadFailure(
      "ERROR: [youtube] tup6Bgf8oQw: Sign in to confirm you're not a bot",
    );

    expect(flags.isBotChallenge).toBe(true);
    expect(flags.isRecoverable).toBe(true);
    expect(flags.is403).toBe(false);
  });
});

describe("chooseDownloadRecovery — the challenge is asked about BEFORE the 403", () => {
  // THE COMBINED SHAPE, and the reason this slice exists. A missing PO token makes yt-dlp
  // print the bot challenge AND a 403 in the same stderr (yt-dlp wiki). Under the old order
  // the 403 branch won and spent the run on a player-client fallback that cannot clear an
  // IP-reputation ruling — the re-roll went unused on exactly the runs that needed it.
  const COMBINED_STDERR = [
    "ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you're not a bot. Use --cookies-from-browser",
    "ERROR: unable to download video data: HTTP Error 403: Forbidden",
  ].join("\n");

  test("a combined challenge+403 stderr takes the RE-ROLL, not the player-client fallback", () => {
    const flags = classifyDownloadFailure(COMBINED_STDERR);

    // Both markers really are present — the test would pass vacuously otherwise.
    expect(flags.isBotChallenge).toBe(true);
    expect(flags.is403).toBe(true);

    expect(chooseDownloadRecovery(flags, true)).toBe("reroll");
  });

  test("with the run's one re-roll spent, the combined case falls back to the 403 branch", () => {
    // Nothing better is left to try: the fallback is a worse answer than a fresh exit, not a
    // wrong one, so it keeps its second chance rather than throwing the candidate away.
    expect(chooseDownloadRecovery(classifyDownloadFailure(COMBINED_STDERR), false)).toBe(
      "player-client-fallback",
    );
  });

  test("a plain 403 with no challenge still takes the fallback, re-roll available or not", () => {
    const flags = classifyDownloadFailure("ERROR: unable to download: HTTP Error 403: Forbidden");

    expect(chooseDownloadRecovery(flags, true)).toBe("player-client-fallback");
    expect(chooseDownloadRecovery(flags, false)).toBe("player-client-fallback");
  });

  test("a plain challenge re-rolls once and then gives the candidate up", () => {
    const flags = classifyDownloadFailure("ERROR: [youtube] abc: Please sign in. Use --cookies");

    expect(chooseDownloadRecovery(flags, true)).toBe("reroll");
    expect(chooseDownloadRecovery(flags, false)).toBe("give-up");
  });

  test("anything else rethrows to the candidate walk", () => {
    expect(chooseDownloadRecovery(classifyDownloadFailure("ERROR: DRM protected"), true)).toBe(
      "give-up",
    );
  });
});

// ── THE BOT-CHALLENGE METER + ITS STRAIN CONTRACT ────────────────────────────────────────
//
// Two claims are pinned here, and the second one is pinned with the REAL detector rather than
// by reasoning about the vocabulary:
//
//   1. EVERY challenge is counted. The re-roll fires at most once per track-run, and the log
//      line used to live inside that guard — so the 610 lines two days of box output produced
//      were "runs that hit their FIRST challenge", a floor, and no instrument could tell an
//      operator whether a change to the challenge rate worked.
//   2. The wording each line carries is what `countDistressLines` scores. A re-rolled
//      challenge is recoverable friction on a healthy tick (~12% of runs) and must score
//      ZERO — at that rate a scoring line means a `degraded` that can never clear. A
//      challenge with the re-roll already spent is real distress and must score.

/** Run something that logs, and score its REAL stderr with the REAL /status detector. */
function withCapturedStderr(run: () => void): { lines: string[]; strain: number } {
  const lines: string[] = [];
  const original = console.error;

  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };

  try {
    run();
  } finally {
    console.error = original;
  }

  return { lines, strain: countDistressLines(lines.join("\n")) };
}

describe("noteBotChallenge — the count", () => {
  test("counts a challenge whether or not a re-roll was available", () => {
    const meter = createBotChallengeMeter();

    withCapturedStderr(() => {
      noteBotChallenge(meter, "search", true);
      noteBotChallenge(meter, "download", false);
      noteBotChallenge(meter, "download", false);
    });

    // The old shape would have recorded ONE of these three — only the line that re-rolled.
    expect(meter.total).toBe(3);
    expect(meter.uncleared).toBe(2);
  });

  test("says WHERE it happened and WHETHER it re-rolled, so a line is self-explaining", () => {
    const { lines } = withCapturedStderr(() => {
      noteBotChallenge(createBotChallengeMeter(), "search", true);
      noteBotChallenge(createBotChallengeMeter(), "download", false);
    });

    expect(lines[0]).toContain("at search");
    expect(lines[0]).toContain("rerolled=true");
    expect(lines[1]).toContain("at download");
    expect(lines[1]).toContain("rerolled=false");
  });

  test("a meter that saw nothing emits no recap at all", () => {
    const { lines } = withCapturedStderr(() => {
      logBotChallengeRecap(createBotChallengeMeter());
    });

    expect(lines).toEqual([]);
  });

  test("the recap reports the split an operator needs to judge a fix", () => {
    const meter = createBotChallengeMeter();
    meter.total = 7;
    meter.uncleared = 2;

    const { lines } = withCapturedStderr(() => {
      logBotChallengeRecap(meter);
    });

    expect(lines[0]).toContain("bot challenges this tick: 7");
    expect(lines[0]).toContain("5 cleared by a re-roll");
    expect(lines[0]).toContain("2 with the re-roll spent");
  });
});

describe("what the sweep's challenge logs say to the /status strain detector", () => {
  test("a RE-ROLLED challenge reads as ZERO strain — recoverable friction on a healthy tick", () => {
    // ~12% of runs hit one. If this line scored, capture would sit at roughly 76 noisy points
    // every 6h: `degraded` forever, with no condition anyone could fix. The hyphen is the whole
    // mechanism — "bot challenge", never the STRAIN_PHRASES entry "bot-challenged".
    const { lines, strain } = withCapturedStderr(() => {
      noteBotChallenge(createBotChallengeMeter(), "search", true);
      noteBotChallenge(createBotChallengeMeter(), "download", true);
    });

    expect(lines).toHaveLength(2);
    expect(strain).toBe(0);
  });

  test("a challenge with the re-roll SPENT does score — nothing is left to swap onto", () => {
    const { strain } = withCapturedStderr(() => {
      noteBotChallenge(createBotChallengeMeter(), "download", false);
    });

    expect(strain).toBeGreaterThan(0);
  });

  test("a whole busy-but-healthy tick stays under the strain dial", () => {
    // Twelve captures, every one of them challenged once and every challenge cleared, plus
    // the recap. This is the steady state the two-day sample measured; it must read clean.
    const meter = createBotChallengeMeter();
    const { strain } = withCapturedStderr(() => {
      for (let i = 0; i < 12; i += 1) {
        noteBotChallenge(meter, i % 2 === 0 ? "search" : "download", true);
      }
      logBotChallengeRecap(meter);
    });

    expect(meter.total).toBe(12);
    expect(strain).toBe(0);
  });

  test("the per-tick recap never accrues strain, even reporting uncleared challenges", () => {
    // The recap is present on every challenged tick. A recap that scored would turn a known
    // steady state into a permanent `degraded`, and the per-line signal already counted the
    // uncleared ones — scoring here would double-count them too.
    const meter = createBotChallengeMeter();
    meter.total = 40;
    meter.uncleared = 9;

    expect(withCapturedStderr(() => logBotChallengeRecap(meter)).strain).toBe(0);
  });

  test("the new summary counters are not strain counters either", () => {
    // `countSummaryStrain` scores a marker's JSON summary. Publishing the challenge RATE must
    // not be the same thing as reporting failure — the keys are deliberately outside
    // STRAIN_COUNTER_KEYS (`errors` / `failed` / `gateSkipped`).
    expect(
      countSummaryStrain({
        batch: 4,
        botChallenges: 31,
        botChallengesUncleared: 6,
        done: 4,
        ok: true,
      }),
    ).toBe(0);
  });
});

describe("rerollSessionId — one fresh sticky exit per run", () => {
  test("derives a deterministic .r1 sibling that SURVIVES the session sanitizer", () => {
    const rerolled = rerollSessionId("038.6.1J");

    expect(rerolled).toBe("038.6.1J.r1");

    // Composed through the real URL builder: the `.r1` marker must reach the proxy's
    // username (the sanitizer keeps alnum + `.`), or the "fresh exit" is silently the
    // same exit and the retry re-fails.
    const url = buildStickyProxyUrl({
      host: "proxy.example",
      password: "pw",
      port: "823",
      sessionId: rerolled,
      username: "user",
    });

    expect(url).toContain("__sessid.038.6.1J.r1");
  });

  test("a catalogue row's mb_<uuid> id re-rolls to a DIFFERENT session than its base", () => {
    const base = "mb_206b56cc-02eb-403f-9a6c-78c915247e2a";
    const strip = (value: string) => value.replace(/[^0-9A-Za-z.]/g, "");

    expect(strip(rerollSessionId(base))).not.toBe(strip(base));
  });
});

describe("captureSessionSeed — retry runs rotate off the flagged exit", () => {
  test("a clean first run keeps the historic bare-id seed (byte-identical happy path)", () => {
    expect(captureSessionSeed("047.0.8M", 0)).toBe("047.0.8M");
  });

  test("each retry run seeds a distinct .a<failures> session", () => {
    expect(captureSessionSeed("047.0.8M", 1)).toBe("047.0.8M.a1");
    expect(captureSessionSeed("047.0.8M", 2)).toBe("047.0.8M.a2");
    expect(captureSessionSeed("047.0.8M", 1)).not.toBe(captureSessionSeed("047.0.8M", 2));
  });

  test("the .a namespace never collides with the in-run .r1 re-roll sessions", () => {
    // Run 0 burns <id> and (re-rolled) <id>.r1; run 1 must start on neither.
    const run0 = ["047.0.8M", rerollSessionId("047.0.8M")];
    const run1Base = captureSessionSeed("047.0.8M", 1);

    expect(run0).not.toContain(run1Base);
    expect(run0).not.toContain(rerollSessionId(run1Base));
  });

  test("the .a marker SURVIVES the session sanitizer through the real URL builder", () => {
    const url = buildStickyProxyUrl({
      host: "proxy.example",
      password: "pw",
      port: "823",
      sessionId: captureSessionSeed("mb_206b56cc-02eb-403f-9a6c-78c915247e2a", 3),
      username: "user",
    });

    expect(url).toContain(".a3");
  });
});

describe("the accepted upload's id rides the success PATCH", () => {
  const source = readFileSync(new URL("./capture-sweep.ts", import.meta.url), "utf8");

  test("the success update carries youtubeVideoId, taken from the candidate that WON", () => {
    // The sweep is the only place that knows which upload the fingerprint gate accepted; before
    // this it remembered only the ids it REJECTED. `candidate.candidate.id` is the winner in scope
    // at that point — the same value the rejection memory stores on a mismatch a few lines up.
    expect(source).toContain("update.youtubeVideoId = candidate.candidate.id");
  });

  test("only a REAL match reports an id — the abstain path stays silent", () => {
    // `verification` is `unverified` when the track had no preview reference: the bytes were kept
    // on duration and ranking alone and nothing was compared. The identity envelope serves this id
    // under `method: "fingerprint"`, so an id from the abstain path would put "matched by audio
    // fingerprint" on a page under a match that never ran. The assignment is therefore gated on
    // the verdict itself, not merely on reaching the success branch.
    expect(source).toMatch(
      /if \(verdict === "match"\) \{\s*update\.youtubeVideoId = candidate\.candidate\.id;/,
    );
  });

  test("only the SUCCESS path reports an id — never the unmatched or failed patches", () => {
    // An id is provenance for audio Fluncle actually kept. A walk that stored nothing has no
    // upload to attribute, and a failed one never got that far.
    const unmatched = source.slice(source.indexOf('captureStatus: "unmatched"'));
    const failed = source.slice(source.indexOf('captureStatus: "failed"'));

    expect(unmatched.slice(0, 400)).not.toContain("youtubeVideoId");
    expect(failed.slice(0, 400)).not.toContain("youtubeVideoId");
  });

  test("the sweep never sends an officialness verdict — that is the server's call", () => {
    // A box sweep reports what it captured; it never grants permission for a link to be shown. The
    // oEmbed check lives in apps/web/src/lib/server/youtube-official.ts, behind the API boundary,
    // so a compromised or stale box can never promote a rip onto the page.
    expect(source).not.toContain("youtubeVideoOfficial");
    expect(source).not.toContain("youtubeVerifiedAt");
    expect(source).not.toContain("oembed");
  });
});
