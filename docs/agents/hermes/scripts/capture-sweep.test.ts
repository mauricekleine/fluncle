import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorizeTrackCapture,
  commitTrackCapture,
} from "../../../../packages/contracts/src/orpc/admin-tracks";
import {
  bpmIsMissing,
  buildCaptureConfigFailureSummary,
  buildCaptureDownloadUrl,
  buildCaptureFatalSummary,
  buildCaptureSearchLadder,
  buildCaptureSearchTarget,
  buildCaptureSummary,
  CAPTURE_BLIND_MIN_ATTEMPTS,
  captureBlindVerdict,
  captureCommitRequest,
  captureCommitRequestFromState,
  captureSessionSeed,
  classifyCaptureFailure,
  filterRejectedCandidates,
  buildSearchQuery,
  buildSourceAudioKey,
  buildStickyProxyUrl,
  chooseDownloadRecovery,
  classifyChannelTrust,
  classifyDownloadFailure,
  contentTypeForExt,
  createBotChallengeMeter,
  createCaptureFailureMeter,
  DEFAULT_QUERY_VARIANTS,
  durationWithinTolerance,
  extractSourceAudioSha256,
  finishProgress,
  findFirstRankedCaptureRung,
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
  noteCaptureFailure,
  pickCandidate,
  pickSegmentCandidates,
  pickTopicCandidate,
  persistAndCommit,
  preparedCaptureFinding,
  protectedTrackIdsFromRecovery,
  rankCandidates,
  receiptCoordinatesFrom,
  recoverCaptureProgress,
  rerollSessionId,
  runJournaledCaptureProvider,
  shouldReenrichAfterCapture,
  splitProvenanceBudget,
  topicChannelArtist,
  verifyCaptureFile,
  verifyCaptureFileDetailed,
  withoutProtectedTracks,
  writeJsonAtomic,
  type CaptureFinding,
  type CaptureProgress,
  type CaptureProgressPorts,
  type LadderPorts,
  type PinnedUploadPorts,
  type ProxySession,
  type ReceiptCoordinates,
  type RejectedMemory,
  type YtCandidate,
  CAPTURE_ADMISSION_ACTIONS,
  captureProviderCompletion,
  captureVerificationFor,
  findConsensus,
  findPinnedUpload,
  findVerifiedUpload,
  isCaptureAdmissionAction,
  isPinnedDurationRefusal,
} from "./capture-sweep";
import { mutualWindowMatch } from "./fingerprint-match";

import { countDistressLines, countSummaryStrain } from "./fluncle-healthcheck";
import {
  type CollectedCaptureCommit,
  DEFAULT_CAPTURE_BATCH_CAP,
  isDeferredOutcome,
  MAX_CAPTURE_BATCH_CAP,
  parseCaptureCapabilities,
  prepareTickSnapshots,
  resolveCaptureBatchCap,
  resolveDeferredOutcome,
  settleCollectedCommits,
  summariseItemTiming,
} from "./capture-sweep";

describe("capture sweep canonical counters", () => {
  const source = readFileSync(new URL("./capture-sweep.ts", import.meta.url), "utf8");

  test("counts the attempted batch, successful captures, and continued item failures", () => {
    const summary = buildCaptureSummary({
      batch: 4,
      botChallenges: 2,
      botChallengesUncleared: 1,
      counts: { done: 2, failed: 1, skipped: 0, unmatched: 1 },
      elapsedMs: 123,
      failures: {
        failureRecording: 1,
        proxy: 1,
        r2: 0,
        trackUpdate: 0,
        unknown: 0,
        ytDlp: 0,
      },
      provenance: { failed: 0, found: 0, none: 0 },
      reverdict: { asked: 0, failed: 0 },
      writes: { confirmed: 4, failed: 1, pending: 0 },
    });

    expect(summary).toMatchObject({
      checked: 4,
      done: 2,
      errors: 0,
      failed: 1,
      failureRecordingFailures: 1,
      produced: 2,
      proxyFailures: 1,
      r2Failures: 0,
      trackUpdateFailures: 0,
      unknownFailures: 0,
      ytDlpFailures: 0,
    });
  });

  test("classifies a proxy-credit wall before the enclosing yt-dlp command", () => {
    const meter = createCaptureFailureMeter();
    const wall =
      "yt-dlp search failed: ERROR: query page 1: Unable to download API page: ('Unable to connect to proxy', OSError('Tunnel connection failed: 407 TRAFFIC_EXHAUSTED'))";

    expect(classifyCaptureFailure(new Error(wall))).toBe("proxy");
    expect(noteCaptureFailure(meter, new Error(wall))).toBe("proxy");
    expect(meter).toEqual({
      failureRecording: 0,
      proxy: 1,
      r2: 0,
      trackUpdate: 0,
      unknown: 0,
      ytDlp: 0,
    });
  });

  test("keeps the other acquisition doors distinct", () => {
    expect(classifyCaptureFailure(new Error("yt-dlp download failed: unavailable"))).toBe("yt-dlp");
    expect(classifyCaptureFailure(new Error("R2 PUT key failed (403): denied"))).toBe("r2");
    expect(classifyCaptureFailure(new Error("update_track track failed (500): no"))).toBe(
      "track-update",
    );
    expect(classifyCaptureFailure(new Error("ffprobe exploded"))).toBe("unknown");
  });

  test("counts a failed failure-recording write independently of the acquisition door", () => {
    const captureFindingSource = source.slice(
      source.indexOf("async function captureFinding"),
      source.indexOf("export type ProvenanceLadderCounts ="),
    );

    expect(captureFindingSource).toContain("noteCaptureFailure(failures, error);");
    expect(captureFindingSource).toContain('if (failureDisposition === "failed")');
    expect(captureFindingSource).toContain("failures.failureRecording += 1;");

    expect(captureFindingSource).toContain('captureOutcomeFor(failureDisposition, "failed")');
    expect(source).toContain('return disposition === "failed" ? "unrecorded-failure" : "pending";');
  });

  test("separates confirmed, failed, and pending reconciliation outcomes", () => {
    const summary = buildCaptureSummary({
      batch: 5,
      botChallenges: 0,
      botChallengesUncleared: 0,
      counts: { done: 1, failed: 1, pending: 2, rejected: 1, skipped: 0, unmatched: 1 },
      elapsedMs: 1,
      failures: {
        failureRecording: 1,
        proxy: 0,
        r2: 0,
        trackUpdate: 0,
        unknown: 0,
        ytDlp: 0,
      },
      provenance: { failed: 1, found: 1, none: 1, pending: 2 },
      reverdict: { asked: 1, failed: 1, pending: 1 },
      writes: { confirmed: 6, failed: 4, pending: 5 },
    });

    expect(summary).toMatchObject({
      capturePending: 2,
      captureRejected: 1,
      failureRecordingFailures: 1,
      provenancePending: 2,
      reverdictPending: 1,
      writesConfirmed: 6,
      writesFailed: 4,
      writesPending: 5,
    });
    expect(source).toContain('return "failed-recorded"');
    expect(source).toContain('return "failed-write"');
    expect(source).toContain("writesConfirmed:");
    expect(source).toContain("writesPending:");
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
      writes: { confirmed: 0, failed: 0, pending: 0 },
    });

    expect(summary.checked).toBe(0);
    expect(summary.produced).toBe(0);
  });

  test("never launders the bounded page length or limit into queue_depth", () => {
    expect(source).not.toMatch(/queue_depth\s*:\s*(?:queue\.length|QUEUE_LIMIT)\b/);
  });

  test("omits queue_depth rather than scanning the unindexed capture predicate every tick", () => {
    const summary = buildCaptureSummary({
      batch: 1,
      botChallenges: 0,
      botChallengesUncleared: 0,
      counts: { done: 1, failed: 0, skipped: 0, unmatched: 0 },
      elapsedMs: 1,
      provenance: { failed: 0, found: 0, none: 0 },
      reverdict: { asked: 0, failed: 0 },
      writes: { confirmed: 1, failed: 0, pending: 0 },
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

  test("a fatal invocation reports errors:1 and exits non-zero", async () => {
    const proc = Bun.spawn(
      [
        process.execPath,
        new URL("./capture-sweep.ts", import.meta.url).pathname,
        "--admission-phase",
        "invalid",
      ],
      { stderr: "pipe", stdout: "pipe" },
    );
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      errors: 1,
      failed: null,
      ok: false,
      reason: "capture_failed",
    });
  });
});

