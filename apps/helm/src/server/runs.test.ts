import { describe, expect, test } from "bun:test";

import { type RunSummary } from "../contract";
import { createRunRegistry, type RunEvent, wrapInProcessGroup } from "./runs";

/** Wait until the run leaves `running` (its final status event), with a floor. */
function waitForFinish(
  registry: ReturnType<typeof createRunRegistry>,
  feature: string,
  runId: string,
  timeoutMs = 5000,
): Promise<RunSummary> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      unsubscribe();
      rejectPromise(new Error("run never finished"));
    }, timeoutMs);

    const unsubscribe = registry.subscribe(feature, runId, (event: RunEvent) => {
      if (event.kind === "status" && event.run.status !== "running") {
        clearTimeout(timer);
        unsubscribe();
        resolvePromise(event.run);
      }
    });

    // The run may already be done (subscribe attached after the exit).
    const run = registry.get(feature, runId);

    if (run && run.status !== "running") {
      clearTimeout(timer);
      unsubscribe();
      resolvePromise({
        argv: run.argv,
        endedAt: run.endedAt,
        exitCode: run.exitCode,
        feature: run.feature,
        id: run.id,
        startedAt: run.startedAt,
        status: run.status,
        title: run.title,
      });
    }
  });
}

describe("the run registry state machine", () => {
  test("an echo round-trips: running → ok, lines buffered, exit 0", async () => {
    const registry = createRunRegistry();
    const { runId } = registry.runStreamed(["/bin/sh", "-c", "echo one; echo two"], {
      feature: "test",
      title: "echo",
    });

    expect(registry.get("test", runId)?.status).toBe("running");

    const finished = await waitForFinish(registry, "test", runId);

    expect(finished.status).toBe("ok");
    expect(finished.exitCode).toBe(0);

    const run = registry.get("test", runId);
    const texts = run?.lines.map((line) => line.text) ?? [];

    expect(texts).toContain("one");
    expect(texts).toContain("two");
    expect(texts.at(-1)).toBe("done (exit 0)");
  });

  test("a non-zero exit reads failed with its code", async () => {
    const registry = createRunRegistry();
    const { runId } = registry.runStreamed(["/bin/sh", "-c", "echo oops >&2; exit 3"], {
      feature: "test",
      title: "boom",
    });

    const finished = await waitForFinish(registry, "test", runId);

    expect(finished.status).toBe("failed");
    expect(finished.exitCode).toBe(3);

    const run = registry.get("test", runId);
    const stderrLine = run?.lines.find((line) => line.stream === "stderr");

    expect(stderrLine?.text).toBe("oops");
  });

  test("kill sends SIGINT and the run lands failed with the stand-down narration", async () => {
    const registry = createRunRegistry();
    const { runId } = registry.runStreamed(["/bin/sh", "-c", "sleep 30"], {
      feature: "test",
      title: "long haul",
    });

    expect(registry.kill("test", runId)).toBe(true);

    const finished = await waitForFinish(registry, "test", runId);

    expect(finished.status).toBe("failed");

    const texts = registry.get("test", runId)?.lines.map((line) => line.text) ?? [];

    expect(texts).toContain("standing down (SIGINT)");
    expect(texts.some((text) => text.startsWith("stood down"))).toBe(true);
  });

  test("runs are feature-scoped: another feature can't read or kill them", async () => {
    const registry = createRunRegistry();
    const { runId } = registry.runStreamed(["/bin/sh", "-c", "sleep 30"], {
      feature: "mine",
      title: "scoped",
    });

    expect(registry.get("theirs", runId)).toBeUndefined();
    expect(registry.kill("theirs", runId)).toBe(false);
    expect(registry.get("mine", runId)?.status).toBe("running");

    registry.kill("mine", runId);
    await waitForFinish(registry, "mine", runId);
  });

  test("live subscribers hear lines as they land, in seq order", async () => {
    const registry = createRunRegistry();
    const heard: number[] = [];
    const { runId } = registry.runStreamed(["/bin/sh", "-c", "echo a; echo b; echo c"], {
      feature: "test",
      title: "live",
    });

    registry.subscribe("test", runId, (event) => {
      if (event.kind === "line") {
        heard.push(event.line.seq);
      }
    });

    await waitForFinish(registry, "test", runId);

    expect(heard.length).toBeGreaterThan(0);
    expect([...heard].sort((a, b) => a - b)).toEqual(heard);
  });

  test("list reads newest first and standDown SIGINTs the running ones", async () => {
    const registry = createRunRegistry();
    const first = registry.runStreamed(["/bin/sh", "-c", "sleep 30"], {
      feature: "test",
      title: "first",
    });
    await Bun.sleep(10);
    const second = registry.runStreamed(["/bin/sh", "-c", "sleep 30"], {
      feature: "test",
      title: "second",
    });

    expect(registry.list().map((run) => run.id)).toEqual([second.runId, first.runId]);

    void registry.standDown();

    const [a, b] = await Promise.all([
      waitForFinish(registry, "test", first.runId),
      waitForFinish(registry, "test", second.runId),
    ]);

    expect(a.status).toBe("failed");
    expect(b.status).toBe("failed");
  });
});

