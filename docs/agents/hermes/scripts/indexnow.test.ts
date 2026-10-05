import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndexNowTick } from "./indexnow";

let fetchGuard: ReturnType<typeof spyOn>;
beforeEach(() => {
  fetchGuard = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network call"));
});
const temporaryDirectories: string[] = [];
afterEach(() => {
  fetchGuard.mockRestore();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});
function stateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "fluncle-indexnow-"));
  temporaryDirectories.push(directory);
  return directory;
}
function runTick(deps: Omit<Parameters<typeof runIndexNowTick>[0], "stateDirectory">) {
  return runIndexNowTick({ ...deps, stateDirectory: stateDirectory() });
}

const completeWalk = {
  changed: 2,
  checked: 250,
  inserted: 3,
  kind: "log" as const,
  next: null,
  ok: true as const,
  phase: "walk" as const,
  removed: 4,
};
const accepted = { due: 17, ok: true, phase: "submit" as const, status: 202, submitted: 5 };

describe("the daily IndexNow sweep", () => {
  test("accumulates window counters and accepted URLs independently and logs the complete audit", async () => {
    const lines: string[] = [];
    const phases: string[] = [];
    let windows = 0;
    const summary = await runTick({
      log: (line) => lines.push(line),
      request: (body) => {
        phases.push(body.phase);
        if (body.phase === "submit") {
          return Promise.resolve(accepted);
        }
        windows += 1;
        return Promise.resolve(
          windows === 1
            ? { ...completeWalk, next: { after: "log-b", kind: "log" } }
            : { ...completeWalk, changed: 1, checked: 40, inserted: 1, removed: 7 },
        );
      },
    });
    expect(phases).toEqual(["walk", "walk", "submit"]);
    expect(summary).toMatchObject({
      changed: 3,
      checked: 290,
      errors: 0,
      inserted: 4,
      ok: true,
      produced: 5,
      queueDepth: 17,
      removed: 11,
      status: 202,
      submitted: 5,
    });
    expect(lines).toEqual([
      "AUDIT checked=290 inserted=4 changed=3 removed=11 submitted=5 due=17 status=202 errors=0",
    ]);
  });

  test.each([403, 422, 429])(
    "an IndexNow %s rejection fails the run while retaining its due queue",
    async (status) => {
      const summary = await runTick({
        log: () => {},
        request: (body) =>
          Promise.resolve(
            body.phase === "walk"
              ? completeWalk
              : {
                  due: 22,
                  error: `IndexNow HTTP ${status}`,
                  ok: false,
                  phase: "submit",
                  status,
                  submitted: 0,
                },
          ),
      });
      expect(summary).toMatchObject({
        errors: 1,
        ok: false,
        produced: 0,
        queueDepth: 22,
        status,
        submitted: 0,
      });
      expect(summary.error).toContain(String(status));
    },
  );

  test("an accepted batch whose ledger stamp fails keeps its accepted URL count and fails the run", async () => {
    const summary = await runTick({
      log: () => {},
      request: (body) =>
        Promise.resolve(
          body.phase === "walk"
            ? completeWalk
            : {
                due: null,
                error: "Could not stamp accepted page versions",
                ok: false,
                phase: "submit",
                status: 202,
                submitted: 5,
              },
        ),
    });
    expect(summary).toMatchObject({
      errors: 1,
      ok: false,
      produced: 5,
      queueDepth: null,
      status: 202,
      submitted: 5,
    });
  });

  test("a transport failure fails the run without inventing an HTTP status or queue count", async () => {
    const summary = await runTick({
      log: () => {},
      request: (body) =>
        body.phase === "walk"
          ? Promise.resolve(completeWalk)
          : Promise.reject(new Error("request timed out")),
    });
    expect(summary).toMatchObject({
      error: "request timed out",
      errors: 1,
      ok: false,
      produced: 0,
      queueDepth: null,
      status: null,
    });
  });

  test("a budget stop still submits the observed work and stays a successful partial run", async () => {
    let clock = 0;
    const phases: string[] = [];
    const summary = await runTick({
      log: () => {},
      now: () => clock,
      request: (body) => {
        phases.push(body.phase);
        clock = 600_000;
        return Promise.resolve(
          body.phase === "walk"
            ? { ...completeWalk, next: { after: "log-b", kind: "log" } }
            : accepted,
        );
      },
    });
    expect(phases).toEqual(["walk", "submit"]);
    expect(summary).toMatchObject({
      checked: 250,
      errors: 0,
      ok: true,
      partial: true,
      produced: 5,
      reason: "wall_budget",
      windows: 1,
    });
  });

  test("no admitted window fails the run even if existing due URLs can be submitted", async () => {
    const summary = await runTick({
      log: () => {},
      request: (body) => Promise.resolve(body.phase === "walk" ? undefined : accepted),
    });
    expect(summary).toMatchObject({
      checked: 0,
      errors: 1,
      ok: false,
      partial: true,
      produced: 5,
      reason: "database_admission",
      removed: 0,
      windows: 0,
    });
  });

  test("a yield after completed windows keeps their counters and still submits", async () => {
    let windows = 0;
    const summary = await runTick({
      log: () => {},
      request: (body) => {
        if (body.phase === "submit") {
          return Promise.resolve(accepted);
        }
        windows += 1;
        return Promise.resolve(
          windows === 1 ? { ...completeWalk, next: { after: "log-b", kind: "log" } } : undefined,
        );
      },
    });
    expect(summary).toMatchObject({
      checked: 250,
      errors: 0,
      ok: true,
      partial: true,
      produced: 5,
      reason: "database_admission",
      windows: 1,
    });
  });

  test("a submission admission yield fails a completed walk without marking the walk partial", async () => {
    const summary = await runTick({
      log: () => {},
      request: (body) => Promise.resolve(body.phase === "walk" ? completeWalk : undefined),
    });
    expect(summary).toMatchObject({
      checked: 250,
      errors: 1,
      ok: false,
      partial: false,
      produced: 0,
      queueDepth: null,
      reason: "database_admission",
      status: null,
      windows: 1,
    });
  });

  test("a stalled cursor fails instead of exhausting the window budget", async () => {
    let calls = 0;
    const summary = await runTick({
      log: () => {},
      request: (body) => {
        calls += 1;
        return Promise.resolve(
          body.phase === "walk"
            ? { ...completeWalk, next: { after: "log-b", kind: "log" } }
            : accepted,
        );
      },
    });
    expect(calls).toBe(3);
    expect(summary).toMatchObject({ errors: 1, ok: false, reason: "walk_failed", windows: 1 });
    expect(summary.error).toContain("did not advance");
  });

  test("the window cap bounds an unfinished catalogue walk and still submits once", async () => {
    let windows = 0;
    let submissions = 0;
    const summary = await runTick({
      log: () => {},
      request: (body) => {
        if (body.phase === "submit") {
          submissions += 1;
          return Promise.resolve(accepted);
        }
        windows += 1;
        return Promise.resolve({
          ...completeWalk,
          next: { after: `log-${String(windows).padStart(4, "0")}`, kind: "log" },
        });
      },
    });
    expect(windows).toBe(2000);
    expect(submissions).toBe(1);
    expect(summary).toMatchObject({
      checked: 500_000,
      errors: 0,
      ok: true,
      partial: true,
      reason: "window_budget",
      windows: 2000,
    });
  });

  test("a partial pass checkpoints its next window and resumes catalogue work after the daily logs", async () => {
    const directory = stateDirectory();
    let clock = 0;
    await runIndexNowTick({
      log: () => {},
      now: () => clock,
      request: (body) => {
        clock = 600_000;
        return Promise.resolve(
          body.phase === "walk"
            ? { ...completeWalk, kind: "artist", next: { after: "artist-b", kind: "artist" } }
            : accepted,
        );
      },
      stateDirectory: directory,
    });
    expect(JSON.parse(readFileSync(join(directory, "cursor.json"), "utf8"))).toEqual({
      after: "artist-b",
      kind: "artist",
    });
    const cursors: unknown[] = [];
    await runIndexNowTick({
      log: () => {},
      request: (body) => {
        if (body.phase === "submit") {
          return Promise.resolve(accepted);
        }
        cursors.push(body.cursor ?? null);
        return Promise.resolve(
          cursors.length === 1
            ? { ...completeWalk, next: { kind: "artist" } }
            : { ...completeWalk, kind: "track", next: null },
        );
      },
      stateDirectory: directory,
    });
    expect(cursors).toEqual([null, { after: "artist-b", kind: "artist" }]);
    expect(existsSync(join(directory, "cursor.json"))).toBe(false);
  });

  test("a log admission yield preserves a pending catalogue checkpoint", async () => {
    const directory = stateDirectory();
    writeFileSync(
      join(directory, "cursor.json"),
      JSON.stringify({ after: "track-a", kind: "track" }),
    );
    const summary = await runIndexNowTick({
      log: () => {},
      request: (body) => Promise.resolve(body.phase === "walk" ? undefined : accepted),
      stateDirectory: directory,
    });
    expect(summary.ok).toBe(false);
    expect(JSON.parse(readFileSync(join(directory, "cursor.json"), "utf8"))).toEqual({
      after: "track-a",
      kind: "track",
    });
  });

  test("a dry submission reports the worklist size without claiming accepted URLs", async () => {
    let requestedDryRun: boolean | undefined;
    const summary = await runTick({
      dryRun: true,
      log: () => {},
      request: (body) => {
        if (body.phase === "walk") {
          return Promise.resolve(completeWalk);
        }
        requestedDryRun = body.dryRun;
        return Promise.resolve({ ...accepted, dryRun: true, due: 22, status: null });
      },
    });
    expect(requestedDryRun).toBe(true);
    expect(summary).toMatchObject({
      errors: 0,
      ok: true,
      produced: 0,
      queueDepth: 22,
      status: null,
      submitted: 5,
    });
  });
});
