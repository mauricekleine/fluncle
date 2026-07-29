// Unit tests for the pure logic in sentry-triage-sweep.ts — the parts that decide WHAT gets
// triaged and HOW the stateless loop reads its markers. The box scripts are self-contained (they
// cannot import the workspace) and live outside any package's test runner, so this file uses
// `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/sentry-triage-sweep.test.ts
//
// The network functions take an injectable `fetchFn`, so `listUnresolvedIssues` (the windowing +
// pagination) is exercised here against a canned two-page response — no real Sentry call.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compactIssue,
  extractFrames,
  FILE_MARKER,
  filterNewIssues,
  filterRecentlyMerged,
  FIX_MARKER,
  listUnresolvedIssues,
  parseLedgerIds,
  parseMarkerIds,
  parseNextCursor,
  type CompactIssue,
} from "./sentry-triage-sweep";

describe("parseMarkerIds — the PR-body contract", () => {
  const body = `Fixes the crash.\n\nSentry-Issue: 4507111\nSentry-Issue: #4507222\nsentry-issue: 4507333\n`;

  test("reads every Sentry-Issue ref (case-insensitive, tolerant of a leading #)", () => {
    expect(parseMarkerIds(body, FIX_MARKER)).toEqual(["4507111", "4507222", "4507333"]);
  });

  test("keeps the two markers disjoint — a fix ref is never read as a filed ref", () => {
    const ledgerBody = "Filed for review.\n\nSentry-Filed: 900\nSentry-Filed: 901\n";
    expect(parseMarkerIds(ledgerBody, FILE_MARKER)).toEqual(["900", "901"]);
    // The ledger PR carries NO Sentry-Issue line, so reconcile never resolves a filed issue.
    expect(parseMarkerIds(ledgerBody, FIX_MARKER)).toEqual([]);
  });

  test("dedupes repeated refs", () => {
    expect(parseMarkerIds("Sentry-Issue: 7\nSentry-Issue: 7\n", FIX_MARKER)).toEqual(["7"]);
  });
});

describe("parseLedgerIds — the invisible dedupe marker", () => {
  test("reads the sentry_id out of committed ledger rows", () => {
    const ledger = `| 2026-07-18 | fluncle-web | FLUNCLE-WEB-1A | boom | needs a human | open | url | <!-- sentry_id:4507999 --> |
| 2026-07-18 | fluncle-worker | FLUNCLE-WORKER-2B | bang | risky | open | url | <!-- sentry_id: 4508000 --> |`;
    expect(parseLedgerIds(ledger)).toEqual(["4507999", "4508000"]);
  });

  test("no markers → no ids (a fresh ledger is not covered)", () => {
    expect(parseLedgerIds("| filed | project | ... |\n")).toEqual([]);
  });
});

describe("filterNewIssues — the dedupe gate", () => {
  const issue = (id: string, count = 0): CompactIssue => ({
    count,
    culprit: "",
    firstSeen: "",
    id,
    lastSeen: "",
    level: "error",
    permalink: "",
    project: "fluncle-web",
    shortId: `S-${id}`,
    title: "t",
    type: "",
    value: "",
  });

  test("drops issues already covered by an open PR or the ledger", () => {
    const all = [issue("1"), issue("2"), issue("3")];
    const covered = new Set(["2"]);
    expect(filterNewIssues(all, covered).map((i) => i.id)).toEqual(["1", "3"]);
  });

  test("an empty covered set passes everything through", () => {
    const all = [issue("1"), issue("2")];
    expect(filterNewIssues(all, new Set()).map((i) => i.id)).toEqual(["1", "2"]);
  });
});

describe("filterRecentlyMerged — reconcile only resolves fresh merges", () => {
  const now = Date.parse("2026-07-18T03:30:00Z");
  const WINDOW = 48 * 60 * 60_000;
  const pr = (number: number, mergedAt: string | null) => ({
    body: `Sentry-Issue: ${number}`,
    headRefName: `sentry-triage/x-${number}`,
    mergedAt,
    number,
    url: `https://github.com/x/pull/${number}`,
  });

  test("keeps a PR merged inside the window, drops one merged before it", () => {
    const fresh = pr(1, "2026-07-17T20:00:00Z"); // ~7.5h ago
    const stale = pr(2, "2026-07-10T00:00:00Z"); // 8 days ago — a regression here must re-surface
    const kept = filterRecentlyMerged([fresh, stale], now, WINDOW);
    expect(kept.map((p) => p.number)).toEqual([1]);
  });

  test("drops a PR with no mergedAt (an open PR that slipped into the list)", () => {
    expect(filterRecentlyMerged([pr(3, null)], now, WINDOW)).toEqual([]);
  });

  test("the boundary is inclusive — exactly windowMs old still counts", () => {
    const edge = pr(4, new Date(now - WINDOW).toISOString());
    expect(filterRecentlyMerged([edge], now, WINDOW).map((p) => p.number)).toEqual([4]);
  });

  test("an unparseable mergedAt is dropped, never resolved", () => {
    expect(filterRecentlyMerged([pr(5, "not-a-date")], now, WINDOW)).toEqual([]);
  });
});

