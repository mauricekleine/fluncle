import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function stubSource(
  callsFile: string,
  modeFile: string,
  beatportModeFile: string,
  discogsFactsModeFile: string,
  deezerModeFile: string,
): string {
  return `#!/bin/bash
case "$1" in
  ok-json) printf '{"ok":true,"lovedCount":2,"failedCount":0}\\n' ;;
  partial) printf '{"ok":false,"lovedCount":2,"failedCount":1,"skippedCount":0,"rateLimited":false,"dryRun":false}\\n'; exit 1 ;;
  cli-error) printf '{"code":"missing_token","message":"Missing required env vars: FLUNCLE_API_TOKEN","ok":false}\\n'; exit 1 ;;
  crash) printf 'boom\\n' >&2; exit 1 ;;
  not-json) printf 'plain text\\n' ;;
  admin)
    printf '%s\\n' "$*" >> ${JSON.stringify(callsFile)}
    case "$3" in
      discogs) printf '{"ok":true,"resolvedCount":1,"unresolvedCount":2,"skippedCount":3,"rateLimited":true,"rateLimitedBy":"musicbrainz"}\\n' ;;
      lastfm) printf '{"ok":true,"lovedCount":4,"failedCount":0,"skippedCount":5,"rateLimited":false}\\n' ;;
      apple-music) printf '{"ok":true,"configured":true,"resolvedCount":6,"unresolvedCount":7,"failedCount":0,"skippedCount":8,"rateLimited":false}\\n' ;;
      apple-catalogue)
        mode="ok"
        if [ -f ${JSON.stringify(modeFile)} ]; then mode="$(cat ${JSON.stringify(modeFile)})"; fi
        case "$mode" in
          unconfigured) printf '{"ok":true,"configured":false,"resolvedCount":0,"unresolvedCount":0,"failedCount":0,"albumFactsWritten":0,"rateLimited":false,"breakerTripped":false}\\n' ;;
          crash) printf 'apple boom\\n' >&2; exit 1 ;;
          *) printf '{"ok":true,"configured":true,"resolvedCount":9,"unresolvedCount":10,"failedCount":11,"albumFactsWritten":12,"rateLimited":true,"breakerTripped":true}\\n' ;;
        esac
        ;;
      beatport)
        mode="ok"
        if [ -f ${JSON.stringify(beatportModeFile)} ]; then mode="$(cat ${JSON.stringify(beatportModeFile)})"; fi
        case "$mode" in
          unconfigured) printf '{"ok":true,"configured":false,"resolvedCount":0,"unresolvedCount":0,"failedCount":0,"skippedCount":0,"catalogueResolvedCount":0,"catalogueUnresolvedCount":0,"catalogueFailedCount":0}\\n' ;;
          crash) printf 'beatport boom\\n' >&2; exit 1 ;;
          partial) printf '{"ok":false,"configured":true,"resolvedCount":3,"unresolvedCount":4,"failedCount":5,"skippedCount":6,"catalogueResolvedCount":7,"catalogueUnresolvedCount":8,"catalogueFailedCount":9}\\n'; exit 1 ;;
          *) printf '{"ok":true,"configured":true,"resolvedCount":13,"unresolvedCount":14,"failedCount":15,"skippedCount":16,"catalogueResolvedCount":20,"catalogueUnresolvedCount":21,"catalogueFailedCount":22}\\n' ;;
        esac
        ;;
      deezer)
        mode="ok"
        if [ -f ${JSON.stringify(deezerModeFile)} ]; then mode="$(cat ${JSON.stringify(deezerModeFile)})"; fi
        case "$mode" in
          throttled) printf '{"ok":true,"resolvedCount":0,"unresolvedCount":0,"unvouchableCount":0,"failedCount":0,"rateLimited":true}\\n' ;;
          pending) printf '{"code":"due_work_maintenance_pending","message":"Due-work maintenance is still converging","ok":false}\\n'; exit 1 ;;
          crash) printf 'deezer boom\\n' >&2; exit 1 ;;
          partial) printf '{"ok":false,"resolvedCount":2,"unresolvedCount":3,"unvouchableCount":4,"failedCount":5,"rateLimited":false}\\n'; exit 1 ;;
          *) printf '{"ok":true,"resolvedCount":23,"unresolvedCount":24,"unvouchableCount":25,"failedCount":26,"rateLimited":false}\\n' ;;
        esac
        ;;
      discogs-facts)
        mode="ok"
        if [ -f ${JSON.stringify(discogsFactsModeFile)} ]; then mode="$(cat ${JSON.stringify(discogsFactsModeFile)})"; fi
        case "$mode" in
          unconfigured) printf '{"ok":true,"configured":false,"resolvedCount":0,"noneCount":0,"failedCount":0,"rateLimited":false}\\n' ;;
          crash) printf 'discogs facts boom\\n' >&2; exit 1 ;;
          *) printf '{"ok":true,"configured":true,"resolvedCount":17,"noneCount":18,"failedCount":19,"rateLimited":true}\\n' ;;
        esac
        ;;
    esac
    ;;
esac
`;
}

