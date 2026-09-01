type TerminalStatus = "canceled" | "failed" | "succeeded";

export type NormalizedBuildEvent = {
  buildUuid: string;
  eventTimestamp: string;
  sha: string;
  status: TerminalStatus;
  workerName: string;
};

type Fetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function stringField(value: Record<string, unknown> | null, key: string): string | null {
  const field = value?.[key];
  return typeof field === "string" ? field : null;
}

function terminalStatus(type: string): TerminalStatus | null {
  if (type.endsWith(".build.succeeded")) {
    return "succeeded";
  }
  if (type.endsWith(".build.failed")) {
    return "failed";
  }
  if (type.endsWith(".build.canceled")) {
    return "canceled";
  }
  return null;
}

export function normalizeBuildEvent(
  input: unknown,
  expected: { branch: string; workerName: string },
): NormalizedBuildEvent | null {
  const event = record(input);
  const type = stringField(event, "type");
  const status = type ? terminalStatus(type) : null;
  if (!status) {
    return null;
  }

  const source = record(event?.source);
  const payload = record(event?.payload);
  const metadata = record(event?.metadata);
  const trigger = record(payload?.buildTriggerMetadata);
  const workerName = stringField(source, "workerName");
  const branch = stringField(trigger, "branch");
  const sha = stringField(trigger, "commitHash");
  const buildUuid = stringField(payload, "buildUuid");
  const eventTimestamp = stringField(metadata, "eventTimestamp");

  if (
    workerName !== expected.workerName ||
    branch !== expected.branch ||
    !sha ||
    !/^[0-9a-f]{40}$/.test(sha) ||
    !buildUuid ||
    !eventTimestamp
  ) {
    return null;
  }

  return { buildUuid, eventTimestamp, sha, status, workerName };
}

function secret(env: Env, name: "GITHUB_DISPATCH_TOKEN"): string | null {
  const value = (env as Partial<Record<typeof name, unknown>>)[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function dispatchBuildEvent(
  event: NormalizedBuildEvent,
  env: Env,
  fetchImpl: Fetch = fetch,
): Promise<boolean> {
  const token = secret(env, "GITHUB_DISPATCH_TOKEN");
  if (!token) {
    console.error(JSON.stringify({ buildUuid: event.buildUuid, error: "dispatch token missing" }));
    return false;
  }

  const response = await fetchImpl(
    `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/dispatches`,
    {
      body: JSON.stringify({
        client_payload: {
          build_uuid: event.buildUuid,
          event_timestamp: event.eventTimestamp,
          sha: event.sha,
          status: event.status,
          worker_name: event.workerName,
        },
        event_type: "cloudflare-workers-build",
      }),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "fluncle-ci-events-relay",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      method: "POST",
    },
  );

  if (!response.ok) {
    console.error(
      JSON.stringify({
        buildUuid: event.buildUuid,
        error: "repository dispatch failed",
        status: response.status,
      }),
    );
    return false;
  }

  console.log(JSON.stringify({ buildUuid: event.buildUuid, sha: event.sha, status: event.status }));
  return true;
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const event = normalizeBuildEvent(message.body, {
        branch: env.EXPECTED_BRANCH,
        workerName: env.EXPECTED_WORKER,
      });

      if (!event) {
        console.log(JSON.stringify({ messageId: message.id, outcome: "ignored" }));
        message.ack();
        continue;
      }

      try {
        if (await dispatchBuildEvent(event, env)) {
          message.ack();
        } else {
          message.retry();
        }
      } catch (error) {
        console.error(
          JSON.stringify({
            buildUuid: event.buildUuid,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, unknown>;