describe("compactIssue — normalizing the Sentry list shape", () => {
  test("pulls the error type + value out of metadata and coerces count", () => {
    const raw = {
      count: "42",
      culprit: "renderRow(app/row.tsx)",
      firstSeen: "2026-07-01T00:00:00Z",
      id: "4507111",
      lastSeen: "2026-07-18T00:00:00Z",
      level: "error",
      metadata: { type: "TypeError", value: "Cannot read properties of undefined" },
      permalink: "https://de.sentry.io/organizations/fluncle/issues/4507111/",
      shortId: "FLUNCLE-WEB-1A",
      title: "TypeError: Cannot read properties of undefined",
    };
    const c = compactIssue(raw, "fluncle-web");
    expect(c.count).toBe(42);
    expect(c.type).toBe("TypeError");
    expect(c.value).toBe("Cannot read properties of undefined");
    expect(c.project).toBe("fluncle-web");
  });

  test("falls back to the culprit when metadata.value is absent, and defaults level", () => {
    const c = compactIssue({ culprit: "boot()", id: "9" }, "fluncle-worker");
    expect(c.value).toBe("boot()");
    expect(c.level).toBe("error");
    expect(c.count).toBe(0);
  });
});

describe("parseNextCursor — bounded pagination", () => {
  test("returns the next cursor when results=true", () => {
    const link =
      '<https://de.sentry.io/...>; rel="previous"; results="false"; cursor="0:0:1", ' +
      '<https://de.sentry.io/...>; rel="next"; results="true"; cursor="0:100:0"';
    expect(parseNextCursor(link)).toBe("0:100:0");
  });

  test("stops when the next page has results=false", () => {
    const link = '<...>; rel="next"; results="false"; cursor="0:100:0"';
    expect(parseNextCursor(link)).toBeUndefined();
  });

  test("no Link header → no next page", () => {
    expect(parseNextCursor(null)).toBeUndefined();
  });
});

describe("extractFrames — the crash-site hint", () => {
  test("keeps only in-app frames, deepest last", () => {
    const event = {
      entries: [
        {
          data: {
            values: [
              {
                stacktrace: {
                  frames: [
                    { filename: "node_modules/x.js", function: "vendor", inApp: false, lineNo: 1 },
                    { filename: "src/a.ts", function: "a", inApp: true, lineNo: 10 },
                    { filename: "src/b.ts", function: "b", inApp: true, lineNo: 22 },
                  ],
                },
              },
            ],
          },
          type: "exception",
        },
      ],
    };
    expect(extractFrames(event)).toEqual([
      { file: "src/a.ts", function: "a", line: 10 },
      { file: "src/b.ts", function: "b", line: 22 },
    ]);
  });

  test("a payload with no exception entry yields no frames", () => {
    expect(extractFrames({ entries: [{ type: "message" }] })).toEqual([]);
  });
});