describe("capture reconciliation durability and admission boundaries", () => {
  const receipt: ReceiptCoordinates = {
    commitToken: "commit-token",
    operationId: "track.capture",
    operationKey: "track.capture:receipt",
    requestDigest: "a".repeat(64),
  };

  function progressFile(directory: string): string {
    return join(directory, `${"b".repeat(64)}.json`);
  }

  function ports(
    directory: string,
    overrides: Partial<CaptureProgressPorts> = {},
  ): CaptureProgressPorts {
    return {
      admittedPhase: () => {
        throw new Error("unexpected admitted phase");
      },
      authorizeProgress: async () => {
        throw new Error("unexpected authorization");
      },
      prepareCurrentSnapshot: () => {
        throw new Error("unexpected snapshot refresh");
      },
      progressPath: () => progressFile(directory),
      r2Exists: async () => true,
      r2Put: async () => {
        throw new Error("unexpected R2 PUT");
      },
      ...overrides,
    };
  }

  function writePhaseResult(path: string, value: unknown): void {
    writeFileSync(`${path}.result`, JSON.stringify(value));
  }

  function receiptResolution(
    outcome: "committed" | "in-progress" | "not-found" | "rejected",
  ): Record<string, unknown> {
    if (outcome === "not-found") {
      return {
        ok: true,
        receipt: {
          createdAt: null,
          operationId: null,
          outcome,
          resultIdentity: null,
          state: null,
          terminalAt: null,
          updatedAt: null,
        },
      };
    }
    const state = outcome === "in-progress" ? "accepted" : outcome;
    return {
      ok: true,
      receipt: {
        createdAt: "2026-09-08T10:00:00.000Z",
        operationId: receipt.operationId,
        outcome,
        resultIdentity: outcome === "in-progress" ? null : "capture-result",
        state,
        terminalAt: outcome === "in-progress" ? null : "2026-09-08T10:00:01.000Z",
        updatedAt: "2026-09-08T10:00:01.000Z",
      },
    };
  }

  function committedResolution(
    kind: "capture" | "youtube-provenance" | "youtube-reverdict",
    outcome:
      | "done"
      | "failed"
      | "none"
      | "reverdict"
      | "source-found"
      | "unmatched"
      | "youtube-found",
  ): Record<string, unknown> {
    return {
      ok: true,
      outcome: "committed",
      replayed: false,
      result: { applied: true, kind, outcome },
    };
  }

  test("fsync-backed atomic journals retain private file and directory modes", () => {
    const directory = mkdtempSync(join(tmpdir(), "capture-progress-"));
    const path = progressFile(directory);
    try {
      chmodSync(directory, 0o755);
      writeJsonAtomic(path, { acceptedBytes: "exact" });

      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ acceptedBytes: "exact" });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("an interruption before the first billed request leaves a protected durable intent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "capture-progress-"));
    const path = progressFile(directory);
    let providerCalls = 0;
    try {
      let failure: unknown;
      try {
        await runJournaledCaptureProvider({
          beforeProvider: () => {
            throw new Error("simulated process stop before provider dispatch");
          },
          finding: { title: "Intent", trackId: "track-1" },
          kind: "capture",
          progressPath: () => path,
          provider: async () => {
            providerCalls += 1;
            return null;
          },
          snapshotToken: "snapshot-token",
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ message: "simulated process stop before provider dispatch" });
      expect(providerCalls).toBe(0);
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
        attempt: { kind: "capture", state: "provider-intent" },
        trackId: "track-1",
      });

      const recovered = await recoverCaptureProgress(
        directory,
        ports(directory, {
          prepareCurrentSnapshot: () => ({
            prepared: true,
            snapshotToken: "fresh-snapshot-token",
            track: { artists: [], certified: false, title: "Intent", trackId: "track-1" },
          }),
        }),
      );
      expect(recovered).toMatchObject([
        { disposition: "pending", progress: { trackId: "track-1" } },
      ]);
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
        attempt: { state: "provider-ambiguous" },
      });
      expect(providerCalls).toBe(0);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("an interruption after provider completion records the provable local download without replay", async () => {
    const directory = mkdtempSync(join(tmpdir(), "capture-progress-"));
    const path = progressFile(directory);
    let providerCalls = 0;
    try {
      let failure: unknown;
      try {
        await runJournaledCaptureProvider({
          afterProvider: () => {
            throw new Error("simulated process stop before result persistence");
          },
          finding: { title: "Downloaded", trackId: "track-1" },
          kind: "capture",
          progressPath: () => path,
          provider: async (workDirectory) => {
            providerCalls += 1;
            expect(existsSync(path)).toBe(true);
            writeFileSync(join(workDirectory, "audio.webm"), "completed provider bytes");
            return { outcome: "downloaded" as const };
          },
          snapshotToken: "snapshot-token",
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        message: "simulated process stop before result persistence",
      });
      expect(providerCalls).toBe(1);

      const recovered = await recoverCaptureProgress(
        directory,
        ports(directory, {
          prepareCurrentSnapshot: () => ({
            prepared: true,
            snapshotToken: "fresh-snapshot-token",
            track: { artists: [], certified: false, title: "Downloaded", trackId: "track-1" },
          }),
        }),
      );
      expect(recovered).toMatchObject([{ disposition: "pending" }]);
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
        attempt: {
          localDownload: {
            bytes: Buffer.byteLength("completed provider bytes"),
            fileName: "audio.webm",
          },
          state: "local-download-present",
        },
      });
      expect(providerCalls).toBe(1);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("a durably completed provider result reconciles from its local file without rebuying", async () => {
    const directory = mkdtempSync(join(tmpdir(), "capture-progress-"));
    const path = progressFile(directory);
    const audio = "completed provider bytes";
    const digest = createHash("sha256").update(audio).digest("hex");
    let providerCalls = 0;
    let authorizationCalls = 0;
    try {
      await runJournaledCaptureProvider({
        completion: (_value, _workDirectory) => ({
          completedAt: "2026-09-08T10:00:00.000Z",
          digest,
          ext: "webm",
          fileName: "audio.webm",
          outcome: "accepted",
          source: "youtube",
          verdict: "match",
          videoId: "video-1",
        }),
        finding: { logId: "099.9.9Z", title: "Downloaded", trackId: "track-1" },
        kind: "capture",
        progressPath: () => path,
        provider: async (workDirectory) => {
          providerCalls += 1;
          writeFileSync(join(workDirectory, "audio.webm"), audio);
          return { outcome: "downloaded" as const };
        },
        snapshotToken: "snapshot-token",
      });

      const recovered = await recoverCaptureProgress(
        directory,
        ports(directory, {
          admittedPhase: (action, statePath) => {
            expect(action).toBe("commit");
            writePhaseResult(statePath, committedResolution("capture", "done"));
            return "completed";
          },
          authorizeProgress: async (progress) => {
            authorizationCalls += 1;
            expect(progress.result).toMatchObject({
              kind: "capture",
              outcome: "done",
              youtubeVideoId: "video-1",
            });
            return { ...progress, receipt };
          },
          prepareCurrentSnapshot: () => ({
            prepared: true,
            snapshotToken: "fresh-snapshot-token",
            track: { artists: [], certified: false, title: "Downloaded", trackId: "track-1" },
          }),
        }),
      );
      expect(recovered).toMatchObject([{ disposition: "committed" }]);
      expect(providerCalls).toBe(1);
      expect(authorizationCalls).toBe(1);
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("provenance uses the same durable intent and completed result recovery", async () => {
    const directory = mkdtempSync(join(tmpdir(), "capture-progress-"));
    const path = progressFile(directory);
    let providerCalls = 0;
    try {
      await runJournaledCaptureProvider({
        completion: () => ({
          completedAt: "2026-09-08T10:00:00.000Z",
          outcome: "none",
        }),
        finding: { title: "Provenance", trackId: "track-1" },
        kind: "youtube-provenance",
        progressPath: () => path,
        provider: async () => {
          providerCalls += 1;
          return null;
        },
        snapshotToken: "snapshot-token",
      });

      expect(
        await finishProgress(
          path,
          ports(directory, {
            admittedPhase: (action, statePath) => {
              expect(action).toBe("commit");
              writePhaseResult(statePath, committedResolution("youtube-provenance", "none"));
              return "completed";
            },
            authorizeProgress: async (progress) => {
              expect(progress.result).toEqual({
                kind: "youtube-provenance",
                outcome: "none",
                verification: "no-match",
              });
              return { ...progress, receipt };
            },
            prepareCurrentSnapshot: (_trackId, kind) => {
              expect(kind).toBe("youtube-provenance");
              return {
                prepared: true,
                snapshotToken: "fresh-snapshot-token",
                track: {
                  artists: [],
                  certified: false,
                  title: "Provenance",
                  trackId: "track-1",
                },
              };
            },
          }),
        ),
      ).toBe("committed");
      expect(providerCalls).toBe(1);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("a known provider failure replaces the intent and settles through the normal receipt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "capture-progress-"));
    const path = progressFile(directory);
    try {
      let providerFailure: unknown;
      try {
        await runJournaledCaptureProvider({
          finding: { title: "Failure", trackId: "track-1" },
          kind: "capture",
          progressPath: () => path,
          provider: async () => {
            throw new Error("known provider failure");
          },
          snapshotToken: "snapshot-token",
        });
      } catch (error) {
        providerFailure = error;
      }
      expect(providerFailure).toMatchObject({ message: "known provider failure" });

      const testPorts = ports(directory, {
        admittedPhase: (action, statePath) => {
          expect(action).toBe("commit");
          writePhaseResult(statePath, committedResolution("capture", "failed"));
          return "completed";
        },
        authorizeProgress: async (progress) => ({ ...progress, receipt }),
      });
      expect(
        await persistAndCommit(
          "track-1",
          "snapshot-token",
          {
            attemptedAt: "2026-09-08T10:00:00.000Z",
            kind: "capture",
            outcome: "failed",
          },
          testPorts,
        ),
      ).toBe("committed");
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("a malformed prepare response keeps the provider intent pending", async () => {
    const directory = mkdtempSync(join(tmpdir(), "capture-progress-"));
    const path = progressFile(directory);
    try {
      let failure: unknown;
      try {
        await runJournaledCaptureProvider({
          beforeProvider: () => {
            throw new Error("stop after intent");
          },
          finding: { title: "Malformed prepare", trackId: "track-1" },
          kind: "capture",
          progressPath: () => path,
          provider: async () => null,
          snapshotToken: "snapshot-token",
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ message: "stop after intent" });

      expect(
        await finishProgress(
          path,
          ports(directory, {
            prepareCurrentSnapshot: () => ({}) as never,
          }),
        ),
      ).toBe("pending");
      expect(existsSync(path)).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
        attempt: { state: "provider-intent" },
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("a partial committed response cannot erase the result journal", async () => {
    const directory = mkdtempSync(join(tmpdir(), "capture-progress-"));
    const path = progressFile(directory);
    try {
      const testPorts = ports(directory, {
        admittedPhase: (action, statePath) => {
          expect(action).toBe("commit");
          writePhaseResult(statePath, { outcome: "committed" });
          return "completed";
        },
        authorizeProgress: async (progress) => ({ ...progress, receipt }),
      });
      expect(
        await persistAndCommit(
          "track-1",
          "snapshot-token",
          { kind: "youtube-reverdict", outcome: "reverdict" },
          testPorts,
        ),
      ).toBe("pending");
      expect(existsSync(path)).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
        receipt,
        result: { kind: "youtube-reverdict", outcome: "reverdict" },
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("R2 PUT followed by an admission yield restarts without repeated external work", async () => {
    const directory = mkdtempSync(join(tmpdir(), "capture-progress-"));
    const path = progressFile(directory);
    let objectExists = false;
    let authorizationCalls = 0;
    let puts = 0;
    const firstPorts = ports(directory, {
      admittedPhase: (action) => {
        expect(action).toBe("commit");
        return "yielded";
      },
      authorizeProgress: async (progress) => {
        authorizationCalls += 1;
        return { ...progress, receipt };
      },
      r2Exists: async () => objectExists,
      r2Put: async () => {
        puts += 1;
        objectExists = true;
      },
    });
    try {
      const result = {
        attemptedAt: "2026-09-08T10:00:00.000Z",
        bodyBase64: Buffer.from("accepted-audio").toString("base64"),
        bytes: Buffer.byteLength("accepted-audio"),
        captureVerification: "unverified" as const,
        capturedAt: "2026-09-08T10:00:00.000Z",
        contentType: "audio/opus",
        kind: "capture" as const,
        outcome: "done" as const,
        sourceAudioKey: `099.9.9Z/${"c".repeat(64)}.opus`,
        verifiedAt: "2026-09-08T10:00:00.000Z",
      };

      expect(await persistAndCommit("track-1", "snapshot-token", result, firstPorts)).toBe(
        "pending",
      );
      expect(existsSync(path)).toBe(true);

      const restartPorts = ports(directory, {
        admittedPhase: (action, statePath) => {
          expect(action).toBe("reconcile");
          writePhaseResult(statePath, receiptResolution("in-progress"));
          return "completed";
        },
        authorizeProgress: async () => {
          throw new Error("restart repeated authorization");
        },
        r2Exists: async () => {
          throw new Error("restart repeated R2 HEAD");
        },
      });
      expect(await finishProgress(path, restartPorts)).toBe("pending");
      expect(authorizationCalls).toBe(1);
      expect(puts).toBe(1);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("an unknown committed response resolves exactly once from its receipt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "capture-progress-"));
    const path = progressFile(directory);
    let authorizationCalls = 0;
    let reconciliations = 0;
    try {
      const firstPorts = ports(directory, {
        admittedPhase: (action, statePath) => {
          expect(action).toBe("commit");
          writePhaseResult(statePath, committedResolution("youtube-reverdict", "reverdict"));
          throw new Error("commit response lost");
        },
        authorizeProgress: async (progress) => {
          authorizationCalls += 1;
          return { ...progress, receipt };
        },
      });
      expect(
        await persistAndCommit(
          "track-1",
          "snapshot-token",
          { kind: "youtube-reverdict", outcome: "reverdict" },
          firstPorts,
        ),
      ).toBe("pending");

      const restartPorts = ports(directory, {
        admittedPhase: (action, statePath) => {
          expect(action).toBe("reconcile");
          reconciliations += 1;
          writePhaseResult(statePath, receiptResolution("committed"));
          return "completed";
        },
      });
      expect(await finishProgress(path, restartPorts)).toBe("committed");
      expect(authorizationCalls).toBe(1);
      expect(reconciliations).toBe(1);
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("a malformed receipt envelope stays pending without new authorization", async () => {
    const directory = mkdtempSync(join(tmpdir(), "capture-progress-"));
    const path = progressFile(directory);
    const progress: CaptureProgress = {
      receipt,
      result: { kind: "youtube-reverdict", outcome: "reverdict" },
      snapshotToken: "snapshot-token",
      trackId: "track-1",
    };
    let authorizationCalls = 0;
    try {
      writeJsonAtomic(path, progress);
      const testPorts = ports(directory, {
        admittedPhase: (action, statePath) => {
          expect(action).toBe("reconcile");
          writePhaseResult(statePath, { ok: true, receipt: { state: "committed" } });
          return "completed";
        },
        authorizeProgress: async (current) => {
          authorizationCalls += 1;
          return current;
        },
      });

      expect(await finishProgress(path, testPorts)).toBe("pending");
      expect(authorizationCalls).toBe(0);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(progress);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test.each([
    ["missing ok", (valid: Record<string, unknown>) => ({ receipt: valid.receipt })],
    ["ok false", (valid: Record<string, unknown>) => ({ ...valid, ok: false })],
    [
      "mismatched not-found coordinates",
      (valid: Record<string, unknown>) => ({
        ...valid,
        receipt: { ...(valid.receipt as Record<string, unknown>), operationId: "other.operation" },
      }),
    ],
  ])("a %s envelope carrying not-found cannot refresh authorization", async (_name, mutate) => {
    const directory = mkdtempSync(join(tmpdir(), "capture-progress-"));
    const path = progressFile(directory);
    const progress: CaptureProgress = {
      receipt,
      result: { kind: "youtube-reverdict", outcome: "reverdict" },
      snapshotToken: "snapshot-token",
      trackId: "track-1",
    };
    let authorizationCalls = 0;
    try {
      writeJsonAtomic(path, progress);
      const testPorts = ports(directory, {
        admittedPhase: (action, statePath) => {
          expect(action).toBe("reconcile");
          writePhaseResult(statePath, mutate(receiptResolution("not-found")));
          return "completed";
        },
        authorizeProgress: async (current) => {
          authorizationCalls += 1;
          return current;
        },
      });

      expect(await finishProgress(path, testPorts)).toBe("pending");
      expect(authorizationCalls).toBe(0);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(progress);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test.each([
    [
      "mismatched operation id",
      (valid: Record<string, unknown>) => ({
        ...valid,
        receipt: { ...(valid.receipt as Record<string, unknown>), operationId: "other.operation" },
      }),
    ],
    [
      "committed outcome with accepted state",
      (valid: Record<string, unknown>) => ({
        ...valid,
        receipt: {
          ...(valid.receipt as Record<string, unknown>),
          resultIdentity: null,
          state: "accepted",
          terminalAt: null,
        },
      }),
    ],
    [
      "terminal state without result identity",
      (valid: Record<string, unknown>) => ({
        ...valid,
        receipt: { ...(valid.receipt as Record<string, unknown>), resultIdentity: null },
      }),
    ],
  ])("a %s terminal receipt remains pending", async (_name, mutate) => {
    const directory = mkdtempSync(join(tmpdir(), "capture-progress-"));
    const path = progressFile(directory);
    const progress: CaptureProgress = {
      receipt,
      result: { kind: "youtube-reverdict", outcome: "reverdict" },
      snapshotToken: "snapshot-token",
      trackId: "track-1",
    };
    let authorizationCalls = 0;
    try {
      writeJsonAtomic(path, progress);
      const testPorts = ports(directory, {
        admittedPhase: (_action, statePath) => {
          writePhaseResult(statePath, mutate(receiptResolution("committed")));
          return "completed";
        },
        authorizeProgress: async (current) => {
          authorizationCalls += 1;
          return current;
        },
      });
      expect(await finishProgress(path, testPorts)).toBe("pending");
      expect(authorizationCalls).toBe(0);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(progress);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("malformed stored receipt coordinates cannot interpret a valid not-found response", async () => {
    const directory = mkdtempSync(join(tmpdir(), "capture-progress-"));
    const path = progressFile(directory);
    const progress: CaptureProgress = {
      receipt: { ...receipt, requestDigest: "not-a-digest" },
      result: { kind: "youtube-reverdict", outcome: "reverdict" },
      snapshotToken: "snapshot-token",
      trackId: "track-1",
    };
    let authorizationCalls = 0;
    try {
      writeJsonAtomic(path, progress);
      const testPorts = ports(directory, {
        admittedPhase: (_action, statePath) => {
          writePhaseResult(statePath, receiptResolution("not-found"));
          return "completed";
        },
        authorizeProgress: async (current) => {
          authorizationCalls += 1;
          return current;
        },
      });
      expect(await finishProgress(path, testPorts)).toBe("pending");
      expect(authorizationCalls).toBe(0);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(progress);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("only an explicit not-found receipt permits authorization refresh", async () => {
    const directory = mkdtempSync(join(tmpdir(), "capture-progress-"));
    const path = progressFile(directory);
    const progress: CaptureProgress = {
      receipt,
      result: { kind: "youtube-reverdict", outcome: "reverdict" },
      snapshotToken: "snapshot-token",
      trackId: "track-1",
    };
    let authorizationCalls = 0;
    try {
      writeJsonAtomic(path, progress);
      const testPorts = ports(directory, {
        admittedPhase: (action, statePath) => {
          if (action === "reconcile") {
            writePhaseResult(statePath, receiptResolution("not-found"));
          } else {
            expect(action).toBe("commit");
            writePhaseResult(statePath, committedResolution("youtube-reverdict", "reverdict"));
          }
          return "completed";
        },
        authorizeProgress: async (current) => {
          authorizationCalls += 1;
          return { ...current, receipt };
        },
      });

      expect(await finishProgress(path, testPorts)).toBe("committed");
      expect(authorizationCalls).toBe(1);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("a reconciliation transport failure preserves the known receipt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "capture-progress-"));
    const path = progressFile(directory);
    const progress: CaptureProgress = {
      receipt,
      result: { kind: "youtube-reverdict", outcome: "reverdict" },
      snapshotToken: "snapshot-token",
      trackId: "track-1",
    };
    try {
      writeJsonAtomic(path, progress);
      let failure: unknown;
      try {
        await finishProgress(
          path,
          ports(directory, {
            admittedPhase: () => {
              throw new Error("receipt reconciliation transport failure");
            },
          }),
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ message: "receipt reconciliation transport failure" });
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(progress);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("slow authorization runs while no database phase is active", async () => {
    const directory = mkdtempSync(join(tmpdir(), "capture-progress-"));
    const path = progressFile(directory);
    let databasePhaseActive = false;
    try {
      writeJsonAtomic(path, {
        result: { kind: "youtube-reverdict", outcome: "reverdict" },
        snapshotToken: "snapshot-token",
        trackId: "track-1",
      } satisfies CaptureProgress);
      const testPorts = ports(directory, {
        admittedPhase: (action, statePath) => {
          expect(databasePhaseActive).toBe(false);
          databasePhaseActive = true;
          expect(action).toBe("commit");
          writePhaseResult(statePath, committedResolution("youtube-reverdict", "reverdict"));
          databasePhaseActive = false;
          return "completed";
        },
        authorizeProgress: async (progress) => {
          expect(databasePhaseActive).toBe(false);
          await new Promise((resolve) => setTimeout(resolve, 5));
          expect(databasePhaseActive).toBe(false);
          return { ...progress, receipt };
        },
      });

      expect(await finishProgress(path, testPorts)).toBe("committed");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  function captureContractSchemas() {
    const commitInput = commitTrackCapture["~orpc"].inputSchema;
    const authorizeOutput = authorizeTrackCapture["~orpc"].outputSchema;
    if (!commitInput || !authorizeOutput) {
      throw new Error("the capture contracts declare a commit input and an authorize output");
    }
    return { authorizeOutput, commitInput };
  }

  const doneResult = {
    attemptedAt: "2026-09-08T10:00:00.000Z",
    bodyBase64: Buffer.from("audio").toString("base64"),
    bytes: 5,
    captureVerification: "preview-match",
    capturedAt: "2026-09-08T10:00:00.000Z",
    contentType: "audio/webm",
    kind: "capture",
    outcome: "done",
    sourceAudioKey: `001.0.0A/${"c".repeat(64)}.webm`,
    verifiedAt: "2026-09-08T10:00:00.000Z",
  } as const;

  test("a commit state carrying response-only keys rebuilds exactly the strict contract body", () => {
    const { commitInput } = captureContractSchemas();
    const journaled = { ...receipt, note: "response-only", ok: true, trackId: "track-1" };

    expect(commitInput.safeParse(journaled).success).toBe(false);
    const body = captureCommitRequestFromState(journaled);
    expect(body).toEqual({ ...receipt, trackId: "track-1" });
    expect(Object.keys(body ?? {}).sort()).toEqual(Object.keys(commitInput.shape).sort());
    expect(commitInput.safeParse(body).success).toBe(true);
  });

  test("authorize coordinates are the contract output without its envelope", () => {
    const { authorizeOutput, commitInput } = captureContractSchemas();
    const response = { ...receipt, ok: true };

    expect(authorizeOutput.safeParse(response).success).toBe(true);
    const coordinates = receiptCoordinatesFrom(response);
    expect(coordinates).toEqual(receipt);
    expect(Object.keys(coordinates ?? {}).sort()).toEqual(
      Object.keys(authorizeOutput.shape)
        .filter((key) => key !== "ok")
        .sort(),
    );
    expect(commitInput.safeParse(captureCommitRequest(receipt, "track-1")).success).toBe(true);
  });

  test("malformed coordinates never become a commit body", () => {
    const malformed: unknown[] = [
      "receipt",
      null,
      { ...receipt, operationId: "other.operation" },
      { ...receipt, commitToken: undefined },
      { ...receipt, requestDigest: "not-a-digest" },
    ];
    for (const value of malformed) {
      const state =
        typeof value === "object" && value !== null ? { ...value, trackId: "track-1" } : value;
      expect(receiptCoordinatesFrom(value)).toBeUndefined();
      expect(captureCommitRequestFromState(state)).toBeUndefined();
    }
    expect(captureCommitRequestFromState(receipt)).toBeUndefined();
    expect(captureCommitRequestFromState({ ...receipt, trackId: "" })).toBeUndefined();
  });

  test("an authorization carrying response-only keys journals and commits only contract fields", async () => {
    const directory = mkdtempSync(join(tmpdir(), "capture-progress-"));
    const path = progressFile(directory);
    const { commitInput } = captureContractSchemas();
    try {
      writeJsonAtomic(path, {
        result: doneResult,
        snapshotToken: "snapshot-token",
        trackId: "track-1",
      });
      const testPorts = ports(directory, {
        admittedPhase: (action, statePath) => {
          expect(action).toBe("commit");
          const body: unknown = JSON.parse(readFileSync(statePath, "utf8"));
          expect(body).toEqual({ ...receipt, trackId: "track-1" });
          expect(commitInput.safeParse(body).success).toBe(true);
          const journal = JSON.parse(readFileSync(path, "utf8")) as { receipt?: unknown };
          expect(journal.receipt).toEqual(receipt);
          writePhaseResult(statePath, committedResolution("capture", "done"));
          return "completed";
        },
        authorizeProgress: async (progress) => ({
          ...progress,
          receipt: { ...receipt, note: "response-only", ok: true } as ReceiptCoordinates,
        }),
      });

      expect(await finishProgress(path, testPorts)).toBe("committed");
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("a journal whose receipt carries the authorize envelope settles by commit, never by provider or storage work", async () => {
    const directory = mkdtempSync(join(tmpdir(), "capture-progress-"));
    const path = progressFile(directory);
    const { commitInput } = captureContractSchemas();
    const phases: string[] = [];
    let authorizations = 0;
    try {
      writeJsonAtomic(path, {
        receipt: { ...receipt, ok: true },
        result: doneResult,
        snapshotToken: "snapshot-token",
        trackId: "track-1",
      });
      writeJsonAtomic(`${path}.commit`, { ...receipt, ok: true, trackId: "track-1" });

      const testPorts = ports(directory, {
        admittedPhase: (action, statePath) => {
          phases.push(action);
          if (action === "reconcile") {
            expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
              operationId: receipt.operationId,
              operationKey: receipt.operationKey,
              requestDigest: receipt.requestDigest,
            });
            writePhaseResult(statePath, receiptResolution("not-found"));
            return "completed";
          }
          const body: unknown = JSON.parse(readFileSync(statePath, "utf8"));
          expect(body).toEqual({ ...receipt, trackId: "track-1" });
          expect(commitInput.safeParse(body).success).toBe(true);
          writePhaseResult(statePath, committedResolution("capture", "done"));
          return "completed";
        },
        authorizeProgress: async (progress) => {
          authorizations += 1;
          expect(progress.receipt).toBeUndefined();
          return { ...progress, receipt: { ...receipt, ok: true } as ReceiptCoordinates };
        },
      });

      expect(await finishProgress(path, testPorts)).toBe("committed");
      expect(phases).toEqual(["reconcile", "commit"]);
      expect(authorizations).toBe(1);
      expect(existsSync(path)).toBe(false);
      expect(existsSync(`${path}.commit`)).toBe(false);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("a stale commit child result is removed before a new admitted attempt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "capture-progress-"));
    const path = progressFile(directory);
    try {
      writeFileSync(`${path}.commit.result`, JSON.stringify({ outcome: "committed" }));
      const testPorts = ports(directory, {
        admittedPhase: (action) => {
          expect(action).toBe("commit");
          return "completed";
        },
        authorizeProgress: async (progress) => ({ ...progress, receipt }),
      });
      expect(
        await persistAndCommit(
          "track-1",
          "snapshot-token",
          { kind: "youtube-reverdict", outcome: "reverdict" },
          testPorts,
        ),
      ).toBe("pending");
      expect(existsSync(path)).toBe(true);
      expect(existsSync(`${path}.commit.result`)).toBe(false);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("a recovered pending journal protects capture, provenance, and re-verdict work", async () => {
    const directory = mkdtempSync(join(tmpdir(), "capture-progress-"));
    const path = progressFile(directory);
    const pending: CaptureProgress = {
      receipt,
      result: { kind: "youtube-reverdict", outcome: "reverdict" },
      snapshotToken: "snapshot-token",
      trackId: "protected-track",
    };
    try {
      writeJsonAtomic(path, pending);
      const recovered = await recoverCaptureProgress(
        directory,
        ports(directory, {
          admittedPhase: (_action, statePath) => {
            const response = receiptResolution("in-progress");
            writePhaseResult(statePath, {
              ...response,
              receipt: {
                ...(response.receipt as Record<string, unknown>),
                outcome: "future-outcome",
              },
            });
            return "completed";
          },
        }),
      );
      const protectedTrackIds = protectedTrackIdsFromRecovery(recovered);
      const offeredRows = [
        { title: "Protected", trackId: "protected-track" },
        { title: "Open", trackId: "open-track" },
      ];

      expect(recovered).toMatchObject([{ disposition: "pending" }]);
      for (const _kind of ["capture", "youtube-provenance", "youtube-reverdict"] as const) {
        expect(withoutProtectedTracks(offeredRows, protectedTrackIds)).toEqual([
          { title: "Open", trackId: "open-track" },
        ]);
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("provider work consumes the freshly prepared row rather than the older queue page", () => {
    const queued = {
      artists: ["Old name"],
      durationMs: 100,
      sourceAudioRejected: '[{"sha256":"old"}]',
      title: "Old title",
      trackId: "track-1",
    };
    const current = {
      artists: ["Current name"],
      certified: true,
      durationMs: 200,
      sourceAudioRejected: '[{"sha256":"old"},{"sha256":"new"}]',
      title: "Current title",
      trackId: "track-1",
    };

    expect(preparedCaptureFinding(queued, current)).toEqual(current);
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

describe("the shared capture search ladder", () => {
  const finding = {
    artists: ["Technimatic", "A Little Sound"],
    durationMs: 240_000,
    title: "Parallel (radio edit)",
  };

  test("the default slice keeps SoundCloud after every YouTube Music rung", () => {
    expect(DEFAULT_QUERY_VARIANTS).toBe(4);
    expect(buildCaptureSearchLadder(finding, DEFAULT_QUERY_VARIANTS)).toEqual([
      {
        query: "Technimatic A Little Sound Parallel (radio edit)",
        source: "youtube",
      },
      {
        query: "Technimatic A Little Sound Parallel (radio edit)",
        source: "music",
      },
      { query: "Technimatic Parallel", source: "music" },
      {
        query: "Technimatic A Little Sound Parallel (radio edit)",
        source: "soundcloud",
      },
    ]);
  });

  test("constructs ytsearch, YouTube Music, and scsearch targets", () => {
    expect(buildCaptureSearchTarget("youtube", "Netsky Rio")).toEqual(["ytsearch5:Netsky Rio"]);
    expect(buildCaptureSearchTarget("music", "Netsky Rio")).toEqual([
      "--playlist-items",
      "1:5",
      "https://music.youtube.com/search?q=Netsky%20Rio",
    ]);
    expect(buildCaptureSearchTarget("soundcloud", "Netsky Rio")).toEqual(["scsearch5:Netsky Rio"]);
  });

  test("builds a source-specific URL for the candidate download", () => {
    expect(buildCaptureDownloadUrl("youtube", "dQw4w9WgXcQ")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    expect(buildCaptureDownloadUrl("music", "dQw4w9WgXcQ")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    expect(buildCaptureDownloadUrl("soundcloud", "123998367")).toBe(
      "https://api.soundcloud.com/tracks/123998367",
    );
  });

  test("reaches SoundCloud only after all YouTube rungs return zero ranked survivors", () => {
    const visited: string[] = [];
    const rungs = buildCaptureSearchLadder(finding, DEFAULT_QUERY_VARIANTS);
    const found = findFirstRankedCaptureRung(rungs, finding, (rung) => {
      visited.push(rung.source);
      return [
        {
          durationSec: rung.source === "soundcloud" ? 240 : 30,
          id: rung.source,
          source: rung.source,
          title: "Parallel",
        },
      ];
    });

    expect(visited).toEqual(["youtube", "music", "music", "soundcloud"]);
    expect(found?.rung.source).toBe("soundcloud");
    expect(found?.ranked.map(({ candidate }) => candidate.id)).toEqual(["soundcloud"]);
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

  test("rejects a 30-second SoundCloud preview for a full-length track", () => {
    const ranked = rankCandidates(
      [
        {
          durationSec: 30,
          id: "soundcloud-preview",
          source: "soundcloud",
          title: "Some Song",
        },
      ],
      { durationMs: 240_000 },
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
    expect(verifyCaptureFile(null, "/nonexistent/audio.webm")).toBe("no-reference");
  });

  test("ABSTAINS when the capture cannot be fingerprinted (fpcalc absent / bad decode)", () => {
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

  test("a SoundCloud rate limit re-rolls the sticky session and remains recoverable", () => {
    const flags = classifyDownloadFailure(
      "ERROR: [soundcloud] 123998367: Unable to download JSON metadata: HTTP Error 429: Too Many Requests",
    );

    expect(flags.isBotChallenge).toBe(true);
    expect(flags.isRecoverable).toBe(true);
    expect(flags.is403).toBe(false);
    expect(chooseDownloadRecovery(flags, true, "soundcloud")).toBe("reroll");
    expect(chooseDownloadRecovery(flags, false, "soundcloud")).toBe("give-up");
  });

  test("SoundCloud geo-blocked and private tracks fall through to another candidate", () => {
    for (const stderr of [
      "ERROR: [soundcloud] 123: This track is not available in your country",
      "ERROR: [soundcloud] 456: This private track is not publicly available",
    ]) {
      const flags = classifyDownloadFailure(stderr);
      expect(flags.isBotChallenge).toBe(false);
      expect(flags.isRecoverable).toBe(true);
    }
  });
});

describe("chooseDownloadRecovery — the challenge is asked about BEFORE the 403", () => {
  const COMBINED_STDERR = [
    "ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you're not a bot. Use --cookies-from-browser",
    "ERROR: unable to download video data: HTTP Error 403: Forbidden",
  ].join("\n");

  test("a combined challenge+403 stderr takes the RE-ROLL, not the player-client fallback", () => {
    const flags = classifyDownloadFailure(COMBINED_STDERR);

    expect(flags.isBotChallenge).toBe(true);
    expect(flags.is403).toBe(true);

    expect(chooseDownloadRecovery(flags, true)).toBe("reroll");
  });

  test("with the run's one re-roll spent, the combined case falls back to the 403 branch", () => {
    expect(chooseDownloadRecovery(classifyDownloadFailure(COMBINED_STDERR), false)).toBe(
      "player-client-fallback",
    );
  });

  test("a plain 403 with no challenge still takes the fallback, re-roll available or not", () => {
    const flags = classifyDownloadFailure("ERROR: unable to download: HTTP Error 403: Forbidden");

    expect(chooseDownloadRecovery(flags, true)).toBe("player-client-fallback");
    expect(chooseDownloadRecovery(flags, false)).toBe("player-client-fallback");
  });

  test("a SoundCloud 403 never invokes the YouTube player-client fallback", () => {
    const flags = classifyDownloadFailure(
      "ERROR: [soundcloud] 123998367: Unable to download media: HTTP Error 403: Forbidden",
    );

    expect(flags.isRecoverable).toBe(false);
    expect(chooseDownloadRecovery(flags, true, "soundcloud")).toBe("give-up");
    expect(chooseDownloadRecovery(flags, false, "soundcloud")).toBe("give-up");
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
    const meter = createBotChallengeMeter();
    meter.total = 40;
    meter.uncleared = 9;

    expect(withCapturedStderr(() => logBotChallengeRecap(meter)).strain).toBe(0);
  });

  test("the new summary counters are not strain counters either", () => {
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

describe("the accepted upload's id rides the successful reconciliation", () => {
  const source = readFileSync(new URL("./capture-sweep.ts", import.meta.url), "utf8");

  test("only a REAL match reports an id — the abstain path stays silent", () => {
    expect(source).toMatch(
      /if \(accepted\.verdict === "match" && accepted\.source !== "soundcloud"\) \{\s*update\.youtubeVideoId = accepted\.videoId;/,
    );
    const captureFn = source.slice(
      source.indexOf("async function captureFinding("),
      source.indexOf("export type ProvenanceLadderCounts ="),
    );
    expect(captureFn.match(/update\.youtubeVideoId = accepted\.videoId;/g)).toHaveLength(1);
  });

  test("only the SUCCESS path reports an id — never unmatched or failed results", () => {
    const unmatched = source.slice(source.indexOf('captureStatus: "unmatched"'));
    const failed = source.slice(source.indexOf('captureStatus: "failed"'));

    expect(unmatched.slice(0, 400)).not.toContain("youtubeVideoId");
    expect(failed.slice(0, 400)).not.toContain("youtubeVideoId");
  });

  test("the sweep never sends an officialness verdict — that is the server's call", () => {
    expect(source).not.toContain("youtubeVideoOfficial");
    expect(source).not.toContain("youtubeVerifiedAt");
    expect(source).not.toContain("oembed");
  });
});

describe("the PROVENANCE phase never touches a capture column", () => {
  const source = readFileSync(new URL("./capture-sweep.ts", import.meta.url), "utf8");

  const phase = source.slice(
    source.indexOf("async function proveTrackProvenance("),
    source.indexOf("type ReverdictCounts ="),
  );

  test("the slice under test is real", () => {
    expect(phase.length).toBeGreaterThan(500);
    expect(phase).toContain("findVerifiedUpload");
  });

  test("THE RAIL — no capture column can leave this phase, so no row can regress", () => {
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
    expect(phase).not.toContain("r2Put");
    expect(phase).toContain("cleanupProviderWorkDirectory(attemptPath, workDirectory)");
  });

  test("it reports the id under its OWN verdict field, never capture's", () => {
    expect(phase).toContain('youtubeVerification: "preview-match"');
    expect(phase).toContain("youtubeVideoId: accepted.videoId");
  });

  test("a non-match is REPORTED, so the row is not re-bought every tick", () => {
    expect(phase).toContain('youtubeVerification: "no-match"');
    expect(phase).toMatch(/if \(!accepted \|\| accepted\.verdict !== "match"\)/);
  });

  test("a SoundCloud preview match banks its own evidence and returns before YouTube writes", () => {
    const soundcloud = phase.slice(
      phase.indexOf('if (accepted.source === "soundcloud")'),
      phase.indexOf('youtubeVerification: "preview-match"'),
    );

    expect(soundcloud).toContain('sourceVerification: "soundcloud-preview-match"');
    expect(soundcloud).toContain('return "found"');
    expect(soundcloud).not.toContain("youtubeVerification");
    expect(soundcloud).not.toContain("youtubeVideoId");
  });

  test("a known transient failure advances the bounded inconclusive streak", () => {
    const failurePath = phase.slice(phase.indexOf("} catch (error) {"));

    expect(failurePath).toContain('youtubeVerification: "inconclusive"');
  });

  test("it runs the SHARED ladder, never a second copy of it", () => {
    expect(source.match(/async function findVerifiedUpload\(/g)).toHaveLength(1);

    expect(
      source.match(/const verified = verifyCaptureFileDetailed\(previewFp, captureFingerprint\)/g),
    ).toHaveLength(1);
    expect(source.match(/const attempts = filterRejectedCandidates\(/g)).toHaveLength(1);
  });

  test("it never feeds its OWN archived sha to the known-bad backstop", () => {
    expect(phase).toContain(
      "findVerifiedUpload({ dir: directory, finding: row, memory, session })",
    );
    expect(phase).not.toContain("legacyRejectKey:");

    expect(source).toContain("legacyRejectKey: finding.sourceAudioKey");

    expect(source).toContain("extractSourceAudioSha256(options.legacyRejectKey)");
    expect(source).not.toContain("extractSourceAudioSha256(finding.sourceAudioKey)");
  });

  test("it reads the bad-audio memory and never writes it back", () => {
    expect(phase).toContain("parseRejectedSources(row.sourceAudioRejected)");
    expect(phase).not.toContain("sourceAudioRejected:");
  });
});

describe("the provenance phase's tick budget", () => {
  test("the catalogue sub-cap can never RAISE the tick's total spend", () => {
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
    const provenanceAt = main.indexOf("runProvenancePhase(botChallenges, protectedTrackIds)");

    expect(provenanceAt).toBeGreaterThan(batchEnd);

    expect(main).toContain("runProvenancePhase(botChallenges, protectedTrackIds).catch(");
    expect(main).toContain("runReverdictPhase(protectedTrackIds).catch(");
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
      writes: { confirmed: 13, failed: 1, pending: 0 },
    });

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

    expect(phase).toContain('kind: "youtube-reverdict"');
    expect(phase).toContain('outcome: "reverdict"');
    expect(phase).not.toContain("checkYoutubeOfficial");
    expect(phase).not.toContain("author_name");
  });
});
describe("flat search extraction — one seventh of the bytes, on every search there will ever be", () => {
  const source = readFileSync(new URL("./capture-sweep.ts", import.meta.url), "utf8");

  test("the search asks for the LISTING, not five resolutions of it", () => {
    expect(source).toContain('...(FLAT_SEARCH ? ["--flat-playlist"] : [])');

    expect(source).toContain(
      'const FLAT_SEARCH = (process.env.FLUNCLE_CAPTURE_FLAT_SEARCH ?? "1") !== "0"',
    );
  });

  test("the printed field set is UNCHANGED — a flat entry already carries all six", () => {
    expect(source).toContain(
      "%(duration)s\\t%(id)s\\t%(channel)s\\t%(channel_id)s\\t%(channel_is_verified)s\\t%(title)s",
    );
  });

  test("THE CEIL IS ABSORBED — the guard is max(3s, 3%) and a flat duration rounds UP by at most 1s", () => {
    const targetMs = 217_000;

    expect(durationWithinTolerance(217, targetMs)).toBe(true);
    expect(durationWithinTolerance(218, targetMs)).toBe(true);

    expect(durationWithinTolerance(223, targetMs)).toBe(true);

    expect(durationWithinTolerance(260, targetMs)).toBe(false);
  });

  test("FULL RESOLUTION still happens, for the ONE candidate that wins", () => {
    expect(
      source.match(/args\.push\(buildCaptureDownloadUrl\(source, candidate\.id\)\);/g),
    ).toHaveLength(2);

    expect(
      source.match(/const realDurationSec = ports\.probeDurationSec\(file\.path\)/g),
    ).toHaveLength(2);
    expect(source).toContain(
      "probeDurationSec: options.ports?.probeDurationSec ?? probeDurationSec",
    );
  });
});

describe("the metadata gate — artist, title and length, and nothing else", () => {
  const row = { artists: ["Netsky"], durationMs: 217_000, title: "Rio" };

  test("the tolerance is a FLAT 3s, not the capture guard's max(3s, 3%)", () => {
    expect(METADATA_TOLERANCE_SEC).toBe(3);
    expect(metadataDurationAgrees(220, 217_000)).toBe(true);
    expect(metadataDurationAgrees(221, 217_000)).toBe(false);
    expect(durationWithinTolerance(221, 217_000)).toBe(true);
  });

  test("±3s and NOT ±2s — the flat ceil and a whole-second length each want one", () => {
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

  const ladder = source.slice(
    source.indexOf("export type ProvenanceLadderCounts ="),
    source.indexOf("async function proveTrackProvenance("),
  );

  test("the slice under test is real", () => {
    expect(ladder.length).toBeGreaterThan(1_000);
    expect(ladder).toContain("async function proveCatalogueProvenance(");
  });

  test("THE RAIL — no full download is reachable from this tier", () => {
    expect(ladder).not.toContain("runYtDownload");
    expect(ladder).not.toContain("findVerifiedUpload");

    expect(ladder).toContain("runYtSection(");
    expect(source).toContain('"--download-sections"');
  });

  test("it inherits the provenance rail — not one capture column leaves it", () => {
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

    expect(ladder).toContain("row.sourceAudioKey");
    expect(ladder).not.toContain("sourceAudioKey:");
    expect(ladder).not.toContain("sourceAudioRejected:");
    expect(ladder).not.toContain("r2Put");
  });

  test("each rung reports its OWN verdict, so the receipt cannot overclaim", () => {
    expect(ladder).toContain('youtubeVerification: "metadata-match"');

    expect(ladder).toContain('youtubeVerification: "archive-match"');

    expect(ladder).not.toContain("captureVerification");
    expect(ladder).not.toContain("youtubeVideoOfficial");
  });

  test("a SoundCloud archive match banks source evidence, returns found, and never leaks an id", () => {
    const start = ladder.indexOf('if (rung.source === "soundcloud")');
    const soundcloud = ladder.slice(
      start,
      ladder.indexOf('youtubeVerification: "archive-match"', start + 1),
    );

    expect(soundcloud).toContain('sourceVerification: "soundcloud-archive-match"');
    expect(soundcloud).toContain('return "found"');
    expect(soundcloud).not.toContain("youtubeVerification");
    expect(soundcloud).not.toContain("youtubeVideoId");
  });

  test("the reference is the row's own archive, which costs no vendor bandwidth", () => {
    expect(ladder).toContain("loadArchiveFingerprint(archiveKey, dir)");
    expect(ladder).toContain("slidingWindowMatch(archiveFp, sectionFp)");
  });

  test("AN EXHAUSTED ROW MOVES THE STREAK — it is never re-served forever", () => {
    expect(ladder).toContain('youtubeVerification: "no-match"');
    expect(ladder).toContain('youtubeVerification: "inconclusive"');

    const exhausted = ladder.slice(ladder.indexOf('youtubeVerification: "no-match"'));

    expect(exhausted.slice(0, 200)).not.toContain("youtubeVideoId");
  });

  test("a TRANSIENT failure moves the streak too — a search that never answers is the loop", () => {
    const failurePath = ladder.slice(ladder.indexOf("} catch (error) {"));

    expect(failurePath).toContain('youtubeVerification: "inconclusive"');
    expect(failurePath).toContain('return "failed-recorded"');
    expect(failurePath).toContain("patchError instanceof PendingCaptureCommitError");
  });

  test("a DEFERRED row is not written to at all", () => {
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
    expect(phase).toContain("const segmentBudget = { segments: catalogueRoom }");
    expect(source).toContain("budget.segments -= 1");
    expect(source).toContain("if (budget.segments <= 0)");
  });

  test("SEARCHES are budgeted generously — they are 139KB, not the bandwidth", () => {
    expect(phase).toContain(
      "limit: catalogueRoom * Math.max(1, Math.trunc(PROVENANCE_SEARCH_FACTOR) || 1)",
    );
    expect(source).toContain('process.env.FLUNCLE_CAPTURE_PROVENANCE_SEARCH_FACTOR ?? "5"');
  });

  test("the shipped default still keeps the catalogue DARK", () => {
    expect(source).toContain('process.env.FLUNCLE_CAPTURE_PROVENANCE_CATALOGUE_LIMIT ?? "0"');
    expect(splitProvenanceBudget(2, 0).catalogue).toBe(0);
  });

  test("the FINDINGS tier keeps the full fingerprint — the cheap ladder is catalogue-only", () => {
    expect(phase).toContain("proveTrackProvenance(currentRow, prepared.snapshotToken, meter)");
    expect(phase).toContain('scope: "findings"');
    expect(phase).toContain("proveCatalogueProvenance(");
    expect(phase).toContain("prepared.snapshotToken");
    expect(phase).toContain("segmentBudget");
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
      writes: { confirmed: 13, failed: 0, pending: 0 },
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
    const summary = buildCaptureSummary({
      batch: 1,
      botChallenges: 0,
      botChallengesUncleared: 0,
      counts: { done: 1, failed: 0, skipped: 0, unmatched: 0 },
      elapsedMs: 1,
      provenance: { failed: 0, found: 0, none: 0 },
      reverdict: { asked: 0, failed: 0 },
      writes: { confirmed: 1, failed: 0, pending: 0 },
    });

    expect(summary).toMatchObject({ provenanceLadderSearched: 0, provenanceLadderTopicServed: 0 });
  });
});

const NO_FAILURES = {
  failureRecording: 0,
  proxy: 0,
  r2: 0,
  trackUpdate: 0,
  unknown: 0,
  ytDlp: 0,
};

describe("captureBlindVerdict", () => {
  test("QUIET: the worst honest batch this sweep measures is still a pass", () => {
    expect(
      captureBlindVerdict({
        attempts: 11,
        botChallengesUncleared: 3,
        failed: 6,
        failures: { ...NO_FAILURES, ytDlp: 6 },
      }),
    ).toBe(null);
    expect(
      captureBlindVerdict({
        attempts: 12,
        botChallengesUncleared: 2,
        failed: 4,
        failures: { ...NO_FAILURES, ytDlp: 4 },
      }),
    ).toBe(null);
  });

  test("QUIET: a sample under the floor cannot trip it, however it went", () => {
    expect(
      captureBlindVerdict({
        attempts: CAPTURE_BLIND_MIN_ATTEMPTS - 1,
        botChallengesUncleared: 0,
        failed: CAPTURE_BLIND_MIN_ATTEMPTS - 1,
        failures: { ...NO_FAILURES, ytDlp: CAPTURE_BLIND_MIN_ATTEMPTS - 1 },
      }),
    ).toBe(null);
  });

  test("QUIET: an unmatched row proves the fetcher works, so it is never a failure", () => {
    expect(
      captureBlindVerdict({
        attempts: 10,
        botChallengesUncleared: 0,
        failed: 2,
        failures: { ...NO_FAILURES, ytDlp: 2 },
      }),
    ).toBe(null);
  });

  test("FIRES: every attempt failing names the dominant class", () => {
    expect(
      captureBlindVerdict({
        attempts: 12,
        botChallengesUncleared: 0,
        failed: 12,
        failures: { ...NO_FAILURES, ytDlp: 12 },
      }),
    ).toBe("ytdlp_failing");
    expect(
      captureBlindVerdict({
        attempts: 8,
        botChallengesUncleared: 0,
        failed: 8,
        failures: { ...NO_FAILURES, proxy: 7, ytDlp: 1 },
      }),
    ).toBe("proxy_failing");

    expect(
      captureBlindVerdict({
        attempts: 6,
        botChallengesUncleared: 6,
        failed: 6,
        failures: { ...NO_FAILURES, ytDlp: 6 },
      }),
    ).toBe("bot_challenged");

    expect(
      captureBlindVerdict({
        attempts: 5,
        botChallengesUncleared: 0,
        failed: 5,
        failures: { ...NO_FAILURES, unknown: 5 },
      }),
    ).toBe("capture_failing");
  });
});

describe("the capture summary's added verdict", () => {
  const base = {
    botChallenges: 0,
    elapsedMs: 1,
    provenance: { failed: 0, found: 0, none: 0 },
    reverdict: { asked: 0, failed: 0 },
    writes: { confirmed: 0, failed: 0, pending: 0 },
  };

  test("FIRES: a wholly failed batch is a failed run with its counts intact", () => {
    const summary = buildCaptureSummary({
      ...base,
      batch: 12,
      botChallengesUncleared: 0,
      counts: { done: 0, failed: 12, skipped: 0, unmatched: 0 },
      failures: { ...NO_FAILURES, ytDlp: 12 },
    });

    expect(summary).toMatchObject({
      captureAttempts: 12,
      checked: 12,
      errors: 1,
      failed: 12,
      ok: false,
      produced: 0,
      reason: "ytdlp_failing",
    });
  });

  test("QUIET: rows the server's budget refused are not attempts and cannot manufacture a wall", () => {
    const summary = buildCaptureSummary({
      ...base,
      batch: 12,
      botChallengesUncleared: 0,
      counts: { done: 0, failed: 1, rejected: 11, skipped: 0, unmatched: 0 },
      failures: { ...NO_FAILURES, ytDlp: 1 },
    });

    expect(summary).toMatchObject({
      captureAttempts: 1,
      captureRejected: 11,
      errors: 0,
      ok: true,
    });
    expect(summary).not.toHaveProperty("reason");
  });

  test("QUIET: an ordinary partial batch keeps reading as the pass it is", () => {
    const summary = buildCaptureSummary({
      ...base,
      batch: 12,
      botChallengesUncleared: 2,
      counts: { done: 7, failed: 4, skipped: 0, unmatched: 1 },
      failures: { ...NO_FAILURES, ytDlp: 4 },
    });

    expect(summary).toMatchObject({ captureAttempts: 12, errors: 0, ok: true, produced: 7 });
    expect(summary).not.toHaveProperty("reason");
  });
});

describe("the batched capture commit", () => {
  const batchDirectory = mkdtempSync(join(tmpdir(), "fluncle-capture-batch-"));

  afterAll(() => {
    rmSync(batchDirectory, { force: true, recursive: true });
  });

  const collected = (trackId: string, outcome: "done" | "unmatched"): CollectedCaptureCommit => ({
    path: join(batchDirectory, trackId),
    request: {
      commitToken: `commit-${trackId}`,
      operationId: "track.capture",
      operationKey: `track.capture:${trackId}`,
      requestDigest: "0".repeat(64),
      trackId,
    },
    result:
      outcome === "done"
        ? {
            attemptedAt: "2026-01-01T00:00:00.000Z",
            bytes: 1,
            captureVerification: "unverified",
            capturedAt: "2026-01-01T00:00:00.000Z",
            kind: "capture",
            outcome: "done",
            sourceAudioKey: `catalogue/${trackId}/x.webm`,
            verifiedAt: "2026-01-01T00:00:00.000Z",
          }
        : { attemptedAt: "2026-01-01T00:00:00.000Z", kind: "capture", outcome: "unmatched" },
  });

  function phaseWriting(receipts: (statePath: string) => unknown): {
    calls: string[];
    phase: (action: string, statePath: string) => "completed" | "yielded";
  } {
    const calls: string[] = [];

    return {
      calls,
      phase: (action, statePath) => {
        calls.push(action);
        writeFileSync(`${statePath}.result`, JSON.stringify(receipts(statePath)));

        return "completed";
      },
    };
  }

  test("settles six rows in ONE admitted phase, with a receipt per row", () => {
    const rows = ["a", "b", "c", "d", "e", "f"].map((id) => collected(`track-${id}`, "done"));
    const { calls, phase } = phaseWriting((statePath) => {
      const body = JSON.parse(readFileSync(statePath, "utf8")) as {
        items: { trackId: string }[];
      };

      return {
        deferred: 0,
        ok: true,
        receipts: body.items.map((item) => ({
          outcome: "committed",
          replayed: false,
          result: { applied: true, kind: "capture", outcome: "done" },
          trackId: item.trackId,
        })),
      };
    });

    const dispositions = settleCollectedCommits(rows, 6, phase as never);

    expect(calls).toEqual(["commit-batch"]);
    expect([...dispositions.values()]).toEqual(Array.from({ length: 6 }, () => "committed"));
  });

  test("answers per item, so a stale row rejects alone while its neighbours commit", () => {
    const rows = [
      collected("track-a", "done"),
      collected("track-b", "done"),
      collected("track-c", "done"),
    ];
    const { phase } = phaseWriting((statePath) => {
      const body = JSON.parse(readFileSync(statePath, "utf8")) as {
        items: { trackId: string }[];
      };

      return {
        deferred: 0,
        ok: true,
        receipts: body.items.map((item) =>
          item.trackId === "track-b"
            ? {
                outcome: "rejected",
                replayed: false,
                result: { applied: false, reason: "stale" },
                trackId: item.trackId,
              }
            : {
                outcome: "committed",
                replayed: false,
                result: { applied: true, kind: "capture", outcome: "done" },
                trackId: item.trackId,
              },
        ),
      };
    });

    const dispositions = settleCollectedCommits(rows, 6, phase as never);

    expect(dispositions.get("track-a")).toBe("committed");
    expect(dispositions.get("track-b")).toBe("rejected");
    expect(dispositions.get("track-c")).toBe("committed");
  });

  test("reads a wall-budgeted tail as pending, which the next tick reconciles", () => {
    const rows = [collected("track-a", "done"), collected("track-b", "done")];
    const { phase } = phaseWriting((statePath) => {
      const body = JSON.parse(readFileSync(statePath, "utf8")) as {
        items: { trackId: string }[];
      };

      return {
        deferred: 1,
        ok: true,
        receipts: body.items.map((item, index) =>
          index === 0
            ? {
                outcome: "committed",
                replayed: false,
                result: { applied: true, kind: "capture", outcome: "done" },
                trackId: item.trackId,
              }
            : { outcome: "safely-retryable", replayed: false, trackId: item.trackId },
        ),
      };
    });

    const dispositions = settleCollectedCommits(rows, 6, phase as never);

    expect(dispositions.get("track-a")).toBe("committed");

    expect(dispositions.get("track-b")).toBe("pending");
  });

  test("splits a run wider than the batch into consecutive phases", () => {
    const rows = ["a", "b", "c", "d", "e", "f", "g"].map((id) => collected(`track-${id}`, "done"));
    const { calls, phase } = phaseWriting((statePath) => {
      const body = JSON.parse(readFileSync(statePath, "utf8")) as {
        items: { trackId: string }[];
      };

      return {
        deferred: 0,
        ok: true,
        receipts: body.items.map((item) => ({
          outcome: "committed",
          replayed: false,
          result: { applied: true, kind: "capture", outcome: "done" },
          trackId: item.trackId,
        })),
      };
    });

    settleCollectedCommits(rows, 6, phase as never);

    expect(calls).toEqual(["commit-batch", "commit-batch"]);
  });

  test("reads a yielded phase as pending for every row it held", () => {
    const rows = [collected("track-a", "done"), collected("track-b", "done")];

    const dispositions = settleCollectedCommits(rows, 6, (() => "yielded") as never);

    expect([...dispositions.values()]).toEqual(["pending", "pending"]);
  });
});

describe("the deferred outcome a batched commit resolves", () => {
  test("carries the verdict the row earns, and never counts it before its receipt", () => {
    expect(isDeferredOutcome("deferred:done")).toBe(true);
    expect(isDeferredOutcome("done")).toBe(false);
    expect(resolveDeferredOutcome("deferred:done", "committed")).toBe("done");
    expect(resolveDeferredOutcome("deferred:unmatched", "committed")).toBe("unmatched");
    expect(resolveDeferredOutcome("deferred:failed", "committed")).toBe("failed");
    expect(resolveDeferredOutcome("deferred:done", "rejected")).toBe("rejected");

    expect(resolveDeferredOutcome("deferred:done", "pending")).toBe("pending");
    expect(resolveDeferredOutcome("deferred:done", undefined)).toBe("pending");
  });
});

describe("the capture batch's version tolerance", () => {
  test("takes the per-row phases against a Worker that advertises no widths", () => {
    expect(parseCaptureCapabilities(undefined)).toBeUndefined();
    expect(parseCaptureCapabilities({})).toBeUndefined();
    expect(parseCaptureCapabilities({ prepareTrackCaptures: 0 })).toBeUndefined();
  });

  test("reads the widths a batched Worker advertises", () => {
    expect(parseCaptureCapabilities({ commitTrackCaptures: 6, prepareTrackCaptures: 12 })).toEqual({
      commitTrackCaptures: 6,
      prepareTrackCaptures: 12,
    });
  });

  test("takes the per-row phases when the kill switch is set", () => {
    process.env.FLUNCLE_CAPTURE_BATCH_PHASES = "0";
    try {
      expect(
        parseCaptureCapabilities({ commitTrackCaptures: 6, prepareTrackCaptures: 12 }),
      ).toBeUndefined();
    } finally {
      delete process.env.FLUNCLE_CAPTURE_BATCH_PHASES;
    }
  });
});

describe("the capture batch cap", () => {
  test("takes the default when unset or empty", () => {
    expect(resolveCaptureBatchCap(undefined)).toBe(DEFAULT_CAPTURE_BATCH_CAP);
    expect(resolveCaptureBatchCap("  ")).toBe(DEFAULT_CAPTURE_BATCH_CAP);
  });

  test("takes an integer inside the ceiling", () => {
    expect(resolveCaptureBatchCap("12")).toBe(12);
    expect(resolveCaptureBatchCap(String(MAX_CAPTURE_BATCH_CAP))).toBe(MAX_CAPTURE_BATCH_CAP);
  });

  test("refuses anything that would widen the metered spend by accident", () => {
    for (const raw of [String(MAX_CAPTURE_BATCH_CAP + 1), "0", "-3", "2.5", "1e3", "lots"]) {
      expect(resolveCaptureBatchCap(raw)).toBe(DEFAULT_CAPTURE_BATCH_CAP);
    }
  });
});

describe("the per-tick item timing", () => {
  test("publishes the max and the median of what the server measured", () => {
    expect(summariseItemTiming([10, 90, 20, 30, 40])).toEqual({
      itemMsMax: 90,
      itemMsP50: 30,
      itemSamples: 5,
    });
  });

  test("says nothing at all when no batched phase reported a reading", () => {
    expect(summariseItemTiming([])).toBeUndefined();
    expect(summariseItemTiming([Number.NaN, -1])).toBeUndefined();
  });
});

describe("the tick's shared capture reservation", () => {
  const reservationDirectory = mkdtempSync(join(tmpdir(), "fluncle-capture-reserve-"));

  afterAll(() => {
    rmSync(reservationDirectory, { force: true, recursive: true });
  });

  function fakeServer(options: {
    answerLimit?: number;
    certified?: (trackId: string) => boolean;
    remaining: number;
  }) {
    const calls: { items: string[]; reservedThisTick: number }[] = [];
    const certified = options.certified ?? (() => false);
    const phase = ((_action: string, statePath: string) => {
      const body = JSON.parse(readFileSync(statePath, "utf8")) as {
        items: { trackId: string }[];
        reservedThisTick?: number;
      };
      const reservedThisTick = body.reservedThisTick ?? 0;
      calls.push({
        items: body.items.map((item) => item.trackId),
        reservedThisTick,
      });

      let budget = Math.max(0, options.remaining - reservedThisTick);
      let reserved = 0;
      const results = body.items.map((item, index) => {
        if (options.answerLimit !== undefined && index >= options.answerLimit) {
          return { elapsedMs: 0, prepared: false, reason: "deferred", trackId: item.trackId };
        }
        const isCertified = certified(item.trackId);

        if (!isCertified) {
          if (budget <= 0) {
            return { elapsedMs: 1, prepared: false, reason: "ineligible", trackId: item.trackId };
          }
          budget -= 1;
          reserved += 1;
        }
        return {
          elapsedMs: 1,
          prepared: true,
          snapshotToken: `snapshot-${item.trackId}`,
          track: {
            anchored: true,
            artists: [],
            certified: isCertified,
            title: item.trackId,
            trackId: item.trackId,
          },
          trackId: item.trackId,
        };
      });

      writeFileSync(
        `${statePath}.result`,
        JSON.stringify({ deferred: 0, ok: true, reserved, results }),
      );

      return "completed";
    }) as never;

    return { calls, phase };
  }

  test("authorizes exactly the remaining count when the tick is wider than the op", () => {
    const ids = Array.from({ length: 20 }, (_, index) => `track-${index}`);
    const { calls, phase } = fakeServer({ remaining: 5 });

    const page = prepareTickSnapshots(ids, "capture", 12, phase);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.reservedThisTick).toBe(0);

    expect(calls[1]?.reservedThisTick).toBe(5);
    expect(page?.reserved).toBe(5);
    const authorized = [...(page?.prepared.values() ?? [])].filter((entry) => entry.prepared);
    expect(authorized).toHaveLength(5);

    expect(page?.prepared.size).toBe(20);
  });

  test("a wall-budget deferred tail is re-asked in a batched call, never dropped to per-row", () => {
    const ids = Array.from({ length: 6 }, (_, index) => `track-${index}`);

    const { calls, phase } = fakeServer({ answerLimit: 2, remaining: 3 });

    const page = prepareTickSnapshots(ids, "capture", 6, phase);

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.map((call) => call.reservedThisTick)).toEqual(
      calls.map((call) => call.reservedThisTick).sort((left, right) => left - right),
    );
    expect(page?.reserved).toBe(3);
    expect([...(page?.prepared.values() ?? [])].filter((entry) => entry.prepared)).toHaveLength(3);
  });

  test("a certified finding is authorized past a spent budget and consumes none of it", () => {
    const ids = ["cat-0", "cert-0", "cat-1", "cert-1"];
    const { phase } = fakeServer({
      certified: (trackId) => trackId.startsWith("cert-"),
      remaining: 1,
    });

    const page = prepareTickSnapshots(ids, "capture", 12, phase);

    expect(page?.reserved).toBe(1);
    expect(page?.prepared.get("cert-0")?.prepared).toBe(true);
    expect(page?.prepared.get("cert-1")?.prepared).toBe(true);
    expect(page?.prepared.get("cat-0")?.prepared).toBe(true);
    expect(page?.prepared.get("cat-1")?.prepared).toBe(false);
  });

  test("stops rather than spending another lease when a call answers nothing", () => {
    const ids = ["track-0", "track-1"];

    const { calls, phase } = fakeServer({ answerLimit: 0, remaining: 5 });

    const page = prepareTickSnapshots(ids, "capture", 2, phase);

    expect(calls).toHaveLength(1);
    expect(page?.prepared.size).toBe(0);
    expect(page?.reserved).toBe(0);
  });

  test("a yielded call freezes nothing and pauses the tick", () => {
    const page = prepareTickSnapshots(["track-0"], "capture", 2, (() => "yielded") as never);

    expect(page).toBeUndefined();
  });

  function newerWorker(options: { extraFor: string; extra: Record<string, unknown> }) {
    const calls: string[][] = [];
    const phase = ((_action: string, statePath: string) => {
      const body = JSON.parse(readFileSync(statePath, "utf8")) as { items: { trackId: string }[] };
      calls.push(body.items.map((item) => item.trackId));
      const results = body.items.map((item) => ({
        elapsedMs: 1,
        prepared: true,
        snapshotToken: `snapshot-${item.trackId}`,
        track: {
          artists: [],
          certified: true,
          logId: "004.7.2I",
          title: item.trackId,
          trackId: item.trackId,
          ...(item.trackId === options.extraFor ? options.extra : {}),
        },
        trackId: item.trackId,
      }));
      writeFileSync(`${statePath}.result`, JSON.stringify({ deferred: 0, ok: true, results }));
      return "completed";
    }) as never;
    return { calls, phase };
  }

  test("a field this bake does not know leaves THAT row unreached — the rest of the tick proceeds", () => {
    const ids = ["track-0", "track-newer", "track-2"];
    const { calls, phase } = newerWorker({
      extra: { fieldFromTheFuture: "x" },
      extraFor: "track-newer",
    });
    const lines: string[] = [];
    const original = console.error;
    console.error = (message: unknown) => {
      lines.push(String(message));
    };
    let page: ReturnType<typeof prepareTickSnapshots>;
    try {
      page = prepareTickSnapshots(ids, "capture", 12, phase);
    } finally {
      console.error = original;
    }

    expect([...(page?.prepared.keys() ?? [])].sort()).toEqual(["track-0", "track-2"]);
    expect(page?.unreached).toEqual(["track-newer"]);

    expect(calls).toHaveLength(1);
    const line = lines.find((entry) => entry.includes("this bake does not know"));
    expect(line).toContain("track-newer");
    expect(line).toContain("fieldFromTheFuture");
  });

  test("a KNOWN key with a bad shape still fails closed", () => {
    const { phase } = newerWorker({ extra: { logId: 42 }, extraFor: "track-bad" });

    expect(() => prepareTickSnapshots(["track-bad"], "capture", 12, phase)).toThrow(
      "invalid answer for track-bad",
    );
  });
});

describe("the anchored split the tick publishes", () => {
  test("rides the summary beside the counts it explains", () => {
    const summary = buildCaptureSummary({
      anchoring: { attemptsAnchored: 9, attemptsUnanchored: 3, doneAnchored: 7, doneUnanchored: 1 },
      batch: 12,
      botChallenges: 0,
      botChallengesUncleared: 0,
      counts: {
        done: 8,
        failed: 0,
        pending: 0,
        reconciled: 0,
        rejected: 0,
        skipped: 0,
        unmatched: 4,
      },
      elapsedMs: 1_000,
      itemTiming: [4, 12, 8],
      provenance: { failed: 0, found: 0, none: 0 },
      reverdict: { asked: 0, failed: 0 },
      writes: { confirmed: 8, failed: 0, pending: 0 },
    });

    expect(summary).toMatchObject({
      attemptsAnchored: 9,
      attemptsUnanchored: 3,
      doneAnchored: 7,
      doneUnanchored: 1,
    });

    expect(summary).toMatchObject({ itemMsMax: 12, itemMsP50: 8, itemSamples: 3 });

    expect(summary).toMatchObject({ checked: 12, done: 8, failed: 0 });
  });

  test("says nothing about anchoring when the Worker answered no flag", () => {
    const summary = buildCaptureSummary({
      batch: 1,
      botChallenges: 0,
      botChallengesUncleared: 0,
      counts: {
        done: 1,
        failed: 0,
        pending: 0,
        reconciled: 0,
        rejected: 0,
        skipped: 0,
        unmatched: 0,
      },
      elapsedMs: 10,
      provenance: { failed: 0, found: 0, none: 0 },
      reverdict: { asked: 0, failed: 0 },
      writes: { confirmed: 1, failed: 0, pending: 0 },
    });

    expect(summary.doneAnchored).toBeUndefined();
    expect(summary.itemMsMax).toBeUndefined();
  });
});

describe("the admitted phase child's argv guard", () => {
  test("accepts every action the parent can spawn, and nothing else", () => {
    for (const action of CAPTURE_ADMISSION_ACTIONS) {
      expect(isCaptureAdmissionAction(action)).toBe(true);
    }
    expect(CAPTURE_ADMISSION_ACTIONS).toEqual(
      expect.arrayContaining([
        "prepare-batch",
        "commit-batch",
        "prepare",
        "commit",
        "queue",
        "reconcile",
      ]),
    );
    expect(isCaptureAdmissionAction("")).toBe(false);
    expect(isCaptureAdmissionAction("batch")).toBe(false);
    expect(isCaptureAdmissionAction("PREPARE")).toBe(false);
  });

  test("the real child entrypoint accepts a batch action instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "capture-argv-guard-"));
    try {
      const statePath = join(dir, "prepare-batch.json");
      writeFileSync(statePath, "{}");
      const run = Bun.spawnSync(
        [
          process.execPath,
          join(import.meta.dir, "capture-sweep.ts"),
          "--admission-phase",
          "prepare-batch",
          "--phase-state",
          statePath,
        ],
        { env: { ...process.env, FLUNCLE_API_TOKEN: "test" }, stderr: "pipe", stdout: "pipe" },
      );
      const text = `${run.stdout.toString()}\n${run.stderr.toString()}`;
      expect(text).not.toContain("invalid capture admission phase invocation");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe("the operator's capture-source pin", () => {
  const source = readFileSync(new URL("./capture-sweep.ts", import.meta.url), "utf8");
  const pinnedWalk = source.slice(
    source.indexOf("export type PinnedUploadPorts ="),
    source.indexOf("type FindingOutcome ="),
  );
  const captureFn = source.slice(
    source.indexOf("async function captureFinding("),
    source.indexOf("export type ProvenanceLadderCounts ="),
  );

  const finding: CaptureFinding = {
    captureSourcePin: "dQw4w9WgXcQ",
    certified: true,
    durationMs: 300_000,
    logId: "012.3.4A",
    title: "Song",
    trackId: "track-pinned",
  };

  function fakeSession(): ProxySession & { rerolls: number } {
    const session = {
      reroll: () => {
        if (session.rerolls > 0) {
          return false;
        }
        session.rerolls += 1;
        session.url = "http://proxy/rerolled";
        return true;
      },
      rerollable: () => session.rerolls === 0,
      rerolls: 0,
      url: "http://proxy/first",
    };
    return session;
  }

  function fakePorts(
    dir: string,
    overrides: Partial<PinnedUploadPorts> = {},
  ): PinnedUploadPorts & { downloads: YtCandidate[] } {
    const downloads: YtCandidate[] = [];
    return {
      download:
        overrides.download ??
        ((_proxy, candidate) => {
          downloads.push(candidate);
          const path = join(dir, "audio.webm");
          writeFileSync(path, `bytes of ${candidate.id}`);
          return { ext: "webm", path };
        }),
      downloads,
      fingerprint: overrides.fingerprint ?? (() => null),
      probeDurationSec: overrides.probeDurationSec ?? (() => 300),
      referenceFingerprint: overrides.referenceFingerprint ?? (async () => null),
    };
  }

  const scratch: string[] = [];
  function workdir(): string {
    const dir = mkdtempSync(join(tmpdir(), "capture-pin-"));
    scratch.push(dir);
    return dir;
  }
  afterAll(() => {
    for (const dir of scratch) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  async function withLog<T>(run: () => Promise<T>): Promise<{ lines: string[]; value: T }> {
    const lines: string[] = [];
    const original = console.error;
    console.error = (message: unknown) => {
      lines.push(String(message));
    };
    try {
      return { lines, value: await run() };
    } finally {
      console.error = original;
    }
  }

  test("a pinned row downloads THE ONE PINNED ID and skips the ladder entirely", async () => {
    const dir = workdir();
    const ports = fakePorts(dir);
    const { lines, value } = await withLog(() =>
      findPinnedUpload({ dir, finding, ports, session: fakeSession(), videoId: "dQw4w9WgXcQ" }),
    );

    expect(ports.downloads.map((candidate) => candidate.id)).toEqual(["dQw4w9WgXcQ"]);
    expect(ports.downloads[0]?.source).toBe("youtube");
    expect(value.videoId).toBe("dQw4w9WgXcQ");
    expect(value.verdict).toBe("operator");
    expect(value.source).toBe("youtube");
    expect(value.digest).toBe(createHash("sha256").update("bytes of dQw4w9WgXcQ").digest("hex"));

    const honoured = lines.filter((line) => line.includes("capture-source pin"));
    expect(honoured).toHaveLength(1);
    expect(honoured[0]).toContain("012.3.4A");
    expect(honoured[0]).toContain("dQw4w9WgXcQ");
  });

  test("the pinned walk has NO search ladder in it — by source, not by luck", () => {
    expect(pinnedWalk.length).toBeGreaterThan(1_000);
    expect(pinnedWalk).toContain("export async function findPinnedUpload(");
    for (const ladderCall of [
      "runYtSearch",
      "buildCaptureSearchLadder",
      "findFirstRankedCaptureRung",
      "rankCandidates(",
      "pickCandidate(",
    ]) {
      expect(pinnedWalk).not.toContain(ladderCall);
    }
  });

  test("the pinned walk NEVER touches the rejection memory — it is not even handed it", () => {
    for (const memoryTouch of [
      "memory.",
      "memory:",
      "appendRejectedSource",
      "filterRejectedCandidates",
      "rejectedVideoIds",
      "rejectedShas",
      "knownBadShas",
      "legacyRejectKey",
    ]) {
      expect(pinnedWalk).not.toContain(memoryTouch);
    }

    const pinnedCall = captureFn.slice(
      captureFn.indexOf("return findPinnedUpload({"),
      captureFn.indexOf("return findVerifiedUpload({"),
    );
    expect(pinnedCall).toContain(
      "allowDurationMismatch: finding.captureSourcePinAllowDuration === true,",
    );
    expect(pinnedCall).toContain("videoId: pin,");
    expect(pinnedCall).not.toContain("memory");
  });

  test("the duration guard STILL applies — a wrong paste is refused, its file deleted, no fingerprint spent", async () => {
    const dir = workdir();
    let fingerprinted = 0;
    const ports = fakePorts(dir, {
      fingerprint: () => {
        fingerprinted += 1;
        return [1, 2, 3];
      },

      probeDurationSec: () => 3_600,
    });

    const { lines, value: error } = await withLog(() =>
      findPinnedUpload({
        dir,
        finding,
        ports,
        session: fakeSession(),
        videoId: "dQw4w9WgXcQ",
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      ),
    );

    expect(isPinnedDurationRefusal(error)).toBe(true);
    expect((error as Error).message).toContain("fails the duration guard");
    expect((error as Error).message).toContain("3600s");
    expect(lines.some((line) => line.includes("pinned upload fails the duration guard ("))).toBe(
      true,
    );

    expect(existsSync(join(dir, "audio.webm"))).toBe(false);
    expect(fingerprinted).toBe(0);
  });

  test("the DURATION OVERRIDE waives the guard for the pinned id only — a 233 s edit lands on a 365 s finding, logged, on operator authority", async () => {
    const longFinding: CaptureFinding = { ...finding, durationMs: 365_000 };
    const refusedDir = workdir();
    const refused = await withLog(() =>
      findPinnedUpload({
        dir: refusedDir,
        finding: longFinding,
        ports: fakePorts(refusedDir, { probeDurationSec: () => 233 }),
        session: fakeSession(),
        videoId: "dQw4w9WgXcQ",
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      ),
    );
    expect(isPinnedDurationRefusal(refused.value)).toBe(true);
    expect(existsSync(join(refusedDir, "audio.webm"))).toBe(false);

    const dir = workdir();
    let fingerprinted = 0;
    const ports = fakePorts(dir, {
      fingerprint: () => {
        fingerprinted += 1;
        return null;
      },
      probeDurationSec: () => 233,
    });
    const { lines, value } = await withLog(() =>
      findPinnedUpload({
        allowDurationMismatch: true,
        dir,
        finding: longFinding,
        ports,
        session: fakeSession(),
        videoId: "dQw4w9WgXcQ",
      }),
    );

    expect(value.verdict).toBe("operator");
    expect(value.videoId).toBe("dQw4w9WgXcQ");
    expect(existsSync(value.path)).toBe(true);
    expect(fingerprinted).toBe(1);
    expect(
      lines.some((line) =>
        line.includes("pinned upload duration 233s vs 365s — accepted on operator authority"),
      ),
    ).toBe(true);
    expect(lines.some((line) => line.includes("fails the duration guard"))).toBe(false);

    expect(captureFn).toContain(
      "allowDurationMismatch: finding.captureSourcePinAllowDuration === true,",
    );

    expect(source).toContain('"captureSourcePinAllowDuration",');
    expect(source).toContain(
      'validOptionalPreparedBoolean(value, "captureSourcePinAllowDuration")',
    );
  });

  test("a pin WITHOUT the override still refuses a wrong length — a paste is never waived by default", async () => {
    const dir = workdir();
    const { value: error } = await withLog(() =>
      findPinnedUpload({
        allowDurationMismatch: false,
        dir,
        finding: { ...finding, durationMs: 365_000 },
        ports: fakePorts(dir, { probeDurationSec: () => 233 }),
        session: fakeSession(),
        videoId: "dQw4w9WgXcQ",
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      ),
    );

    expect(isPinnedDurationRefusal(error)).toBe(true);
    expect((error as Error).message).toContain("233s against the row's 365s");
  });

  test("the duration refusal is a THROW, so the caller lands `failed` (retryable), never `unmatched`", () => {
    expect(pinnedWalk).toContain("}): Promise<VerifiedUpload> {");
    expect(pinnedWalk).not.toContain("return null");
    expect(pinnedWalk).not.toContain('"unmatched"');
    expect(pinnedWalk).toContain("throw refusal;");
  });

  test("a fingerprint MISMATCH is logged with its BER and captured anyway, as `operator-verified`", async () => {
    const dir = workdir();

    const reference = Array.from({ length: 40 }, () => 0);
    const opposite = Array.from({ length: 40 }, () => -1);
    const ports = fakePorts(dir, {
      fingerprint: () => opposite,
      referenceFingerprint: async () => reference,
    });

    const { lines, value } = await withLog(() =>
      findPinnedUpload({ dir, finding, ports, session: fakeSession(), videoId: "dQw4w9WgXcQ" }),
    );

    expect(verifyCaptureFileDetailed(reference, opposite)).toEqual({ ber: 1, verdict: "mismatch" });
    const mismatchLine = lines.find((line) => line.includes("mismatches the store reference"));
    expect(mismatchLine).toContain("ber=1.000");
    expect(mismatchLine).toContain("capturing on operator authority");

    expect(value.verdict).toBe("operator");
    expect(captureVerificationFor(value.verdict)).toBe("operator-verified");
    expect(existsSync(value.path)).toBe(true);
  });

  test("a MATCH on a pinned row is still recorded as `operator-verified`, never `preview-match`", async () => {
    const dir = workdir();
    const same = Array.from({ length: 40 }, (_, index) => index);
    const ports = fakePorts(dir, {
      fingerprint: () => same,
      referenceFingerprint: async () => same,
    });
    const { value } = await withLog(() =>
      findPinnedUpload({ dir, finding, ports, session: fakeSession(), videoId: "dQw4w9WgXcQ" }),
    );

    expect(value.verdict).toBe("operator");
    expect(captureVerificationFor(value.verdict)).toBe("operator-verified");
    expect(captureVerificationFor("match")).toBe("preview-match");
    expect(captureVerificationFor("no-reference")).toBe("unverified");
  });

  test("a download failure rethrows into the caller's `failed` path — the pin is retried next tick", async () => {
    const dir = workdir();
    const ports = fakePorts(dir, {
      download: () => {
        const error = new Error("yt-dlp download failed: HTTP Error 403: Forbidden");
        Object.assign(error, classifyDownloadFailure("HTTP Error 403: Forbidden"));
        throw error;
      },
    });
    const session = fakeSession();

    const { value: error } = await withLog(() =>
      findPinnedUpload({ dir, finding, ports, session, videoId: "dQw4w9WgXcQ" }).then(
        () => undefined,
        (caught: unknown) => caught,
      ),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("yt-dlp download failed");

    expect(isPinnedDurationRefusal(error)).toBe(false);
  });

  test("a bot wall re-rolls the sticky exit ONCE and retries the same pinned id", async () => {
    const dir = workdir();
    const proxies: string[] = [];
    let attempts = 0;
    const ports = fakePorts(dir, {
      download: (proxy, candidate) => {
        proxies.push(proxy);
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("yt-dlp download failed: Sign in to confirm you're not a bot");
          Object.assign(
            error,
            classifyDownloadFailure("ERROR: Sign in to confirm you're not a bot"),
          );
          throw error;
        }
        const path = join(dir, "audio.webm");
        writeFileSync(path, `bytes of ${candidate.id}`);
        return { ext: "webm", path };
      },
    });
    const session = fakeSession();

    const { value } = await withLog(() =>
      findPinnedUpload({ dir, finding, ports, session, videoId: "dQw4w9WgXcQ" }),
    );

    expect(value.videoId).toBe("dQw4w9WgXcQ");
    expect(session.rerolls).toBe(1);
    expect(proxies).toEqual(["http://proxy/first", "http://proxy/rerolled"]);
  });

  test("the caller routes a pinned row to the pinned walk and the ladder otherwise", () => {
    expect(captureFn).toContain("const pin = finding.captureSourcePin?.trim();");
    expect(captureFn).toMatch(/if \(pin\) \{\s*return findPinnedUpload\(/);
    expect(captureFn).toContain("return findVerifiedUpload({");

    expect(source).toContain('"captureSourcePin",');
    expect(source).toContain('validOptionalPreparedString(value, "captureSourcePin", 64)');
  });

  test("the journal replay stamps the same verification the inline path does", () => {
    expect(source).toContain("const verification = captureVerificationFor(completion.verdict);");
    expect(source).toContain("const verification = captureVerificationFor(accepted.verdict);");
  });
});

describe("the consensus check — independent uploads agreeing where the preview could not", () => {
  const source = readFileSync(new URL("./capture-sweep.ts", import.meta.url), "utf8");
  const FRAMES = 600;

  function recording(seed: number, frames = FRAMES): number[] {
    let state = seed >>> 0 || 1;
    return Array.from({ length: frames }, () => {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state | 0;
    });
  }

  function reupload(base: readonly number[], bitsPerFrame: number, everyNth = 1): number[] {
    return base.map((frame, index) => {
      if (index % everyNth !== 0) {
        return frame;
      }
      let mask = 0;
      for (let bit = 0; bit < bitsPerFrame; bit += 1) {
        mask |= 1 << ((index + bit * 7) % 32);
      }
      return (frame ^ mask) | 0;
    });
  }

  function thirdFrameBit(base: readonly number[], phase: number, shift: number): number[] {
    return base.map((frame, index) =>
      index % 3 === phase ? (frame ^ (1 << ((index + shift) % 32))) | 0 : frame,
    );
  }

  function lowInformationPreview(base: readonly number[]): number[] {
    const start = Math.floor((base.length - 240) / 2);
    return base.slice(start, start + 240).map((frame) => (frame ^ 0x7ff) | 0);
  }

  const RECORDING = recording(7);
  const WRONG_SONG = recording(99);
  const PREVIEW = lowInformationPreview(RECORDING);
  const UKF = reupload(RECORDING, 1, 2);
  const TOPIC = reupload(RECORDING, 1);
  const SLEEPLESS = thirdFrameBit(reupload(RECORDING, 1), 0, 11);
  const FLATCH = thirdFrameBit(reupload(RECORDING, 1), 1, 5);

  test("the fixtures sit where the box measured them", () => {
    const ber = (a: readonly number[], b: readonly number[]) => mutualWindowMatch(a, b)?.ber ?? 1;
    expect(ber(UKF, TOPIC)).toBeGreaterThan(0.01);
    expect(ber(UKF, TOPIC)).toBeLessThan(0.05);
    expect(ber(UKF, SLEEPLESS)).toBeLessThan(0.06);
    expect(ber(TOPIC, SLEEPLESS)).toBeLessThan(0.06);
    expect(ber(UKF, FLATCH)).toBeLessThan(0.06);
    expect(ber(UKF, WRONG_SONG)).toBeGreaterThan(0.4);
    for (const upload of [UKF, TOPIC, SLEEPLESS, FLATCH]) {
      const gate = verifyCaptureFileDetailed(PREVIEW, upload);
      expect(gate.verdict).toBe("mismatch");
      expect(gate.ber ?? 0).toBeGreaterThan(0.3);
      expect(gate.ber ?? 0).toBeLessThan(0.4);
    }
  });

  const finding: CaptureFinding = {
    artists: ["Krakota"],
    certified: true,
    durationMs: 259_000,
    logId: "012.3.4B",
    title: "Be The Reason",
    trackId: "track-consensus",
  };

  type Upload = {
    channelId?: string;
    durationSec: number;
    fingerprint: readonly number[];
    id: string;
  };

  function fakeSession(): ProxySession {
    return {
      reroll: () => false,
      rerollable: () => false,
      url: "http://proxy/first",
    };
  }

  const scratch: string[] = [];
  function workdir(): string {
    const dir = mkdtempSync(join(tmpdir(), "capture-consensus-"));
    scratch.push(dir);
    return dir;
  }
  afterAll(() => {
    for (const dir of scratch) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  async function withLog<T>(run: () => Promise<T>): Promise<{ lines: string[]; value: T }> {
    const lines: string[] = [];
    const original = console.error;
    console.error = (message: unknown) => {
      lines.push(String(message));
    };
    try {
      return { lines, value: await run() };
    } finally {
      console.error = original;
    }
  }

  function fakePorts(uploads: readonly Upload[], overrides: Partial<LadderPorts> = {}) {
    const downloads: string[] = [];
    const byId = new Map(uploads.map((upload) => [upload.id, upload]));
    const idFromPath = (path: string) => readFileSync(path, "utf8").replace(/^bytes of /, "");
    const ports: LadderPorts = {
      download:
        overrides.download ??
        ((_proxy, candidate, dir) => {
          downloads.push(candidate.id);
          const path = join(dir, "audio.webm");
          writeFileSync(path, `bytes of ${candidate.id}`);
          return { ext: "webm", path };
        }),
      fingerprint:
        overrides.fingerprint ??
        ((path) => {
          const upload = byId.get(idFromPath(path));
          return upload ? [...upload.fingerprint] : null;
        }),
      probeDurationSec:
        overrides.probeDurationSec ?? ((path) => byId.get(idFromPath(path))?.durationSec ?? 0),
      referenceFingerprint: overrides.referenceFingerprint ?? (async () => [...PREVIEW]),
      search:
        overrides.search ??
        (() =>
          uploads.map((upload) => ({
            ...(upload.channelId ? { channel: upload.channelId, channelId: upload.channelId } : {}),
            durationSec: upload.durationSec,
            id: upload.id,
            source: "youtube" as const,
            title: finding.title ?? "",
          }))),
    };
    return { downloads, ports };
  }

  function freshMemory(): RejectedMemory {
    return { dirty: false, sources: [] };
  }

  async function walk(uploads: readonly Upload[], overrides: Partial<LadderPorts> = {}) {
    const dir = workdir();
    const { downloads, ports } = fakePorts(uploads, overrides);
    const memory = freshMemory();
    const { lines, value } = await withLog(() =>
      findVerifiedUpload({ dir, finding, memory, ports, session: fakeSession() }),
    );
    return { dir, downloads, lines, memory, value };
  }

  test("three preview mismatches, two agreeing from different channels → the highest-ranked of the pair, `consensus`; the third remembered", async () => {
    const uploads: Upload[] = [
      { channelId: "UC-one", durationSec: 259, fingerprint: UKF, id: "ukf00000001" },
      { channelId: "UC-two", durationSec: 260, fingerprint: TOPIC, id: "topic0000001" },
      { channelId: "UC-three", durationSec: 261, fingerprint: WRONG_SONG, id: "wrong0000001" },
    ];
    const { dir, downloads, lines, memory, value } = await walk(uploads);

    expect(value?.verdict).toBe("consensus");
    expect(value?.videoId).toBe("ukf00000001");
    expect(captureVerificationFor("consensus")).toBe("consensus-verified");

    expect(value?.path).toBe(join(dir, "audio.webm"));
    expect(existsSync(value?.path ?? "")).toBe(true);
    expect(Buffer.from(value?.bytes ?? []).toString("utf8")).toBe("bytes of ukf00000001");
    expect(value?.digest).toBe(createHash("sha256").update("bytes of ukf00000001").digest("hex"));
    expect(readdirSync(dir)).toEqual(["audio.webm"]);

    expect(memory.dirty).toBe(true);
    expect(memory.sources.map((entry) => entry.videoId)).toEqual(["wrong0000001"]);

    expect(downloads).toEqual(["ukf00000001", "topic0000001", "wrong0000001"]);

    const line = lines.find((entry) => entry.includes("accepting ukf00000001 on consensus"));
    expect(line).toContain("preview gate rejected 3 duration-verified candidate(s)");
    expect(line).toContain("2 of them agree with each other (ber=0.0");
  });

  test("two agreeing uploads from the SAME channel are one witness → unmatched, all remembered", async () => {
    const uploads: Upload[] = [
      { channelId: "UC-one", durationSec: 259, fingerprint: UKF, id: "ukf00000001" },
      { channelId: "UC-one", durationSec: 260, fingerprint: TOPIC, id: "ukf00000002" },
      { channelId: "UC-three", durationSec: 261, fingerprint: WRONG_SONG, id: "wrong0000001" },
    ];
    const { dir, memory, value } = await walk(uploads);

    expect(value).toBeNull();

    expect(memory.sources.map((entry) => entry.videoId)).toEqual([
      "ukf00000001",
      "ukf00000002",
      "wrong0000001",
    ]);
    expect(memory.sources.every((entry) => entry.reason === "fingerprint-mismatch")).toBe(true);
    expect(existsSync(join(dir, "held-ukf00000001.webm"))).toBe(false);
  });

  test("a candidate with no channel identity cannot be shown independent and is never counted", async () => {
    const uploads: Upload[] = [
      { channelId: "UC-one", durationSec: 259, fingerprint: UKF, id: "ukf00000001" },
      { durationSec: 260, fingerprint: TOPIC, id: "nochan00001" },
    ];
    const { memory, value } = await walk(uploads);

    expect(value).toBeNull();
    expect(memory.sources.map((entry) => entry.videoId)).toEqual(["ukf00000001", "nochan00001"]);

    const blank = [
      {
        candidate: { channel: "", channelId: "", durationSec: 259, id: "a", title: "" },
        fingerprint: UKF,
      },
      { candidate: { channelId: "  ", durationSec: 260, id: "b", title: "" }, fingerprint: TOPIC },
    ];
    expect(findConsensus(blank)).toBeNull();
    expect(
      findConsensus([
        ...blank,
        {
          candidate: { channelId: "UC-real", durationSec: 261, id: "c", title: "" },
          fingerprint: SLEEPLESS,
        },
      ]),
    ).toBeNull();
  });

  test("END TO END: a consensus acceptance passes the journal's completion gate and advances the journal", async () => {
    const uploads: Upload[] = [
      { channelId: "UC-one", durationSec: 259, fingerprint: UKF, id: "ukf00000001" },
      { channelId: "UC-two", durationSec: 260, fingerprint: TOPIC, id: "topic0000001" },
      { channelId: "UC-three", durationSec: 261, fingerprint: WRONG_SONG, id: "wrong0000001" },
    ];
    const { ports } = fakePorts(uploads);
    const memory = freshMemory();
    const journalDir = workdir();
    const journalPath = join(journalDir, `${"c".repeat(64)}.json`);

    const run = await withLog(() =>
      runJournaledCaptureProvider({
        completion: (accepted) => captureProviderCompletion(accepted, memory),
        finding,
        kind: "capture",
        progressPath: () => journalPath,
        provider: (directory) =>
          findVerifiedUpload({ dir: directory, finding, memory, ports, session: fakeSession() }),
        snapshotToken: "snapshot-token",
      }),
    );

    expect(run.value.disposition).toBe("completed");
    if (run.value.disposition !== "completed") {
      return;
    }
    expect(run.value.value?.verdict).toBe("consensus");
    expect(readdirSync(run.value.workDirectory)).toEqual(["audio.webm"]);
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      attempt: { completion?: Record<string, unknown>; state: string };
    };
    expect(journal.attempt.state).toBe("provider-completed");
    expect(journal.attempt.completion).toMatchObject({
      digest: createHash("sha256").update("bytes of ukf00000001").digest("hex"),
      ext: "webm",
      fileName: "audio.webm",
      outcome: "accepted",
      verdict: "consensus",
      videoId: "ukf00000001",
    });

    expect(JSON.parse(String(journal.attempt.completion?.rejectedSources))).toMatchObject([
      { videoId: "wrong0000001" },
    ]);
  });

  test("a provider throw settles as `failed` through the same journal path — the intent journal never wedges a row", async () => {
    const journalDir = workdir();
    const journalPath = join(journalDir, `${"d".repeat(64)}.json`);
    let providerCalls = 0;
    const thrown = await runJournaledCaptureProvider({
      completion: () => ({
        completedAt: "2026-09-08T10:00:00.000Z",
        digest: "e".repeat(64),
        ext: "webm",

        fileName: "held-x.webm",
        outcome: "accepted",
        source: "youtube",
        verdict: "consensus",
        videoId: "x",
      }),
      finding,
      kind: "capture",
      progressPath: () => journalPath,
      provider: async (directory) => {
        providerCalls += 1;
        writeFileSync(join(directory, "held-x.webm"), "bytes");
        return null;
      },
      snapshotToken: "snapshot-token",
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((thrown as Error).message).toContain("unsafe completed file");
    expect(JSON.parse(readFileSync(journalPath, "utf8"))).toMatchObject({
      attempt: { state: "provider-intent" },
    });

    const progressPorts: CaptureProgressPorts = {
      admittedPhase: () => {
        throw new Error("unexpected admitted phase");
      },
      authorizeProgress: async (progress) => ({
        ...progress,
        receipt: {
          commitToken: "commit-token",
          operationId: "track.capture",
          operationKey: "track.capture:receipt",
          requestDigest: "a".repeat(64),
        },
      }),
      prepareCurrentSnapshot: () => ({
        prepared: true,
        snapshotToken: "snapshot-token",
        track: {
          artists: [],
          certified: true,
          logId: "012.3.4B",
          title: "x",
          trackId: finding.trackId,
        },
      }),
      progressPath: () => journalPath,
      r2Exists: async () => true,
      r2Put: async () => {
        throw new Error("unexpected R2 PUT");
      },
    };
    await persistAndCommit(
      finding.trackId,
      "snapshot-token",
      { attemptedAt: "2026-09-08T10:00:00.000Z", kind: "capture", outcome: "failed" },
      progressPorts,
    );

    expect(providerCalls).toBe(1);
    const settled = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, unknown>;
    expect(settled).not.toHaveProperty("attempt");
    expect(settled).toMatchObject({
      receipt: { operationId: "track.capture" },
      result: { kind: "capture", outcome: "failed" },
    });

    const captureFn = source.slice(
      source.indexOf("async function captureFinding("),
      source.indexOf("export type ProvenanceLadderCounts ="),
    );
    const failurePath = captureFn.slice(captureFn.indexOf("} catch (error) {"));
    expect(failurePath).toContain('outcome: "failed"');
    expect(failurePath).toContain("await persistAndCommit(trackId, snapshotToken, {");
  });

  test("an agreeing upload that FAILED the duration guard has no say — one held witness is no consensus", async () => {
    const uploads: Upload[] = [
      { channelId: "UC-one", durationSec: 259, fingerprint: UKF, id: "ukf00000001" },

      { channelId: "UC-two", durationSec: 260, fingerprint: TOPIC, id: "topic0000001" },
    ];
    const { memory, value } = await walk(uploads, {
      probeDurationSec: (path) => (readFileSync(path, "utf8").includes("topic0000001") ? 360 : 259),
    });

    expect(value).toBeNull();

    expect(memory.sources.map((entry) => entry.videoId)).toEqual(["ukf00000001"]);
  });

  test("a preview MATCH later in the walk wins over any consensus — the held pair is remembered as before", async () => {
    const full = [...WRONG_SONG];
    full.splice(Math.floor((full.length - 240) / 2), 240, ...PREVIEW);
    const uploads: Upload[] = [
      { channelId: "UC-a", durationSec: 259, fingerprint: UKF, id: "a0000000001" },
      { channelId: "UC-b", durationSec: 260, fingerprint: TOPIC, id: "b0000000001" },
      { channelId: "UC-c", durationSec: 261, fingerprint: full, id: "c0000000001" },
    ];
    const { dir, memory, value } = await walk(uploads);

    expect(value?.verdict).toBe("match");
    expect(value?.videoId).toBe("c0000000001");
    expect(value?.path).toBe(join(dir, "audio.webm"));
    expect(memory.sources.map((entry) => entry.videoId)).toEqual(["a0000000001", "b0000000001"]);
    expect(existsSync(join(dir, "held-a0000000001.webm"))).toBe(false);
    expect(existsSync(join(dir, "held-b0000000001.webm"))).toBe(false);
  });

  test("no extra downloads: the held set is bounded by the walk's own attempt budget", async () => {
    const uploads: Upload[] = [
      { channelId: "UC-x", durationSec: 259, fingerprint: WRONG_SONG, id: "x0000000001" },
      { channelId: "UC-y", durationSec: 260, fingerprint: recording(5), id: "y0000000001" },
      { channelId: "UC-z", durationSec: 261, fingerprint: recording(6), id: "z0000000001" },
      { channelId: "UC-one", durationSec: 262, fingerprint: UKF, id: "ukf00000001" },
      { channelId: "UC-two", durationSec: 263, fingerprint: TOPIC, id: "topic0000001" },
    ];
    const { downloads, value } = await walk(uploads);

    expect(value).toBeNull();
    expect(downloads).toEqual(["x0000000001", "y0000000001", "z0000000001"]);
  });

  test("a thrown error mid-walk still remembers what was held and deletes its file", async () => {
    const uploads: Upload[] = [
      { channelId: "UC-one", durationSec: 259, fingerprint: UKF, id: "ukf00000001" },
      { channelId: "UC-two", durationSec: 260, fingerprint: TOPIC, id: "topic0000001" },
    ];
    const dir = workdir();
    const { ports } = fakePorts(uploads, {
      download: (_proxy, candidate, directory) => {
        if (candidate.id === "topic0000001") {
          throw new Error("yt-dlp download failed: proxy tunnel reset");
        }
        const path = join(directory, "audio.webm");
        writeFileSync(path, `bytes of ${candidate.id}`);
        return { ext: "webm", path };
      },
    });
    const memory = freshMemory();

    const { value: error } = await withLog(() =>
      findVerifiedUpload({ dir, finding, memory, ports, session: fakeSession() }).then(
        () => undefined,
        (caught: unknown) => caught,
      ),
    );

    expect((error as Error).message).toContain("proxy tunnel reset");
    expect(memory.sources.map((entry) => entry.videoId)).toEqual(["ukf00000001"]);
    expect(existsSync(join(dir, "held-ukf00000001.webm"))).toBe(false);
  });

  test("the abstain path is untouched: no reference → the first duration-verified upload, `no-reference`, nothing held", async () => {
    const uploads: Upload[] = [
      { channelId: "UC-one", durationSec: 259, fingerprint: UKF, id: "ukf00000001" },
      { channelId: "UC-two", durationSec: 260, fingerprint: TOPIC, id: "topic0000001" },
    ];
    const { downloads, memory, value } = await walk(uploads, {
      referenceFingerprint: async () => null,
    });

    expect(value?.verdict).toBe("no-reference");
    expect(value?.videoId).toBe("ukf00000001");
    expect(downloads).toEqual(["ukf00000001"]);
    expect(memory.dirty).toBe(false);
  });

  test("findConsensus — every downloaded witness counts, the highest-ranked leads, no channel means no vote", () => {
    const held = [
      {
        candidate: { channelId: "UC-ukf", durationSec: 259, id: "ukf", title: "" },
        fingerprint: UKF,
      },
      {
        candidate: { channelId: "UC-sleepless", durationSec: 259, id: "sleepless", title: "" },
        fingerprint: SLEEPLESS,
      },
      {
        candidate: { channelId: "UC-topic", durationSec: 259, id: "topic", title: "" },
        fingerprint: TOPIC,
      },
      {
        candidate: { channelId: "UC-flatch", durationSec: 262, id: "flatch", title: "" },
        fingerprint: FLATCH,
      },
    ];
    const verdict = findConsensus(held);

    expect(verdict?.accepted.candidate.id).toBe("ukf");
    expect(verdict?.agreeing.map((entry) => entry.candidate.id).sort()).toEqual([
      "flatch",
      "sleepless",
      "topic",
    ]);
    expect(verdict?.bers.every((ber) => ber > 0 && ber < 0.1)).toBe(true);

    const unnamedFirst = [
      { candidate: { durationSec: 259, id: "anon", title: "" }, fingerprint: UKF },
      ...held.slice(1),
    ];
    expect(findConsensus(unnamedFirst)?.accepted.candidate.id).toBe("sleepless");

    expect(
      findConsensus([
        ...held.slice(0, 1),
        {
          candidate: { channelId: "UC-other", durationSec: 259, id: "other", title: "" },
          fingerprint: WRONG_SONG,
        },
      ]),
    ).toBeNull();

    expect(findConsensus(held.slice(0, 1))).toBeNull();
    expect(findConsensus([])).toBeNull();
  });

  test("the journal replay and the inline path stamp `consensus-verified` through the ONE mapping", () => {
    expect(captureVerificationFor("consensus")).toBe("consensus-verified");
    expect(source).toContain('verdict: "consensus" | "match" | "no-reference" | "operator"');

    expect(source).toContain('"consensus-verified"');
    const contract = readFileSync(
      new URL("../../../../packages/contracts/src/orpc/admin-tracks.ts", import.meta.url),
      "utf8",
    );
    expect(contract).toContain('"consensus-verified"');
  });
});