let fluncleJson: <T>(args: string[]) => T;
let runBackfillSweepImpl: (
  effects: import("./backfill-sweep").BackfillSweepEffects,
) => Promise<Record<string, unknown>>;
let backfillSweepExitCode: (summary: { ok: boolean }) => 0 | 1;
let stubDir: string;
let callsFile: string;
let modeFile: string;
let beatportModeFile: string;
let discogsFactsModeFile: string;
let deezerModeFile: string;

beforeAll(async () => {
  stubDir = mkdtempSync(join(tmpdir(), "fluncle-stub-"));
  const stub = join(stubDir, "fluncle");
  callsFile = join(stubDir, "calls.log");
  modeFile = join(stubDir, "catalogue-mode");
  beatportModeFile = join(stubDir, "beatport-mode");
  discogsFactsModeFile = join(stubDir, "discogs-facts-mode");
  deezerModeFile = join(stubDir, "deezer-mode");
  writeFileSync(
    stub,
    stubSource(callsFile, modeFile, beatportModeFile, discogsFactsModeFile, deezerModeFile),
  );
  chmodSync(stub, 0o755);
  process.env.FLUNCLE_BIN = stub;
  const sweep = await import("./backfill-sweep");
  backfillSweepExitCode = sweep.backfillSweepExitCode;
  fluncleJson = sweep.fluncleJson;
  runBackfillSweepImpl = sweep.runBackfillSweep as typeof runBackfillSweepImpl;
});

afterEach(() => {
  rmSync(callsFile, { force: true });
  rmSync(modeFile, { force: true });
  rmSync(beatportModeFile, { force: true });
  rmSync(discogsFactsModeFile, { force: true });
  rmSync(deezerModeFile, { force: true });
});

afterAll(() => {
  rmSync(stubDir, { force: true, recursive: true });
});

function recordedCalls(): string[] {
  if (!existsSync(callsFile)) {
    return [];
  }

  return readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean);
}