describe("listUnresolvedIssues — pagination + compaction against an injected fetch", () => {
  function pageResponse(rows: unknown[], nextCursor?: string): Response {
    const link = nextCursor
      ? `<x>; rel="next"; results="true"; cursor="${nextCursor}"`
      : `<x>; rel="next"; results="false"; cursor="0:0:0"`;
    return new Response(JSON.stringify(rows), { headers: { link }, status: 200 });
  }

  test("walks every page and compacts each row", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.href : "";
      calls.push(u);
      if (!u.includes("cursor=")) {
        return pageResponse([{ id: "1", metadata: { type: "E" }, shortId: "A-1" }], "0:100:0");
      }
      return pageResponse([{ id: "2", metadata: { type: "E" }, shortId: "A-2" }]);
    }) as typeof fetch;

    const issues = await listUnresolvedIssues("fluncle-web", "tok", { fetchFn });
    expect(issues.map((i) => i.id)).toEqual(["1", "2"]);
    expect(calls.length).toBe(2); // one follow-up page, then stop
    expect(calls[0]).toContain("/projects/fluncle/fluncle-web/issues/");
    expect(calls[0]).toContain("is%3Aunresolved");
  });

  // THE ASSERTION THIS SUITE WAS MISSING. It used to check the path and `is%3Aunresolved` and
  // stop — so the request could carry ANY other parameter and the deploy gate stayed green. It
  // carried `statsPeriod=90d`, which this endpoint rejects outright (`Invalid stats_period. Valid
  // choices are '', '24h', and '14d'`), and every nightly fetch 400'd for 11 nights unnoticed.
  // Pinning the WHOLE parameter set, not a subset, is what makes that unrepeatable: a new
  // parameter — valid or not — has to be added here deliberately.
  test("sends exactly query + limit, and never a stats period", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.href : "";
      calls.push(u);
      if (!u.includes("cursor=")) {
        return pageResponse([{ id: "1" }], "0:100:0");
      }
      return pageResponse([{ id: "2" }]);
    }) as typeof fetch;

    await listUnresolvedIssues("fluncle-web", "tok", { fetchFn });

    const [firstCall, secondCall] = calls;
    if (!firstCall || !secondCall) {
      throw new Error(`expected two paged requests, got ${calls.length}`);
    }

    const first = new URL(firstCall).searchParams;
    expect([...first.keys()].sort()).toEqual(["limit", "query"]);
    expect(first.get("query")).toBe("is:unresolved");
    expect(first.get("limit")).toBe("100");
    expect(first.get("statsPeriod")).toBeNull();

    // The follow-up page adds the cursor and nothing else.
    const second = new URL(secondCall).searchParams;
    expect([...second.keys()].sort()).toEqual(["cursor", "limit", "query"]);
    expect(second.get("cursor")).toBe("0:100:0");
    expect(second.get("statsPeriod")).toBeNull();
  });

  test("throws on a non-OK response so the driver records the per-project error", async () => {
    const fetchFn = (async () => new Response("forbidden", { status: 403 })) as typeof fetch;
    let message = "";
    try {
      await listUnresolvedIssues("fluncle-web", "bad", { fetchFn });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("403");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE SUMMARY LINE — the one thing /status reads, and the one thing that lied.
//
// The nightly sweep fetched ZERO issues for 11 nights and reported itself healthy. Two hardcoded
// `ok:true` literals did it, one in each half of the cron, and NEITHER was reachable by the unit
// tests above — so both suites below drive the REAL artifacts as subprocesses instead. The
// injected-fetch tests prove the helper's logic; these prove what the box actually prints.
//
// Neither suite touches the network: the Sentry API is a loopback fixture server, `gh` is a stub
// on a PATH this file controls, and the shell's git remote is a local bare repo.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const SWEEP_TS = join(import.meta.dir, "sentry-triage-sweep.ts");
const SWEEP_SH = join(import.meta.dir, "sentry-triage-sweep.sh");
const CRON_OUTPUT_SH = join(import.meta.dir, "cron-output.sh");

/** The prober's read: the LAST non-empty line of a stdout region, parsed as JSON. */
function lastJsonLine(text: string): Record<string, unknown> {
  const last = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  if (!last) {
    throw new Error(`no output to parse a summary from (got ${JSON.stringify(text)})`);
  }
  return JSON.parse(last) as Record<string, unknown>;
}

/** A `gh` that answers every query with an empty list, so no test can reach GitHub. */
function writeGhStub(dir: string): string {
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const gh = join(binDir, "gh");
  writeFileSync(gh, "#!/usr/bin/env bash\necho '[]'\n", "utf8");
  chmodSync(gh, 0o755);
  return binDir;
}

describe("fetch summary (the real sweep, against a fixture Sentry) — ok is DERIVED", () => {
  /**
   * Run `sentry-triage-sweep.ts fetch` for real against a loopback Sentry that either answers or
   * refuses, and hand back the summary line plus every request URL the server actually saw.
   */
  async function runFetch(
    mode: "answers" | "refuses",
  ): Promise<{ requests: string[]; summary: Record<string, unknown> }> {
    const root = mkdtempSync(join(tmpdir(), "fluncle-sentry-fetch-"));
    const requests: string[] = [];
    const server = Bun.serve({
      fetch(req) {
        const url = new URL(req.url);
        requests.push(url.pathname + url.search);
        // The frame-enrichment hop; irrelevant to the summary, answered so it never hangs.
        if (url.pathname.includes("/events/latest/")) {
          return Response.json({});
        }
        // Model the endpoint's REAL parameter contract, so this fixture cannot be more forgiving
        // than production. Even in "answers" mode, an out-of-range stats period is a 400 — which
        // is what makes re-introducing `statsPeriod=90d` turn the summary tests red too, not just
        // the assertion that names it.
        const statsPeriod = url.searchParams.get("statsPeriod");
        if (
          mode === "refuses" ||
          (statsPeriod !== null && !["", "14d", "24h"].includes(statsPeriod))
        ) {
          // Sentry's VERBATIM refusal — the response that was arriving twice a night, once per
          // project, while the summary line said ok:true.
          return Response.json(
            { detail: "Invalid stats_period. Valid choices are '', '24h', and '14d'" },
            { status: 400 },
          );
        }
        return Response.json(
          [{ id: "4507111", metadata: { type: "TypeError" }, shortId: "F-1A" }],
          {
            headers: { link: '<x>; rel="next"; results="false"; cursor="0:0:0"' },
          },
        );
      },
      port: 0,
    });

    try {
      const proc = Bun.spawn(
        [process.execPath, SWEEP_TS, "fetch", join(root, "no-ledger.md"), join(root, "out.json")],
        {
          env: {
            HOME: root,
            // ONLY the stub dir: a real `gh` can never be resolved from here.
            PATH: writeGhStub(root),
            SENTRY_TRIAGE_API_BASE: `http://127.0.0.1:${server.port}`,
            SENTRY_TRIAGE_PROJECTS: "fluncle-web,fluncle-worker",
            SENTRY_TRIAGE_TOKEN: "fixture-token",
          },
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      return { requests, summary: lastJsonLine(stdout) };
    } finally {
      await server.stop(true);
    }
  }

  test("a refused fetch reports ok:false and counts every failed project", async () => {
    const { summary } = await runFetch("refuses");
    // This is the exact line production printed three nights running — except for `ok`, which was
    // the literal `true` sitting beside `errors: 2`.
    expect(summary).toEqual({ errors: 2, ok: false, totalUnresolved: 0, triaged: 0 });
  });

  test("a clean fetch still reports ok:true — the derivation is not just 'always false'", async () => {
    const { summary } = await runFetch("answers");
    expect(summary).toEqual({ errors: 0, ok: true, totalUnresolved: 2, triaged: 2 });
  });

  test("the request that goes over the wire carries no stats period", async () => {
    const { requests } = await runFetch("answers");
    const issueQueries = requests.filter((r) => r.includes("/issues/?"));
    expect(issueQueries.length).toBe(2); // one per project
    for (const q of issueQueries) {
      expect(q).toContain("query=is%3Aunresolved");
      expect(q).toContain("limit=100");
      expect(q).not.toContain("statsPeriod");
      expect(q).not.toContain("stats_period");
    }
  });
});

describe("the driver's /status line (the real sentry-triage-sweep.sh) — it folds the verdict", () => {
  /**
   * Stand up a self-contained box: a copy of the REAL driver + the REAL cron-output wrapper, a
   * FIXTURE helper standing in for the Sentry-facing `.ts` (so this suite tests the fold, not the
   * API), and a local bare repo as `origin` so the driver's git steps work offline.
   *
   * The fixture helper's failure mode is the load-bearing detail: it exits ZERO and merely says
   * `ok:false` in its summary — exactly what the real helper does when a project's fetch throws.
   * The old driver only ever checked the exit code (`|| log "fetch returned nonzero"`), so this is
   * the precise shape it could not see.
   */
  function setUpBox(): { cronDir: string; root: string; script: string; ws: string } {
    const root = mkdtempSync(join(tmpdir(), "fluncle-sentry-driver-"));
    const scriptDir = join(root, "scripts");
    const ws = join(root, "ws");
    const origin = join(root, "origin.git");
    const cronDir = join(root, "cron-output");
    mkdirSync(scriptDir, { recursive: true });

    copyFileSync(SWEEP_SH, join(scriptDir, "sentry-triage-sweep.sh"));
    copyFileSync(CRON_OUTPUT_SH, join(scriptDir, "cron-output.sh"));
    writeFileSync(join(scriptDir, "sentry-triage-prompt.md"), "# fixture prompt\n", "utf8");

    // The fixture helper: `reconcile` is a clean no-op; `fetch` writes an EMPTY worklist and then
    // behaves per FIXTURE_FETCH_MODE — `clean` says ok:true, `fails` says ok:false, `silent` says
    // nothing at all (the helper crashed before printing). ALL THREE EXIT ZERO, which is the whole
    // point: the old driver's only check was the exit code.
    writeFileSync(
      join(scriptDir, "sentry-triage-sweep.ts"),
      [
        "const [cmd, , outFile] = process.argv.slice(2);",
        'if (cmd === "reconcile") {',
        "  console.log(JSON.stringify({ candidates: 0, ok: true, resolved: 0 }));",
        '} else if (cmd === "fetch") {',
        '  const mode = process.env.FIXTURE_FETCH_MODE ?? "clean";',
        '  require("fs").writeFileSync(outFile ?? ".sentry/issues.json", JSON.stringify({ issues: [] }));',
        '  if (mode !== "silent") {',
        "    console.log(",
        "      JSON.stringify({",
        '        errors: mode === "fails" ? 2 : 0,',
        '        ok: mode !== "fails",',
        "        totalUnresolved: 0,",
        "        triaged: 0,",
        "      }),",
        "    );",
        "  }",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const git = (args: string[], cwd?: string) => {
      const r = spawnSync("git", args, { cwd, encoding: "utf8" });
      if (r.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
      }
    };
    git(["init", "--quiet", "--bare", "-b", "main", origin]);
    git(["clone", "--quiet", origin, ws]);
    mkdirSync(join(ws, "docs"), { recursive: true });
    writeFileSync(join(ws, "docs", "sentry-backlog.md"), "# ledger\n", "utf8");
    // No dependencies, so the driver's `bun install` is instant and stays offline.
    writeFileSync(
      join(ws, "package.json"),
      JSON.stringify({ name: "sentry-triage-fixture", private: true, version: "0.0.0" }),
      "utf8",
    );
    git(["add", "-A"], ws);
    git(
      [
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "user.name=fixture",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "--no-verify",
        "-m",
        "fixture",
      ],
      ws,
    );
    git(["push", "--quiet", "-u", "origin", "main"], ws);

    return { cronDir, root, script: join(scriptDir, "sentry-triage-sweep.sh"), ws };
  }

  /** Run the driver end to end and return its exit code, its summary line, and the marker file. */
  function runDriver(
    box: ReturnType<typeof setUpBox>,
    mode: "clean" | "fails" | "silent",
  ): { marker: string; status: number | null; summary: Record<string, unknown> } {
    const run = spawnSync("bash", [box.script], {
      encoding: "utf8",
      env: {
        BUN_BIN: process.execPath,
        FIXTURE_FETCH_MODE: mode,
        FLUNCLE_AUDIT_GITHUB_PAT: "fixture-pat",
        HEALTHCHECK_CRON_OUTPUT_DIR: box.cronDir,
        HOME: join(box.root, "home"),
        PATH: `${writeGhStub(box.root)}:${process.env.PATH ?? ""}`,
        // Point the secrets loader at a file that does not exist: the real box env is never read.
        SENTRY_TRIAGE_SECRETS_FILE: join(box.root, "absent-secrets.env"),
        SENTRY_TRIAGE_TOKEN: "fixture-token",
        SENTRY_TRIAGE_WORKSPACE: box.ws,
      },
    });

    const markerDir = join(box.cronDir, "fluncle-sentry-triage");
    const newest = readdirSync(markerDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .at(-1);
    if (!newest) {
      throw new Error(`no /status marker was written to ${markerDir}`);
    }
    return {
      marker: readFileSync(join(markerDir, newest), "utf8"),
      status: run.status,
      summary: lastJsonLine(run.stdout),
    };
  }

  test("a helper that reports ok:false while exiting 0 turns the driver's line red", () => {
    const box = setUpBox();
    const { marker, status, summary } = runDriver(box, "fails");

    expect(summary.ok).toBe(false);
    expect(summary.action).toBe("fetch-failed");
    // The helper's failure count rides along, so the line says HOW BAD, not just that it failed.
    expect(summary.fetchErrors).toBe(2);
    expect(status).toBe(1); // the systemd unit fails too, not just the board
    // The marker is what /status parses; the lie has to be absent from THAT file, not just stdout.
    expect(marker).toContain('"ok":false');
    expect(marker).not.toContain('"ok":true,"action":"clean"');
  });

  test("a helper that prints NOTHING is a failure too — silence is not consent", () => {
    const box = setUpBox();
    const { status, summary } = runDriver(box, "silent");

    expect(summary.ok).toBe(false);
    expect(summary.action).toBe("fetch-failed");
    expect(summary.fetchErrors).toBe(1);
    expect(status).toBe(1);
  });

  test("a genuinely empty night is still green — an empty worklist is not itself a failure", () => {
    const box = setUpBox();
    const { marker, status, summary } = runDriver(box, "clean");

    expect(summary.ok).toBe(true);
    expect(summary.action).toBe("clean");
    expect(summary.triaged).toBe(0);
    expect(summary.fetchErrors).toBeUndefined(); // the clean line stays exactly as it was
    expect(status).toBe(0);
    expect(marker).toContain('"ok":true');
  });
});
