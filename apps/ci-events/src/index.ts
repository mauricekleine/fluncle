type TerminalStatus = "canceled" | "failed" | "succeeded";

const TERMINAL_EVENTS = {
  "cf.workersBuilds.worker.build.canceled": {
    buildOutcome: "canceled",
    payloadStatus: "canceled",
    status: "canceled",
  },
  "cf.workersBuilds.worker.build.failed": {
    buildOutcome: "failure",
    payloadStatus: "failed",
    status: "failed",
  },
  "cf.workersBuilds.worker.build.succeeded": {
    buildOutcome: "success",
    payloadStatus: "success",
    status: "succeeded",
  },
} as const satisfies Record<
  string,
  { buildOutcome: string; payloadStatus: string; status: TerminalStatus }
>;

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

function terminalEvent(type: string) {
  return Object.hasOwn(TERMINAL_EVENTS, type)
    ? TERMINAL_EVENTS[type as keyof typeof TERMINAL_EVENTS]
    : null;
}

function terminalEventInput(input: unknown) {
  const type = stringField(record(input), "type");
  return type ? terminalEvent(type) : null;
}

export function normalizeBuildEvent(
  input: unknown,
  expected: { branch: string; repository: string; workerName: string },
): NormalizedBuildEvent | null {
  const event = record(input);
  const type = stringField(event, "type");
  const terminal = type ? terminalEvent(type) : null;
  if (!terminal) {
    return null;
  }

  const source = record(event?.source);
  const payload = record(event?.payload);
  const metadata = record(event?.metadata);
  const trigger = record(payload?.buildTriggerMetadata);
  const sourceType = stringField(source, "type");
  const workerName = stringField(source, "workerName");
  const branch = stringField(trigger, "branch");
  const sha = stringField(trigger, "commitHash");
  const triggerSource = stringField(trigger, "buildTriggerSource");
  const providerType = stringField(trigger, "providerType");
  const repoName = stringField(trigger, "repoName");
  const buildUuid = stringField(payload, "buildUuid");
  const payloadStatus = stringField(payload, "status");
  const buildOutcome = stringField(payload, "buildOutcome");
  const eventTimestamp = stringField(metadata, "eventTimestamp");
  const expectedRepoName = expected.repository.slice(expected.repository.lastIndexOf("/") + 1);

  if (
    sourceType !== "workersBuilds.worker" ||
    workerName !== expected.workerName ||
    branch !== expected.branch ||
    triggerSource !== "push_event" ||
    providerType !== "github" ||
    repoName !== expectedRepoName ||
    payloadStatus !== terminal.payloadStatus ||
    buildOutcome !== terminal.buildOutcome ||
    !sha ||
    !/^[0-9a-f]{40}$/.test(sha) ||
    !buildUuid ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(buildUuid) ||
    !eventTimestamp ||
    eventTimestamp.length > 64 ||
    Number.isNaN(Date.parse(eventTimestamp))
  ) {
    return null;
  }

  return { buildUuid, eventTimestamp, sha, status: terminal.status, workerName };
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
      signal: AbortSignal.timeout(15_000),
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
        repository: env.GITHUB_REPOSITORY,
        workerName: env.EXPECTED_WORKER,
      });

      if (!event) {
        const terminal = terminalEventInput(message.body);
        console.log(
          JSON.stringify({
            attempts: message.attempts,
            messageId: message.id,
            outcome: terminal ? "invalid-terminal-retry" : "ignored",
          }),
        );
        if (terminal) {
          message.retry();
        } else {
          message.ack();
        }
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