async function runBackfillSweep(): Promise<Record<string, unknown>> {
  const seenOperations = new Set<string>();
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const inputUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(inputUrl);
    const operation = url.pathname.endsWith("/discogs-facts") ? "discogs-facts" : "discogs";
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer agent-test-token");
    expect(url.searchParams.get("boxFetch")).toBe("true");
    expect(url.searchParams.get("limit")).toBe(operation === "discogs" ? "3" : "10");

    if (init?.body !== undefined) {
      expect(typeof init.body).toBe("string");
      const parsed = JSON.parse(init.body as string) as { discogsCandidates?: unknown[] };
      expect(Array.isArray(parsed.discogsCandidates)).toBe(true);
    }

    if (!seenOperations.has(operation)) {
      appendFileSync(
        callsFile,
        `admin backfills ${operation} --limit ${operation === "discogs" ? "3" : "10"} --json\n`,
      );
      seenOperations.add(operation);
    }

    if (operation === "discogs-facts") {
      const mode = existsSync(discogsFactsModeFile)
        ? readFileSync(discogsFactsModeFile, "utf8")
        : "ok";

      if (mode === "crash") {
        throw new Error("discogs facts boom");
      }

      if (mode === "unconfigured") {
        return Response.json({
          configured: false,
          discogsWork: [],
          failedCount: 0,
          noneCount: 0,
          ok: true,
          rateLimited: false,
          resolvedCount: 0,
        });
      }

      if (mode === "prepared-partial" && init?.body === undefined) {
        return Response.json({
          configured: true,
          discogsWork: [],
          failedCount: 5,
          noneCount: 4,
          ok: true,
          rateLimited: false,
          resolvedCount: 3,
        });
      }

      if (init?.body === undefined) {
        return Response.json({
          configured: true,
          discogsWork: [{ releaseId: 7, slug: "album" }],
          failedCount: 0,
          noneCount: 0,
          ok: true,
          rateLimited: false,
          resolvedCount: 0,
        });
      }

      if (mode === "decided-partial") {
        return Response.json({
          configured: true,
          discogsWork: [],
          failedCount: 5,
          noneCount: 4,
          ok: true,
          rateLimited: false,
          resolvedCount: 3,
        });
      }

      return Response.json({
        configured: true,
        discogsWork: [],
        failedCount: 0,
        noneCount: 18,
        ok: true,
        rateLimited: true,
        resolvedCount: 17,
      });
    }

    if (init?.body === undefined) {
      return Response.json({
        discogsWork: [{ queries: ["track=Tune&type=release"], trackId: "trk_1" }],
        ok: true,
        rateLimited: false,
        rateLimitedBy: null,
        resolvedCount: 0,
        skippedCount: 0,
        unresolvedCount: 0,
      });
    }

    return Response.json({
      discogsWork: [],
      ok: true,
      rateLimited: true,
      rateLimitedBy: "musicbrainz",
      resolvedCount: 1,
      skippedCount: 3,
      unresolvedCount: 2,
    });
  }) as typeof globalThis.fetch;

  return runBackfillSweepImpl({
    createFetcher: () => ({
      fetchFactsCandidates: async () => ({
        candidates: [
          {
            release: {
              artists: [],
              formats: [],
              id: 7,
              labels: [],
              styles: [],
              tracklist: [],
            },
            slug: "album",
          },
        ],
        ok: true,
        rateLimited: false,
      }),
      fetchReleaseCandidates: async () => ({
        candidates: [{ releases: [], trackId: "trk_1" }],
        ok: true,
        rateLimited: false,
      }),
    }),
    env: {
      DISCOGS_USER_TOKEN: "discogs-test-token",
      FLUNCLE_API_BASE_URL: "https://worker.example",
      FLUNCLE_API_TOKEN: "agent-test-token",
    },
    fetch,
  });
}

describe("fluncleJson parse-first contract", () => {
  test("exit 0 with JSON returns the parsed payload", () => {
    expect(fluncleJson<{ lovedCount: number; ok: boolean }>(["ok-json"])).toEqual({
      failedCount: 0,
      lovedCount: 2,
      ok: true,
    });
  });

  test("exit 1 with a partial-failure summary RETURNS it — the counts survive", () => {
    const summary = fluncleJson<{ failedCount: number; lovedCount: number; ok: boolean }>([
      "partial",
    ]);

    expect(summary.ok).toBe(false);
    expect(summary.lovedCount).toBe(2);
    expect(summary.failedCount).toBe(1);
  });

  test("exit 1 with the CLI's own error payload throws with its message", () => {
    expect(() => fluncleJson(["cli-error"])).toThrow(
      "fluncle cli-error failed (missing_token): Missing required env vars: FLUNCLE_API_TOKEN",
    );
  });

  test("exit 1 with unparseable stdout throws the exit-code error (stderr attached)", () => {
    expect(() => fluncleJson(["crash"])).toThrow("fluncle crash exited 1: boom");
  });

  test("exit 0 with unparseable stdout throws the not-JSON error", () => {
    expect(() => fluncleJson(["not-json"])).toThrow("fluncle not-json did not return JSON");
  });
});

