import { describe, expect, test } from "bun:test";
import { resolveDeployInput, validateDeployTarget } from "./resolve-deploy.mjs";
import {
  correlatesCommit,
  correlatesWithOriginMain,
  pollForDeployment,
} from "./wait-for-deploy.mjs";

const SHA = "a".repeat(40);
const DESCENDANT = "b".repeat(40);

describe("post-deploy event handling", () => {
  test("accepts success, failure, and cancellation terminal events", () => {
    for (const status of ["succeeded", "failed", "canceled"] as const) {
      expect(
        resolveDeployInput({
          event: { client_payload: { build_uuid: "build-1", sha: SHA, status } },
          eventName: "repository_dispatch",
        }),
      ).toEqual({ buildUuid: "build-1", enabled: true, mode: "event", sha: SHA, status });
    }
  });

  test("rejects malformed correlation and nonterminal events", () => {
    for (const clientPayload of [
      { build_uuid: "build-1", sha: "short", status: "succeeded" },
      { build_uuid: "build-1", sha: SHA, status: "running" },
      { build_uuid: "", sha: SHA, status: "failed" },
      { build_uuid: "build-1\ninjected=true", sha: SHA, status: "succeeded" },
    ]) {
      expect(() =>
        resolveDeployInput({
          event: { client_payload: clientPayload },
          eventName: "repository_dispatch",
        }),
      ).toThrow();
    }
  });

  test("validates an event target against pushed main before its code can run", () => {
    const calls: string[] = [];
    const acceptedGit = (...args: string[]) => {
      calls.push(args.join(" "));
      return { output: "", status: 0 };
    };

    expect(() => validateDeployTarget(SHA, acceptedGit)).not.toThrow();
    expect(calls).toEqual([
      "fetch --quiet origin main",
      `cat-file -e ${SHA}^{commit}`,
      `merge-base --is-ancestor ${SHA} origin/main`,
    ]);

    expect(() =>
      validateDeployTarget(SHA, (...args: string[]) => ({
        output: "",
        status: args[0] === "merge-base" ? 1 : 0,
      })),
    ).toThrow("not on pushed origin/main");
  });

  test("accepts an exact or coalesced descendant deployment only", () => {
    expect(correlatesCommit(SHA, SHA, () => false)).toBe(true);
    expect(correlatesCommit(SHA, DESCENDANT, () => true)).toBe(true);
    expect(correlatesCommit(SHA, DESCENDANT, () => false)).toBe(false);
    expect(correlatesCommit(SHA, "not-a-sha", () => true)).toBe(false);
  });

  test("refreshes origin before accepting a coalesced commit first seen after startup", () => {
    const target = "a".repeat(40);
    const served = "b".repeat(40);
    let fetched = false;
    const calls: string[] = [];
    const git = (...args: string[]) => {
      calls.push(args.join(" "));
      if (args[0] === "fetch") {
        fetched = true;
        return { output: "", status: 0 };
      }
      if (args[0] === "cat-file") {
        return { output: "", status: fetched ? 0 : 1 };
      }
      return { output: "", status: fetched ? 0 : 1 };
    };

    expect(correlatesWithOriginMain(target, served, git)).toBe(true);
    expect(calls).toEqual([
      `cat-file -e ${served}^{commit}`,
      "fetch --quiet origin main",
      `cat-file -e ${served}^{commit}`,
      `merge-base --is-ancestor ${target} ${served}`,
    ]);
  });

  test("bounded polling tolerates stale deploys and then correlates", async () => {
    let clock = 0;
    const served = ["c".repeat(40), DESCENDANT];
    const result = await pollForDeployment({
      deadlineSeconds: 60,
      fetchImpl: async () => Response.json({ sha: served.shift() }),
      intervalSeconds: 15,
      isAncestor: (target, candidate) => target === SHA && candidate === DESCENDANT,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      target: SHA,
    });

    expect(result).toEqual({ served: DESCENDANT, waitSeconds: 15 });
  });

  test("bounded polling fails after the deadline", async () => {
    let clock = 0;
    try {
      await pollForDeployment({
        deadlineSeconds: 30,
        fetchImpl: async () => Response.json({ sha: "c".repeat(40) }),
        intervalSeconds: 15,
        isAncestor: () => false,
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
        target: SHA,
      });
      throw new Error("poll unexpectedly succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("deployment did not correlate");
    }
  });
});
