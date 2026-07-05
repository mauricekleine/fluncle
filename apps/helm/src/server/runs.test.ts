import { describe, expect, test } from "bun:test";

import { type RunSummary } from "../contract";
import { createRunRegistry, type RunEvent } from "./runs";

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

    registry.standDown();

    const [a, b] = await Promise.all([
      waitForFinish(registry, "test", first.runId),
      waitForFinish(registry, "test", second.runId),
    ]);

    expect(a.status).toBe("failed");
    expect(b.status).toBe("failed");
  });
});
