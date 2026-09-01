import { describe, expect, test } from "bun:test";
import relay, { dispatchBuildEvent, normalizeBuildEvent, type NormalizedBuildEvent } from "./index";

const SHA = "a".repeat(40);

function cloudflareEvent(status: "canceled" | "failed" | "succeeded" = "succeeded") {
  return {
    metadata: { eventTimestamp: "2026-09-01T10:00:00.000Z" },
    payload: {
      buildTriggerMetadata: { branch: "main", commitHash: SHA },
      buildUuid: "build-123",
    },
    source: { workerName: "fluncle-web" },
    type: `cf.workersBuilds.worker.build.${status}`,
  };
}

const env = {
  EXPECTED_BRANCH: "main",
  EXPECTED_WORKER: "fluncle-web",
  GITHUB_DISPATCH_TOKEN: "test-token",
  GITHUB_REPOSITORY: "mauricekleine/fluncle",
} as Env;

describe("Cloudflare Workers Builds event relay", () => {
  test("normalizes every terminal event with exact commit correlation", () => {
    for (const status of ["succeeded", "failed", "canceled"] as const) {
      expect(
        normalizeBuildEvent(cloudflareEvent(status), {
          branch: "main",
          workerName: "fluncle-web",
        }),
      ).toEqual({
        buildUuid: "build-123",
        eventTimestamp: "2026-09-01T10:00:00.000Z",
        sha: SHA,
        status,
        workerName: "fluncle-web",
      });
    }
  });

  test("rejects the wrong branch, worker, incomplete SHA, and started events", () => {
    const expected = { branch: "main", workerName: "fluncle-web" };
    expect(
      normalizeBuildEvent(
        { ...cloudflareEvent(), type: "cf.workersBuilds.worker.build.started" },
        expected,
      ),
    ).toBeNull();
    expect(
      normalizeBuildEvent({ ...cloudflareEvent(), source: { workerName: "other" } }, expected),
    ).toBeNull();
    expect(
      normalizeBuildEvent(
        {
          ...cloudflareEvent(),
          payload: {
            ...cloudflareEvent().payload,
            buildTriggerMetadata: { branch: "preview", commitHash: SHA },
          },
        },
        expected,
      ),
    ).toBeNull();
    expect(
      normalizeBuildEvent(
        {
          ...cloudflareEvent(),
          payload: {
            ...cloudflareEvent().payload,
            buildTriggerMetadata: { branch: "main", commitHash: "abc123" },
          },
        },
        expected,
      ),
    ).toBeNull();
  });

  test("dispatches the normalized terminal payload and exposes retryable failure", async () => {
    const event: NormalizedBuildEvent = {
      buildUuid: "build-123",
      eventTimestamp: "2026-09-01T10:00:00.000Z",
      sha: SHA,
      status: "succeeded",
      workerName: "fluncle-web",
    };
    const requests: Request[] = [];
    const succeeded = await dispatchBuildEvent(event, env, async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(null, { status: 204 });
    });

    expect(succeeded).toBe(true);
    const request = requests[0];
    if (!request) {
      throw new Error("dispatch request was not captured");
    }
    expect(request.headers.get("authorization")).toBe("Bearer test-token");
    const body = (await request.json()) as Record<string, unknown>;
    expect(body).toEqual({
      client_payload: {
        build_uuid: "build-123",
        event_timestamp: "2026-09-01T10:00:00.000Z",
        sha: SHA,
        status: "succeeded",
        worker_name: "fluncle-web",
      },
      event_type: "cloudflare-workers-build",
    });

    expect(
      await dispatchBuildEvent(event, env, async () => new Response(null, { status: 503 })),
    ).toBe(false);
  });

  test("acknowledges irrelevant events and retries a terminal event until dispatch succeeds", async () => {
    const outcomes: string[] = [];
    const message = (id: string, body: unknown) =>
      ({
        ack: () => outcomes.push(`${id}:ack`),
        attempts: 1,
        body,
        id,
        retry: () => outcomes.push(`${id}:retry`),
        timestamp: new Date("2026-09-01T10:00:00.000Z"),
      }) as Message<unknown>;
    const missingToken = {
      EXPECTED_BRANCH: "main",
      EXPECTED_WORKER: "fluncle-web",
      GITHUB_REPOSITORY: "mauricekleine/fluncle",
    } as Env;

    await relay.queue(
      {
        ackAll: () => undefined,
        messages: [
          message("irrelevant", {
            ...cloudflareEvent(),
            type: "cf.workersBuilds.worker.build.started",
          }),
          message("terminal", cloudflareEvent()),
        ],
        metadata: { metrics: { backlogBytes: 0, backlogCount: 2 } },
        queue: "fluncle-workers-build-events",
        retryAll: () => undefined,
      },
      missingToken,
    );

    expect(outcomes).toEqual(["irrelevant:ack", "terminal:retry"]);
  });
});