describe("the tick's legs", () => {
  test("the catalogue Apple leg runs LAST, after the certified apple-music leg", async () => {
    await runBackfillSweep();

    const sources = recordedCalls().map((call) => call.split(" ")[2]);

    expect(sources).toEqual([
      "discogs",
      "lastfm",
      "apple-music",
      "apple-catalogue",
      "beatport",
      "discogs-facts",
      "deezer",
    ]);
  });

  test("the catalogue leg asks for one server pass — --limit 100, the server's own ceiling", async () => {
    await runBackfillSweep();

    const catalogue = recordedCalls().find((call) => call.includes("apple-catalogue"));

    expect(catalogue).toBe("admin backfills apple-catalogue --limit 100 --json");
  });

  test("the catalogue counts land in the summary under their own key", async () => {
    const summary = await runBackfillSweep();

    expect(summary["apple-catalogue"]).toEqual({
      albumFacts: 12,
      breakerTripped: true,
      configured: true,
      error: null,
      failed: 11,
      resolved: 9,
      throttled: true,
      unresolved: 10,
    });
  });

  test("the new leg does not disturb the three that were already there", async () => {
    const summary = await runBackfillSweep();

    expect(summary.discogs).toEqual({
      error: null,
      resolved: 1,
      skipped: 3,
      throttled: false,
      unresolved: 2,
    });
    expect(summary.musicbrainz).toEqual({ throttled: true });
    expect(summary.lastfm).toEqual({
      error: null,
      failed: 0,
      loved: 4,
      skipped: 5,
      throttled: false,
    });
    expect(summary["apple-music"]).toEqual({
      configured: true,
      error: null,
      failed: 0,
      resolved: 6,
      skipped: 8,
      throttled: false,
      unresolved: 7,
    });
  });

  test("an unconfigured catalogue leg is a recorded no-op, not a failed tick", async () => {
    writeFileSync(modeFile, "unconfigured");

    const summary = await runBackfillSweep();

    expect(summary["apple-catalogue"]).toEqual({
      albumFacts: 0,
      breakerTripped: false,
      configured: false,
      error: null,
      failed: 0,
      resolved: 0,
      throttled: false,
      unresolved: 0,
    });

    expect(summary.ok).toBe(true);
    expect((summary["apple-music"] as { resolved: number }).resolved).toBe(6);
  });

  test("a catalogue leg that crashes records its error and makes the tick report failure", async () => {
    writeFileSync(modeFile, "crash");

    const summary = await runBackfillSweep();

    expect((summary["apple-catalogue"] as { error: null | string }).error).toContain("apple boom");
    expect((summary["apple-music"] as { resolved: number }).resolved).toBe(6);
    expect(summary.ok).toBe(false);
    expect(backfillSweepExitCode(summary as { ok: boolean })).toBe(1);
  });

  test("the Beatport leg asks for the smallest batch in the sweep — one rendered scrape each", async () => {
    await runBackfillSweep();

    const beatport = recordedCalls().find((call) => call.includes("beatport"));

    expect(beatport).toBe("admin backfills beatport --limit 10 --json");
  });

  test("the Beatport counts land in the summary under their own key", async () => {
    const summary = await runBackfillSweep();

    expect(summary.beatport).toEqual({
      catalogueFailed: 22,
      catalogueResolved: 20,
      catalogueUnresolved: 21,
      configured: true,
      error: null,
      failed: 15,
      resolved: 13,
      skipped: 16,
      unresolved: 14,
    });
    expect(summary.ok).toBe(true);
  });

  test("the Beatport CATALOGUE tier is tallied apart from the certified one", async () => {
    const summary = await runBackfillSweep();
    const beatport = summary.beatport as Record<string, number>;

    expect(beatport.resolved).toBe(13);
    expect(beatport.catalogueResolved).toBe(20);
    expect(beatport.catalogueUnresolved).toBe(21);
    expect(beatport.catalogueFailed).toBe(22);
  });

  test("canonical counters use handled rows, exclude reliability skips, and omit queue depth", async () => {
    const summary = await runBackfillSweep();

    expect(summary.checked).toBe(263);
    expect(summary.produced).toBe(93);
    expect(summary.failed).toBe(74);
    expect(summary.errors).toBe(0);
    expect(summary.ok).toBe(true);
    expect(backfillSweepExitCode(summary as { ok: boolean })).toBe(0);
    expect(summary).not.toHaveProperty("queue_depth");
  });

  test("measured zero canonical counters survive as zero, never null", async () => {
    writeFileSync(modeFile, "unconfigured");
    writeFileSync(beatportModeFile, "unconfigured");

    const summary = await runBackfillSweep();

    expect(summary.checked).toBe(128);
    expect(summary.produced).toBe(51);
    expect(summary.errors).toBe(0);
  });

  test("an unconfigured Beatport leg is a recorded no-op, not a failed tick", async () => {
    writeFileSync(beatportModeFile, "unconfigured");

    const summary = await runBackfillSweep();

    expect(summary.beatport).toEqual({
      catalogueFailed: 0,
      catalogueResolved: 0,
      catalogueUnresolved: 0,
      configured: false,
      error: null,
      failed: 0,
      resolved: 0,
      skipped: 0,
      unresolved: 0,
    });
    expect(summary.ok).toBe(true);
  });

  test("a Beatport leg that crashes records its error and leaves every earlier leg intact", async () => {
    writeFileSync(beatportModeFile, "crash");

    const summary = await runBackfillSweep();

    expect((summary.beatport as { error: null | string }).error).toContain("beatport boom");
    expect((summary["apple-music"] as { resolved: number }).resolved).toBe(6);
    expect((summary["apple-catalogue"] as { resolved: number }).resolved).toBe(9);
    expect((summary.discogs as { resolved: number }).resolved).toBe(1);
    expect(summary.errors).toBe(1);
    expect(summary.ok).toBe(false);
    expect(backfillSweepExitCode(summary as { ok: boolean })).toBe(1);
  });

  test("a Beatport partial response preserves its counts and makes the tick fail", async () => {
    writeFileSync(beatportModeFile, "partial");

    const summary = await runBackfillSweep();

    expect(summary.beatport).toEqual({
      catalogueFailed: 9,
      catalogueResolved: 7,
      catalogueUnresolved: 8,
      configured: true,
      error: null,
      failed: 5,
      resolved: 3,
      skipped: 6,
      unresolved: 4,
    });
    expect((summary["apple-music"] as { resolved: number }).resolved).toBe(6);
    expect(summary.failed).toBe(51);
    expect(summary.ok).toBe(false);
    expect(backfillSweepExitCode(summary as { ok: boolean })).toBe(1);
  });

  test("the Discogs-facts leg runs AFTER the Discogs one and asks for its own small batch", async () => {
    await runBackfillSweep();

    const calls = recordedCalls();
    const sources = calls.map((call) => call.split(" ")[2]);
    const facts = calls.find((call) => call.includes("discogs-facts"));

    expect(facts).toBe("admin backfills discogs-facts --limit 10 --json");
    expect(sources.indexOf("discogs-facts")).toBeGreaterThan(sources.indexOf("discogs"));
  });

  test("the Discogs-facts counts land in the summary under their own key", async () => {
    const summary = await runBackfillSweep();

    expect(summary["discogs-facts"]).toEqual({
      configured: true,
      error: null,
      failed: 0,
      none: 18,
      resolved: 17,
      throttled: true,
    });
  });

  test("a prepared Discogs-facts partial preserves every count and fails the tick", async () => {
    writeFileSync(discogsFactsModeFile, "prepared-partial");

    const summary = await runBackfillSweep();

    expect(summary["discogs-facts"]).toEqual({
      configured: true,
      error: null,
      failed: 5,
      none: 4,
      resolved: 3,
      throttled: false,
    });
    expect(summary.checked).toBe(240);
    expect(summary.produced).toBe(79);
    expect(summary.failed).toBe(79);
    expect(summary.errors).toBe(0);
    expect(summary.ok).toBe(false);
    expect(backfillSweepExitCode(summary as { ok: boolean })).toBe(1);
  });

  test("a decided Discogs-facts partial preserves every count and fails the tick", async () => {
    writeFileSync(discogsFactsModeFile, "decided-partial");

    const summary = await runBackfillSweep();

    expect(summary["discogs-facts"]).toEqual({
      configured: true,
      error: null,
      failed: 5,
      none: 4,
      resolved: 3,
      throttled: false,
    });
    expect(summary.checked).toBe(240);
    expect(summary.produced).toBe(79);
    expect(summary.failed).toBe(79);
    expect(summary.errors).toBe(0);
    expect(summary.ok).toBe(false);
    expect(backfillSweepExitCode(summary as { ok: boolean })).toBe(1);
  });

  test("an unconfigured Discogs-facts leg is a recorded no-op, not a failed tick", async () => {
    writeFileSync(discogsFactsModeFile, "unconfigured");

    const summary = await runBackfillSweep();

    expect(summary["discogs-facts"]).toEqual({
      configured: false,
      error: null,
      failed: 0,
      none: 0,
      resolved: 0,
      throttled: false,
    });
    expect(summary.ok).toBe(true);
  });

  test("a Discogs-facts leg that crashes records its error and leaves every earlier leg intact", async () => {
    writeFileSync(discogsFactsModeFile, "crash");

    const summary = await runBackfillSweep();

    expect((summary["discogs-facts"] as { error: null | string }).error).toContain(
      "discogs facts boom",
    );
    expect((summary.discogs as { resolved: number }).resolved).toBe(1);
    expect((summary.beatport as { resolved: number }).resolved).toBe(13);
  });

  test("the Deezer leg runs LAST and asks for its own per-IP-safe batch", async () => {
    await runBackfillSweep();

    const calls = recordedCalls();
    const deezer = calls.find((call) => call.includes("deezer"));

    expect(deezer).toBe("admin backfills deezer --limit 25 --json");
    expect(calls.at(-1)).toBe(deezer);
  });

  test("the Deezer counts land in the summary under their own key", async () => {
    const summary = await runBackfillSweep();

    expect(summary.deezer).toEqual({
      error: null,
      failed: 26,
      resolved: 23,
      throttled: false,
      unresolved: 24,
      unvouchable: 25,
    });
    expect(summary.ok).toBe(true);
  });

  test("a throttled Deezer leg reads as THROTTLED, not as a silent zero", async () => {
    writeFileSync(deezerModeFile, "throttled");

    const summary = await runBackfillSweep();

    expect(summary.deezer).toEqual({
      error: null,
      failed: 0,
      resolved: 0,
      throttled: true,
      unresolved: 0,
      unvouchable: 0,
    });

    expect(summary.ok).toBe(true);
  });

  test("a Deezer leg that crashes records its error and leaves every earlier leg intact", async () => {
    writeFileSync(deezerModeFile, "crash");

    const summary = await runBackfillSweep();

    expect((summary.deezer as { error: null | string }).error).toContain("deezer boom");
    expect((summary.discogs as { resolved: number }).resolved).toBe(1);
    expect((summary.beatport as { resolved: number }).resolved).toBe(13);
    expect((summary["discogs-facts"] as { resolved: number }).resolved).toBe(17);
    expect(summary.errors).toBe(1);
    expect(summary.ok).toBe(false);
    expect(backfillSweepExitCode(summary as { ok: boolean })).toBe(1);
  });

  test("a Deezer partial response preserves its counts and makes the tick fail", async () => {
    writeFileSync(deezerModeFile, "partial");

    const summary = await runBackfillSweep();

    expect(summary.deezer).toEqual({
      error: null,
      failed: 5,
      resolved: 2,
      throttled: false,
      unresolved: 3,
      unvouchable: 4,
    });
    expect((summary.beatport as { resolved: number }).resolved).toBe(13);
    expect((summary["discogs-facts"] as { resolved: number }).resolved).toBe(17);
    expect(summary.failed).toBe(53);
    expect(summary.ok).toBe(false);
    expect(backfillSweepExitCode(summary as { ok: boolean })).toBe(1);
  });

  test("a leg the Worker defers pauses alone: the other legs still run and nothing is a run error", async () => {
    writeFileSync(deezerModeFile, "pending");

    const summary = await runBackfillSweep();

    expect(summary.repairPendingLegs).toEqual(["deezer"]);
    expect(summary).toMatchObject({
      errors: 0,
      gateState: "paused",
      partial: true,
      reason: "due_work_repair_pending",
      throttled: true,
    });
    expect(summary.deezer).toEqual({
      error: null,
      failed: 0,
      resolved: 0,
      throttled: false,
      unresolved: 0,
      unvouchable: 0,
    });
    expect((summary.beatport as { resolved: number }).resolved).toBe(13);
    expect((summary["discogs-facts"] as { resolved: number }).resolved).toBe(17);
  });
});