describe("the least-privilege child env (H3)", () => {
  test("a child never sees the daemon's own env — only the minimal base + opts.env", async () => {
    process.env.FLUNCLE_API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "canary-token";
    const registry = createRunRegistry();
    const { runId } = registry.runStreamed(["/usr/bin/printenv"], {
      env: { HELM_TEST_EXTRA: "aboard" },
      feature: "test",
      title: "env audit",
    });

    await waitForFinish(registry, "test", runId);

    const texts = registry.get("test", runId)?.lines.map((line) => line.text) ?? [];

    expect(texts.some((text) => text.startsWith("FLUNCLE_API_TOKEN="))).toBe(false);
    expect(texts).toContain("HELM_TEST_EXTRA=aboard");
    expect(texts.some((text) => text.startsWith("PATH="))).toBe(true);

    if (process.env.FLUNCLE_API_TOKEN === "canary-token") {
      delete process.env.FLUNCLE_API_TOKEN;
    }
  });

  test("adminToken: true presents the injected credentials, deliberately", async () => {
    const registry = createRunRegistry({ adminEnv: () => ({ FLUNCLE_API_TOKEN: "the-key" }) });

    const tokenless = registry.runStreamed(["/usr/bin/printenv"], {
      feature: "test",
      title: "tokenless",
    });
    const tokened = registry.runStreamed(["/usr/bin/printenv"], {
      adminToken: true,
      feature: "test",
      title: "tokened",
    });

    await Promise.all([
      waitForFinish(registry, "test", tokenless.runId),
      waitForFinish(registry, "test", tokened.runId),
    ]);

    const linesOf = (runId: string): string[] =>
      registry.get("test", runId)?.lines.map((line) => line.text) ?? [];

    expect(linesOf(tokenless.runId)).not.toContain("FLUNCLE_API_TOKEN=the-key");
    expect(linesOf(tokened.runId)).toContain("FLUNCLE_API_TOKEN=the-key");
  });
});

describe("the process group + the drain bound (M6)", () => {
  test("wrapInProcessGroup wraps only when the wrapper exists", () => {
    const argv = ["/bin/echo", "hi"];

    expect(wrapInProcessGroup(argv, false)).toEqual(argv);

    const wrapped = wrapInProcessGroup(argv, true);

    expect(wrapped[0]).toBe("/usr/bin/perl");
    expect(wrapped.slice(-2)).toEqual(argv);
  });

  test("a run leads its own process group (kills can target the group)", async () => {
    const registry = createRunRegistry();
    const { runId } = registry.runStreamed(
      [
        "/bin/sh",
        "-c",
        'ps -o pid=,pgid= -p "$$" | awk \'{print ($1==$2) ? "leader" : "follower"}\'',
      ],
      { feature: "test", title: "pgid audit" },
    );

    await waitForFinish(registry, "test", runId);

    const texts = registry.get("test", runId)?.lines.map((line) => line.text) ?? [];

    expect(texts).toContain("leader");
  });

  test("a grandchild holding the pipe can't wedge the run — the drain is bounded", async () => {
    const registry = createRunRegistry({ timings: { drainGraceMs: 250 } });
    // The sh exits immediately; the backgrounded sleep inherits (and holds) stdout.
    const { runId } = registry.runStreamed(["/bin/sh", "-c", "sleep 2 & echo parent-done"], {
      feature: "test",
      title: "abandoned pipe",
    });

    const startedAt = Date.now();
    const finished = await waitForFinish(registry, "test", runId);

    expect(finished.status).toBe("ok");
    expect(Date.now() - startedAt).toBeLessThan(1800);

    const texts = registry.get("test", runId)?.lines.map((line) => line.text) ?? [];

    expect(texts).toContain("parent-done");
    expect(texts).toContain("(output pipe abandoned — grandchildren may hold it)");
  });
});

describe("the escalating stand-down (M7)", () => {
  test("a SIGINT-deaf child gets the SIGKILL escalation, and standDown awaits it", async () => {
    const registry = createRunRegistry({
      timings: { standDownSigintGraceMs: 250, standDownSigkillGraceMs: 2000 },
    });
    const { runId } = registry.runStreamed(["/bin/sh", "-c", 'trap "" INT; sleep 30'], {
      feature: "test",
      title: "deaf to SIGINT",
    });
    // Let the shell install its trap before the stand-down begins.
    await Bun.sleep(150);

    await registry.standDown();

    const run = registry.get("test", runId);

    expect(run?.status).toBe("failed");

    const texts = run?.lines.map((line) => line.text) ?? [];

    expect(texts).toContain("daemon standing down (SIGINT)");
    expect(texts).toContain("still up after the grace — SIGKILL to the group");
  });

  test("a polite child never sees the SIGKILL leg", async () => {
    const registry = createRunRegistry({
      timings: { standDownSigintGraceMs: 3000, standDownSigkillGraceMs: 2000 },
    });
    const { runId } = registry.runStreamed(["/bin/sh", "-c", "sleep 30"], {
      feature: "test",
      title: "polite",
    });
    await Bun.sleep(100);

    await registry.standDown();

    const texts = registry.get("test", runId)?.lines.map((line) => line.text) ?? [];

    expect(texts).toContain("daemon standing down (SIGINT)");
    expect(texts).not.toContain("still up after the grace — SIGKILL to the group");
  });
});
