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
  metadataDurationAgrees,
  metadataIdentityMatch,
  METADATA_TOLERANCE_SEC,
  needsReenrichAfterCapture,
  normalizeChannelName,
  normalizeSearchQuery,
  noteBotChallenge,
  pickCandidate,
  pickSegmentCandidates,
  pickTopicCandidate,
  rankCandidates,
  rerollSessionId,
  shouldReenrichAfterCapture,
  splitProvenanceBudget,
  topicChannelArtist,
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
      provenance: { failed: 0, found: 0, none: 0 },
      reverdict: { asked: 0, failed: 0 },
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
      provenance: { failed: 0, found: 0, none: 0 },
      reverdict: { asked: 0, failed: 0 },
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
      provenance: { failed: 0, found: 0, none: 0 },
      reverdict: { asked: 0, failed: 0 },
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
//      ZERO — at that rate a scoring line means a `degraded` that can never clear. A challenge
//      with the re-roll already spent is item-failure evidence and scores only at a high rate
//      against the tick's real `checked` denominator.

/** Run something that logs, and score its REAL stderr with the REAL /status detector. */
function withCapturedStderr(
  run: () => void,
  checked: null | number = null,
): { lines: string[]; strain: number } {
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

  return { lines, strain: countDistressLines(lines.join("\n"), checked) };
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

  test("a challenge with the re-roll SPENT scores at a 1/1 item-failure rate", () => {
    const { strain } = withCapturedStderr(() => {
      noteBotChallenge(createBotChallengeMeter(), "download", false);
    }, 1);

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
    // The walk is the only place that knows which upload the fingerprint gate accepted; before
    // this it remembered only the ids it REJECTED. `accepted.videoId` is the winner the shared
    // ladder hands back — the same value the rejection memory would have stored on a mismatch.
    expect(source).toContain("update.youtubeVideoId = accepted.videoId");
  });

  test("only a REAL match reports an id — the abstain path stays silent", () => {
    // The verdict is `no-reference` when the track had no preview reference: the bytes were kept
    // on duration and ranking alone and nothing was compared. The identity envelope serves this id
    // under `method: "fingerprint"`, so an id from the abstain path would put "matched by audio
    // fingerprint" on a page under a match that never ran. The assignment is therefore gated on
    // the verdict itself, not merely on reaching the success branch.
    expect(source).toMatch(
      /if \(accepted\.verdict === "match"\) \{\s*update\.youtubeVideoId = accepted\.videoId;/,
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
    // so a compromised or stale box can never promote a rip onto the page. The RE-VERDICT phase
    // does not weaken this: it sends a bare `youtubeReverdict: true` ask and carries no verdict.
    expect(source).not.toContain("youtubeVideoOfficial");
    expect(source).not.toContain("youtubeVerifiedAt");
    expect(source).not.toContain("oembed");
  });
});

describe("the PROVENANCE phase never touches a capture column", () => {
  const source = readFileSync(new URL("./capture-sweep.ts", import.meta.url), "utf8");
  // The phase's own body — from its entry point to the re-verdict phase that follows it. Everything
  // asserted below is about THIS slice, so a capture column elsewhere in the file cannot mask a
  // regression and cannot cause a false alarm either.
  const phase = source.slice(
    source.indexOf("async function proveTrackProvenance("),
    source.indexOf("// ── THE RE-VERDICT PHASE"),
  );

  test("the slice under test is real", () => {
    expect(phase.length).toBeGreaterThan(500);
    expect(phase).toContain("findVerifiedUpload");
  });

  test("THE RAIL — no capture column can leave this phase, so no row can regress", () => {
    // The pilot's verdict: a RE-CAPTURE replaced a finding's clean archived audio with a fan blend
    // that legitimately passed the fingerprint gate (a blend contains the original's preview
    // segment). The backfill is provenance-only for that reason, and this is the pin: not one of
    // the capture columns may appear anywhere in the phase's body.
    for (const column of [
      "sourceAudioKey",
      "captureStatus",
      "captureVerification",
      "captureVerifiedAt",
      "sourceAudioBytes",
      "sourceAudioCapturedAt",
      "sourceAudioAttemptedAt",
      "sourceAudioFailures",
      "enrichmentStatus",
    ]) {
      expect(phase).not.toContain(column);
    }
  });

  test("it never stores the candidate — no R2 put, and the file is deleted", () => {
    // The bytes exist only to be fingerprinted. `r2Put` is the archive's only door and this phase
    // does not go through it; the accepted file is removed the moment its verdict has been read.
    expect(phase).not.toContain("r2Put");
    expect(phase).toContain("rmSync(accepted.path, { force: true })");
  });

  test("it reports the id under its OWN verdict field, never capture's", () => {
    // `youtubeVerification` is the honest field for a sweep that matched and then discarded:
    // borrowing `captureVerification` would claim a capture that never happened.
    expect(phase).toContain('youtubeVerification: "preview-match"');
    expect(phase).toContain("youtubeVideoId: accepted.videoId");
  });

  test("a non-match is REPORTED, so the row is not re-bought every tick", () => {
    // Without this the worklist hands the same row back on the next tick and spends the same
    // download again, forever. The report stamps only `youtube_verified_at`, server-side.
    expect(phase).toContain('youtubeVerification: "no-match"');
    expect(phase).toMatch(/if \(!accepted \|\| accepted\.verdict !== "match"\)/);
  });

  test("a transient failure writes NOTHING at all", () => {
    // Not even the no-match stamp: a proxy hiccup is not an answer, and burning the re-ask window
    // on one would cost the row months for a reason that had nothing to do with the row.
    const failurePath = phase.slice(phase.indexOf("} catch (error) {"));

    expect(failurePath).not.toContain("patchTrack");
  });

  test("it runs the SHARED ladder, never a second copy of it", () => {
    // A parallel walk would drift, and the thing it would drift on is the identity gate that keeps
    // wrong audio out of the archive. Exactly one implementation exists, and both callers use it.
    expect(source.match(/async function findVerifiedUpload\(/g)).toHaveLength(1);
    expect(source.match(/verifyCaptureFile\(previewFp/g)).toHaveLength(1);
    expect(source.match(/const attempts = filterRejectedCandidates\(/g)).toHaveLength(1);
  });

  test("it never feeds its OWN archived sha to the known-bad backstop", () => {
    // `source_audio_key` means opposite things to the two callers, and this is the trap. On a
    // CAPTURE it appears only on a wrong-audio re-capture, so its embedded sha is known-BAD. On
    // THIS queue every row has a key by definition and that sha is the GOOD audio the archive
    // holds — the upload the original capture came from. Feeding it in would blacklist the single
    // most likely correct candidate on nearly every row, silently, and the backfill would report
    // `no-match` for recordings whose id was sitting right there. So the walk never reads the key
    // itself: the CAPTURE caller passes it, and this one deliberately does not.
    // The phase's CALL passes exactly four options, and `legacyRejectKey` is not among them.
    expect(phase).toContain("findVerifiedUpload({ dir, finding: row, memory, session })");
    expect(phase).not.toContain("legacyRejectKey:");
    // The capture path, which is where the key genuinely IS known-bad, still passes it.
    expect(source).toContain("legacyRejectKey: finding.sourceAudioKey");
    // …and the walk reads it from the OPTIONS, never off the row.
    expect(source).toContain("extractSourceAudioSha256(options.legacyRejectKey)");
    expect(source).not.toContain("extractSourceAudioSha256(finding.sourceAudioKey)");
  });

  test("it reads the bad-audio memory and never writes it back", () => {
    // Reading saves money (a known-bad candidate never costs proxy bytes twice); writing would be
    // a capture column, so a rejection this phase pays for is deliberately not remembered.
    expect(phase).toContain("parseRejectedSources(row.sourceAudioRejected)");
    expect(phase).not.toContain("sourceAudioRejected:");
  });
});

describe("the provenance phase's tick budget", () => {
  test("the catalogue sub-cap can never RAISE the tick's total spend", () => {
    // It redirects budget the findings did not use; it is not an extra allowance. A cap set above
    // the total is clamped to it, so no combination of env values buys more than `total` rows.
    expect(splitProvenanceBudget(2, 0)).toEqual({ catalogue: 0, findings: 2 });
    expect(splitProvenanceBudget(2, 1)).toEqual({ catalogue: 1, findings: 2 });
    expect(splitProvenanceBudget(2, 99)).toEqual({ catalogue: 2, findings: 2 });
  });

  test("the shipped default keeps the catalogue at ZERO — the operator opens it deliberately", () => {
    expect(splitProvenanceBudget(2, 0).catalogue).toBe(0);
  });

  test("a zeroed or nonsense budget spends nothing rather than defaulting to something", () => {
    expect(splitProvenanceBudget(0, 5)).toEqual({ catalogue: 0, findings: 0 });
    expect(splitProvenanceBudget(Number.NaN, Number.NaN)).toEqual({ catalogue: 0, findings: 0 });
    expect(splitProvenanceBudget(-3, -3)).toEqual({ catalogue: 0, findings: 0 });
  });
});

describe("the provenance and re-verdict phases ride the tick without distorting it", () => {
  const source = readFileSync(new URL("./capture-sweep.ts", import.meta.url), "utf8");

  test("both phases run AFTER the capture batch and cannot abort the tick", () => {
    const main = source.slice(source.indexOf("async function main("));
    const batchEnd = main.indexOf("Array.from({ length: Math.min(CONCURRENCY");
    const provenanceAt = main.indexOf("runProvenancePhase(botChallenges)");

    expect(provenanceAt).toBeGreaterThan(batchEnd);
    // Caught, not thrown: a backfill that could abort the tick could hide a capture that succeeded.
    expect(main).toContain("runProvenancePhase(botChallenges).catch(");
    expect(main).toContain("runReverdictPhase().catch(");
  });

  test("the phases report their OWN counters, never the capture gauges /status reads as a rate", () => {
    const summary = buildCaptureSummary({
      batch: 4,
      botChallenges: 0,
      botChallengesUncleared: 0,
      counts: { done: 4, failed: 0, skipped: 0, unmatched: 0 },
      elapsedMs: 1,
      provenance: { failed: 2, found: 1, none: 3 },
      reverdict: { asked: 5, failed: 1 },
    });

    // The capture gauges are untouched by a busy — or a failing — backfill.
    expect(summary).toMatchObject({ checked: 4, errors: 0, failed: 0, produced: 4 });
    expect(summary).toMatchObject({
      provenanceFailed: 2,
      provenanceFound: 1,
      provenanceNone: 3,
      reverdictAsked: 5,
      reverdictFailed: 1,
    });
  });

  test("the re-verdict ask carries no verdict — the box paces, the server rules", () => {
    const phase = source.slice(source.indexOf("async function runReverdictPhase("));

    expect(phase).toContain("youtubeReverdict: true");
    expect(phase).not.toContain("checkYoutubeOfficial");
    expect(phase).not.toContain("author_name");
  });
});
describe("flat search extraction — one seventh of the bytes, on every search there will ever be", () => {
  const source = readFileSync(new URL("./capture-sweep.ts", import.meta.url), "utf8");

  test("the search asks for the LISTING, not five resolutions of it", () => {
    // `--flat-playlist` returns the search page's own entries. The measured cost is 139KB against
    // 968KB for the resolving shape, and it applies to every capture and every provenance search.
    expect(source).toContain('...(FLAT_SEARCH ? ["--flat-playlist"] : [])');
    // Behind an env knob so the operator can revert to the historic shape with no re-bake, and ON
    // unless he says otherwise.
    expect(source).toContain(
      'const FLAT_SEARCH = (process.env.FLUNCLE_CAPTURE_FLAT_SEARCH ?? "1") !== "0"',
    );
  });

  test("the printed field set is UNCHANGED — a flat entry already carries all six", () => {
    // The ranker reads duration, id, channel, channel_id, channel_is_verified and title. If flat
    // extraction had cost any one of them this switch would have been a downgrade, not a saving.
    expect(source).toContain(
      "%(duration)s\\t%(id)s\\t%(channel)s\\t%(channel_id)s\\t%(channel_is_verified)s\\t%(title)s",
    );
  });

  test("THE CEIL IS ABSORBED — the guard is max(3s, 3%) and a flat duration rounds UP by at most 1s", () => {
    // The one thing flat extraction loses: a listed duration is the CEIL of the rendered length
    // (+1s on ~47% of ids measured 2026-08-01). The capture guard's floor is three whole seconds,
    // so a one-second ceil cannot move a candidate across it in either direction.
    const targetMs = 217_000;

    // The exact length, and the same length ceiled — both still inside the guard.
    expect(durationWithinTolerance(217, targetMs)).toBe(true);
    expect(durationWithinTolerance(218, targetMs)).toBe(true);
    // …and a candidate that was ALREADY near the edge is not tipped out by the ceil either, because
    // 3% of a 217s track is 6.5s and the ceil spends one of them.
    expect(durationWithinTolerance(223, targetMs)).toBe(true);
    // The guard still refuses a genuinely different length. The ceil buys no slack it should not.
    expect(durationWithinTolerance(260, targetMs)).toBe(false);
  });

  test("FULL RESOLUTION still happens, for the ONE candidate that wins", () => {
    // Flat extraction changes what a SEARCH costs and nothing about what a download does: the
    // download fetches `watch?v=<id>` per id exactly as it always did, and the duration that
    // decides anything is ffprobe'd off the real file rather than read from any listing.
    expect(source).toContain("`https://www.youtube.com/watch?v=${videoId}`");
    expect(source).toContain("const realDurationSec = probeDurationSec(file.path)");
  });
});

describe("the metadata gate — artist, title and length, and nothing else", () => {
  const row = { artists: ["Netsky"], durationMs: 217_000, title: "Rio" };

  test("the tolerance is a FLAT 3s, not the capture guard's max(3s, 3%)", () => {
    // Nothing decides identity properly after this gate, so it is tighter than the pre-fingerprint
    // filter: ±3s absolute, whatever the track's length. On a 217s track the capture guard would
    // allow 6.5s, and this one does not.
    expect(METADATA_TOLERANCE_SEC).toBe(3);
    expect(metadataDurationAgrees(220, 217_000)).toBe(true);
    expect(metadataDurationAgrees(221, 217_000)).toBe(false);
    expect(durationWithinTolerance(221, 217_000)).toBe(true);
  });

  test("±3s and NOT ±2s — the flat ceil and a whole-second length each want one", () => {
    // ~70% of catalogue durations are whole-second MusicBrainz values, so the stored length is
    // already ±1s of the master; the flat listing's ceil spends another. ±2s would leave nothing
    // for the second of those and would refuse correct art tracks for arithmetic reasons.
    expect(metadataDurationAgrees(219, 217_000)).toBe(true);
    expect(metadataDurationAgrees(215, 217_000)).toBe(true);
  });

  test("a missing or zero length abstains — there is nothing to agree with", () => {
    expect(metadataDurationAgrees(217, undefined)).toBe(false);
    expect(metadataDurationAgrees(217, 0)).toBe(false);
    expect(metadataDurationAgrees(0, 217_000)).toBe(false);
  });

  test("FORM A — the bare title on the artist's own Topic channel", () => {
    expect(
      metadataIdentityMatch(
        { channel: "Netsky - Topic", durationSec: 217, id: "a", title: "Rio" },
        row,
      ),
    ).toBe("channel");
  });

  test("FORM B — `Artist - Title` carried in the title itself", () => {
    expect(
      metadataIdentityMatch(
        { channel: "Some Uploader", durationSec: 217, id: "b", title: "Netsky - Rio" },
        row,
      ),
    ).toBe("title");
  });

  test("a trailing version parenthetical folds away on BOTH sides", () => {
    // "Original Mix" is a neutral descriptor in the house fold, so it is not part of the identity
    // and the two titles are the same recording with or without it.
    expect(
      metadataIdentityMatch(
        { channel: "Netsky - Topic", durationSec: 217, id: "c", title: "Rio (Original Mix)" },
        row,
      ),
    ).toBe("channel");
    expect(
      metadataIdentityMatch(
        { channel: "Netsky - Topic", durationSec: 217, id: "d", title: "Rio" },
        { ...row, title: "Rio (Original Mix)" },
      ),
    ).toBe("channel");
  });

  test("A REMIX IS A DIFFERENT RECORDING — the descriptor must appear on both sides", () => {
    // The whole reason the fold compares base AND descriptor. Serving the original under a remix's
    // id (or the reverse) is exactly the wrong-version failure a duration guard cannot see.
    expect(
      metadataIdentityMatch(
        { channel: "Netsky - Topic", durationSec: 217, id: "e", title: "Rio (Calibre Remix)" },
        row,
      ),
    ).toBeNull();
    expect(
      metadataIdentityMatch(
        { channel: "Netsky - Topic", durationSec: 217, id: "f", title: "Rio" },
        { ...row, title: "Rio (Calibre Remix)" },
      ),
    ).toBeNull();
  });

  test("a name the row is NOT credited to is refused, on either side", () => {
    // The same title at the same length by somebody else is the case this gate exists to catch.
    expect(
      metadataIdentityMatch(
        { channel: "Camo & Krooked - Topic", durationSec: 217, id: "g", title: "Rio" },
        row,
      ),
    ).toBeNull();
    expect(
      metadataIdentityMatch(
        { channel: "Some Uploader", durationSec: 217, id: "h", title: "Hybrid Minds - Rio" },
        row,
      ),
    ).toBeNull();
  });

  test("the credit test is a SUBSET, so a split credit and an `&` name both pass", () => {
    // A track credited to two artists lives on the primary's Topic channel, and "Chase & Status"
    // folds into two names on BOTH sides at once. Equality would refuse each of those wrongly.
    expect(
      metadataIdentityMatch(
        { channel: "Netsky - Topic", durationSec: 217, id: "i", title: "Rio" },
        { ...row, artists: ["Netsky", "Metrik"] },
      ),
    ).toBe("channel");
    expect(
      metadataIdentityMatch(
        { channel: "Chase & Status - Topic", durationSec: 217, id: "j", title: "Rio" },
        { ...row, artists: ["Chase & Status"] },
      ),
    ).toBe("channel");
  });

  test("a row with no title or no credited artist can prove nothing", () => {
    expect(
      metadataIdentityMatch(
        { channel: "Netsky - Topic", durationSec: 217, id: "k", title: "Rio" },
        { artists: ["Netsky"] },
      ),
    ).toBeNull();
    expect(
      metadataIdentityMatch(
        { channel: "Netsky - Topic", durationSec: 217, id: "l", title: "Rio" },
        { artists: [], title: "Rio" },
      ),
    ).toBeNull();
  });

  test("a hyphen INSIDE a word is never mistaken for the artist separator", () => {
    // "Nu:Tone" and "NC-17" are one token. The separator is spaced on both sides for that reason.
    expect(topicChannelArtist("Nu:Tone - Topic")).toBe("Nu:Tone");
    expect(
      metadataIdentityMatch(
        { channel: "Some Uploader", durationSec: 180, id: "m", title: "NC-17" },
        { artists: ["Netsky"], durationMs: 180_000, title: "NC-17" },
      ),
    ).toBeNull();
  });
});

describe("RUNG 1 — the Topic art track, served on metadata alone", () => {
  const row = { artists: ["Netsky", "Metrik"], durationMs: 217_000, title: "Rio" };

  test("a Topic candidate that clears the gate is the pick", () => {
    const pick = pickTopicCandidate(
      [{ channel: "Netsky - Topic", durationSec: 217, id: "topic", title: "Rio" }],
      row,
    );

    expect(pick?.id).toBe("topic");
  });

  test("a NON-Topic candidate is never served here, however well it folds", () => {
    // There is no channel authority among fan re-ups, so metadata alone cannot settle one. That
    // candidate belongs to rung 2, which buys 30 seconds and listens.
    expect(
      pickTopicCandidate(
        [{ channel: "DnB Uploads", durationSec: 217, id: "fan", title: "Netsky - Rio" }],
        row,
      ),
    ).toBeNull();
  });

  test("a Topic candidate at the WRONG length is refused — the gate is all three signals", () => {
    expect(
      pickTopicCandidate(
        [{ channel: "Netsky - Topic", durationSec: 260, id: "long", title: "Rio" }],
        row,
      ),
    ).toBeNull();
  });

  test("AMBIGUITY — the primary artist's channel wins a split credit", () => {
    // A split credit puts the same delivered master on each credited artist's channel. Every tie
    // the 2026-08-01 spike saw was that, so the preference is the row's PRIMARY artist.
    const pick = pickTopicCandidate(
      [
        { channel: "Metrik - Topic", durationSec: 217, id: "secondary", title: "Rio" },
        { channel: "Netsky - Topic", durationSec: 217, id: "primary", title: "Rio" },
      ],
      row,
    );

    expect(pick?.id).toBe("primary");
  });

  test("a residual tie takes the closest length rather than refusing to answer", () => {
    // The remaining candidates are the same recording; picking between two of the same recording
    // is not a decision that can be got wrong, and abstaining would cost the row its id for nothing.
    const pick = pickTopicCandidate(
      [
        { channel: "Metrik - Topic", durationSec: 219, id: "far", title: "Rio" },
        { channel: "Metrik - Topic", durationSec: 217, id: "near", title: "Rio" },
      ],
      { ...row, artists: ["Someone Else", "Metrik"] },
    );

    expect(pick?.id).toBe("near");
  });
});

describe("RUNG 2 — the non-Topic candidates that have to be listened to", () => {
  const row = { artists: ["Netsky"], durationMs: 217_000, title: "Rio" };
  const candidates = [
    { channel: "Netsky - Topic", durationSec: 217, id: "topic", title: "Rio" },
    { channel: "DnB Uploads", durationSec: 219, id: "fan-far", title: "Netsky - Rio" },
    { channel: "Rips", durationSec: 217, id: "fan-near", title: "Netsky - Rio" },
    { channel: "Noise", durationSec: 217, id: "other", title: "Hybrid Minds - Rio" },
  ];

  test("only the non-Topic hits, closest length first", () => {
    expect(pickSegmentCandidates(candidates, row, new Set(), 5).map(({ id }) => id)).toEqual([
      "fan-near",
      "fan-far",
    ]);
  });

  test("a candidate the bad-audio memory already disproved never costs a byte", () => {
    expect(
      pickSegmentCandidates(candidates, row, new Set(["fan-near"]), 5).map(({ id }) => id),
    ).toEqual(["fan-far"]);
  });

  test("the attempt budget caps the walk — a third candidate is money, not evidence", () => {
    expect(pickSegmentCandidates(candidates, row, new Set(), 1).map(({ id }) => id)).toEqual([
      "fan-near",
    ]);
    expect(pickSegmentCandidates(candidates, row, new Set(), 0)).toEqual([]);
  });
});

describe("THE CATALOGUE LADDER never buys a whole song", () => {
  const source = readFileSync(new URL("./capture-sweep.ts", import.meta.url), "utf8");
  // The ladder's own body — from its section header to the provenance phase that follows it.
  const ladder = source.slice(
    source.indexOf("// ── THE CATALOGUE PROVENANCE LADDER"),
    source.indexOf("// ── THE PROVENANCE PHASE (operator ruling 2026-07-31)"),
  );

  test("the slice under test is real", () => {
    expect(ladder.length).toBeGreaterThan(1_000);
    expect(ladder).toContain("async function proveCatalogueProvenance(");
  });

  test("THE RAIL — no full download is reachable from this tier", () => {
    // The whole point of the cheap tier. A full download is ~6.5MB against a section's ~1.5MB, and
    // 30,672 of them is ~200GB of metered residential proxy. Neither the full-song downloader nor
    // the shared full-fingerprint walk may appear here.
    expect(ladder).not.toContain("runYtDownload");
    expect(ladder).not.toContain("findVerifiedUpload");
    // …and every download it DOES make is a section.
    expect(ladder).toContain("runYtSection(");
    expect(source).toContain('"--download-sections"');
  });

  test("it inherits the provenance rail — not one capture column leaves it", () => {
    // Same ruling as the phase below: a backfill that could move a capture column could replace a
    // finding's clean archived audio, which is the trade the pilot rejected.
    for (const column of [
      "captureStatus",
      "captureVerification",
      "captureVerifiedAt",
      "sourceAudioBytes",
      "sourceAudioCapturedAt",
      "sourceAudioAttemptedAt",
      "sourceAudioFailures",
      "enrichmentStatus",
    ]) {
      expect(ladder).not.toContain(column);
    }
    // `source_audio_key` is READ — it is where the archived reference lives — and never written.
    expect(ladder).toContain("row.sourceAudioKey");
    expect(ladder).not.toContain("sourceAudioKey:");
    expect(ladder).not.toContain("sourceAudioRejected:");
    expect(ladder).not.toContain("r2Put");
  });

  test("each rung reports its OWN verdict, so the receipt cannot overclaim", () => {
    // The Topic rung compared no audio, so it says so and the server renders the weaker sentence.
    expect(ladder).toContain('youtubeVerification: "metadata-match"');
    // The segment rung DID compare audio, against the archive rather than a preview.
    expect(ladder).toContain('youtubeVerification: "archive-match"');
    // Neither borrows the capture sweep's field, and the sweep never rules on officialness.
    expect(ladder).not.toContain("captureVerification");
    expect(ladder).not.toContain("youtubeVideoOfficial");
  });

  test("the reference is the row's own archive, which costs no vendor bandwidth", () => {
    expect(ladder).toContain("loadArchiveFingerprint(archiveKey, dir)");
    expect(ladder).toContain("slidingWindowMatch(archiveFp, sectionFp)");
  });

  test("AN EXHAUSTED ROW MOVES THE STREAK — it is never re-served forever", () => {
    // The ledger law. `no-match` stamps the re-ask window AND moves the can't-conclude streak;
    // `inconclusive` moves the streak alone, because a CDN refusal is not an answer and must not
    // burn the row's window — but a row that is refused forever must still stop being asked.
    expect(ladder).toContain('youtubeVerification: "no-match"');
    expect(ladder).toContain('youtubeVerification: "inconclusive"');
    // …and neither carries an id. A row concludes nothing, or it concludes with proof.
    const exhausted = ladder.slice(ladder.indexOf('youtubeVerification: "no-match"'));

    expect(exhausted.slice(0, 200)).not.toContain("youtubeVideoId");
  });

  test("a TRANSIENT failure moves the streak too — a search that never answers is the loop", () => {
    // The outcome most likely to repeat: a row whose query the proxy cannot answer gets no stamp,
    // comes straight back next tick, and holds the head of the queue forever. Reported rather than
    // swallowed, and the report is itself best-effort, because the thing that failed may be the API.
    const failurePath = ladder.slice(ladder.indexOf("} catch (error) {"));

    expect(failurePath).toContain('youtubeVerification: "inconclusive"');
    expect(failurePath).toContain(".catch(");
  });

  test("a DEFERRED row is not written to at all", () => {
    // The segment budget ran out under it. It concluded nothing, cost nothing, and is asked again
    // next tick; stamping it would spend a 90-day window on a queue position.
    expect(ladder).toContain("deferred = true");
    expect(ladder).toMatch(
      /if \(deferred\) \{\s*counts\.deferred \+= 1;\s*\n\s*return "deferred";/,
    );
  });
});

describe("the catalogue tier's budget accounting", () => {
  const source = readFileSync(new URL("./capture-sweep.ts", import.meta.url), "utf8");
  const phase = source.slice(source.indexOf("async function runProvenancePhase("));

  test("SEGMENT DOWNLOADS respect the operator's limit strictly", () => {
    // `PROVENANCE_CATALOGUE_LIMIT` is still THE knob and it now meters downloads: one shared
    // counter, decremented per section, checked before every one.
    expect(phase).toContain("const segmentBudget = { segments: catalogueRoom }");
    expect(source).toContain("budget.segments -= 1");
    expect(source).toContain("if (budget.segments <= 0)");
  });

  test("SEARCHES are budgeted generously — they are 139KB, not the bandwidth", () => {
    // Most rows conclude on rung 1 for the price of a search, so metering rows at the download's
    // rate would throw the cheap tier's whole point away.
    expect(phase).toContain(
      "limit: catalogueRoom * Math.max(1, Math.trunc(PROVENANCE_SEARCH_FACTOR) || 1)",
    );
    expect(source).toContain('process.env.FLUNCLE_CAPTURE_PROVENANCE_SEARCH_FACTOR ?? "5"');
  });

  test("the shipped default still keeps the catalogue DARK", () => {
    // Unchanged: the ladder exists, and it spends nothing until the operator opens the sub-cap.
    expect(source).toContain('process.env.FLUNCLE_CAPTURE_PROVENANCE_CATALOGUE_LIMIT ?? "0"');
    expect(splitProvenanceBudget(2, 0).catalogue).toBe(0);
  });

  test("the FINDINGS tier keeps the full fingerprint — the cheap ladder is catalogue-only", () => {
    expect(phase).toContain("proveTrackProvenance(row, meter)");
    expect(phase).toContain('scope: "findings"');
    expect(phase).toContain("proveCatalogueProvenance(row, meter, segmentBudget, ladder)");
  });

  test("a deferral is not folded into the phase's outcome gauges", () => {
    expect(phase).toContain('if (outcome !== "deferred")');
  });

  test("the ladder's per-rung tally rides the tick summary", () => {
    const summary = buildCaptureSummary({
      batch: 0,
      botChallenges: 0,
      botChallengesUncleared: 0,
      counts: { done: 0, failed: 0, skipped: 0, unmatched: 0 },
      elapsedMs: 1,
      ladder: {
        deferred: 1,
        exhausted: 4,
        residualRescued: 2,
        searched: 30,
        segmentMissed: 3,
        segmentVerified: 2,
        topicServed: 7,
      },
      provenance: { failed: 0, found: 9, none: 4 },
      reverdict: { asked: 0, failed: 0 },
    });

    expect(summary).toMatchObject({
      provenanceFound: 9,
      provenanceLadderDeferred: 1,
      provenanceLadderExhausted: 4,
      provenanceLadderResidualRescued: 2,
      provenanceLadderSearched: 30,
      provenanceLadderSegmentMissed: 3,
      provenanceLadderSegmentVerified: 2,
      provenanceLadderTopicServed: 7,
    });
  });

  test("a tick with no ladder work reports zeroes, never absent keys", () => {
    // The catalogue budget is shut by default, so this is the shape an operator reads every night.
    const summary = buildCaptureSummary({
      batch: 1,
      botChallenges: 0,
      botChallengesUncleared: 0,
      counts: { done: 1, failed: 0, skipped: 0, unmatched: 0 },
      elapsedMs: 1,
      provenance: { failed: 0, found: 0, none: 0 },
      reverdict: { asked: 0, failed: 0 },
    });

    expect(summary).toMatchObject({ provenanceLadderSearched: 0, provenanceLadderTopicServed: 0 });
  });
});
