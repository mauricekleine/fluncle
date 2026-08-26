import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..", "..");
const WATCHDOG = join(REPO, "apps/ssh/watchdog/fluncle-rave-watchdog.sh");
const CALLERS = [
  {
    functionName: "post_health",
    name: "sonar freshen",
    path: join(REPO, "apps/sonar/deploy/fluncle-sonar-freshen.sh"),
    setup: "FLUNCLE_API_TOKEN=test-token\nWORKER_URL=https://worker.invalid",
  },
  {
    functionName: "post_health",
    name: "SSH freshen",
    path: join(REPO, "apps/ssh/deploy/fluncle-ssh-freshen.sh"),
    setup: "FLUNCLE_API_TOKEN=test-token\nWORKER_URL=https://worker.invalid",
  },
  {
    functionName: "post_health",
    name: "Hermes pin watch",
    path: join(REPO, "docs/agents/hermes/pin-watch/rebuild-hermes.sh"),
    setup: "APITOKEN=test-token\nWORKER_URL=https://worker.invalid",
  },
] as const;

const CURL_STUB = `#!/usr/bin/env bash
set -euo pipefail
url="\${!#}"
body=""
expects_body=0
for argument in "$@"; do
  if [ "$expects_body" = 1 ]; then
    body="$argument"
    expects_body=0
  elif [ "$argument" = "-d" ]; then
    expects_body=1
  fi
done
printf '%s\t%s\n' "$url" "$body" >>"$HEALTH_CALLS"
case "$url" in
  https://onion.invalid/*)
    printf '200 0.125'
    ;;
  */api/v1/admin/health)
    count="$(awk -F '\t' '$1 ~ /\\/api\\/v1\\/admin\\/health$/ { count += 1 } END { print count + 0 }' "$HEALTH_CALLS")"
    if [ "$HEALTH_SCENARIO" = "transport" ] && [ "$count" = 1 ]; then
      printf '000'
      exit 28
    fi
    if [ "$HEALTH_SCENARIO" = "retry" ] && [ "$count" -gt 1 ]; then
      printf '204'
    else
      printf '524'
    fi
    ;;
  */api/v1/admin/operation-receipts/resolve)
    if [ "$HEALTH_SCENARIO" = "retry" ]; then
      printf '{"ok":true,"receipt":{"outcome":"safely-retryable"}}\n200'
    else
      printf '{"ok":true,"receipt":{"outcome":"committed"}}\n200'
    fi
    ;;
  *)
    exit 70
    ;;
esac
`;

type CurlCall = {
  body: string | null;
  url: string;
};

type HealthPayload = {
  at: string;
  checks: Array<{
    latencyMs: number | null;
    message: string | null;
    service: string;
    status: string;
    transitioned: boolean;
  }>;
  operationKey: string;
  producer: string;
  requestDigest: string;
};

function readCalls(path: string): CurlCall[] {
  const contents = readFileSync(path, "utf8").trim();
  if (contents.length === 0) {
    return [];
  }

  return contents.split("\n").map((line) => {
    const separator = line.indexOf("\t");
    if (separator < 0) {
      throw new Error(`curl call did not record a body field: ${line}`);
    }
    const body = line.slice(separator + 1);
    return { body: body.length > 0 ? body : null, url: line.slice(0, separator) };
  });
}

function parseBody<T>(call: CurlCall): T {
  if (call.body === null) {
    throw new Error(`missing JSON body for ${call.url}`);
  }
  return JSON.parse(call.body) as T;
}

function urls(calls: CurlCall[]): string[] {
  return calls.map((call) => call.url);
}

function expectReceiptCoordinates(calls: CurlCall[]): void {
  const healthCalls = calls.filter((call) => call.url.endsWith("/api/v1/admin/health"));
  const resolveCalls = calls.filter((call) =>
    call.url.endsWith("/api/v1/admin/operation-receipts/resolve"),
  );
  expect(healthCalls.length).toBeGreaterThan(0);
  expect(resolveCalls.length).toBe(1);

  const payload = parseBody<HealthPayload>(healthCalls[0]);
  expect(payload.operationKey).toBe(`health.snapshot:${payload.producer}:${payload.at}`);
  const canonicalCore = JSON.stringify({
    at: payload.at,
    checks: payload.checks.map((check) => ({
      latencyMs: check.latencyMs,
      message: check.message,
      service: check.service,
      status: check.status,
      transitioned: check.transitioned,
    })),
    producer: payload.producer,
  });
  const digest = new Bun.CryptoHasher("sha256").update(canonicalCore).digest("hex");
  expect(payload.requestDigest).toBe(digest);

  for (const healthCall of healthCalls) {
    expect(parseBody<HealthPayload>(healthCall)).toEqual(payload);
  }
  expect(parseBody(resolveCalls[0])).toEqual({
    operationId: "health.snapshot",
    operationKey: payload.operationKey,
    requestDigest: payload.requestDigest,
  });
}

function extractFunction(source: string, functionName: string): string {
  const start = source.indexOf(`${functionName}() {`);
  if (start < 0) {
    throw new Error(`missing ${functionName}`);
  }

  let depth = 0;
  let opened = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") {
      depth += 1;
      opened = true;
    } else if (character === "}") {
      depth -= 1;
      if (opened && depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  throw new Error(`unterminated ${functionName}`);
}

function runExtractedCaller(caller: (typeof CALLERS)[number], scenario: string): CurlCall[] {
  const root = mkdtempSync(join(tmpdir(), "fluncle-health-receipt-shell-"));
  const calls = join(root, "calls");
  const curl = join(root, "curl");
  const runner = join(root, "runner.sh");
  writeFileSync(calls, "", "utf8");
  writeFileSync(curl, CURL_STUB, "utf8");
  chmodSync(curl, 0o755);

  const implementation = extractFunction(readFileSync(caller.path, "utf8"), caller.functionName);
  writeFileSync(
    runner,
    `#!/usr/bin/env bash\nset -euo pipefail\nlog() { :; }\n${caller.setup}\n${implementation}\npost_health ok ready\n`,
    "utf8",
  );

  try {
    const result = spawnSync("bash", [runner], {
      encoding: "utf8",
      env: {
        ...process.env,
        HEALTH_CALLS: calls,
        HEALTH_SCENARIO: scenario,
        PATH: `${root}:/usr/bin:/bin`,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    return readCalls(calls);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function runWatchdog(scenario: string): CurlCall[] {
  const root = mkdtempSync(join(tmpdir(), "fluncle-health-receipt-watchdog-"));
  const calls = join(root, "calls");
  const curl = join(root, "curl");
  writeFileSync(calls, "", "utf8");
  writeFileSync(curl, CURL_STUB, "utf8");
  chmodSync(curl, 0o755);

  try {
    const result = spawnSync("bash", [WATCHDOG], {
      encoding: "utf8",
      env: {
        ...process.env,
        FLUNCLE_API_TOKEN: "test-token",
        HEALTH_CALLS: calls,
        HEALTH_SCENARIO: scenario,
        PATH: `${root}:/usr/bin:/bin`,
        WATCH_CURL_BIN: curl,
        WATCH_ONION_ATTEMPTS: "1",
        WATCH_ONION_URL: "https://onion.invalid/health",
        WATCH_STATE_DIR: join(root, "state"),
        WATCH_WORKER_URL: "https://worker.invalid",
      },
    });
    expect(result.status, result.stderr).toBe(0);
    return readCalls(calls);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

describe("receipt-backed shell health callers", () => {
  test.each(CALLERS)("$name reconciles HTTP 524 and accepts the committed receipt", (caller) => {
    const calls = runExtractedCaller(caller, "committed");
    expect(urls(calls)).toEqual([
      "https://worker.invalid/api/v1/admin/health",
      "https://worker.invalid/api/v1/admin/operation-receipts/resolve",
    ]);
    expectReceiptCoordinates(calls);
  });

  test.each(CALLERS)("$name replays only after safely-retryable", (caller) => {
    const calls = runExtractedCaller(caller, "retry");
    expect(urls(calls)).toEqual([
      "https://worker.invalid/api/v1/admin/health",
      "https://worker.invalid/api/v1/admin/operation-receipts/resolve",
      "https://worker.invalid/api/v1/admin/health",
    ]);
    expectReceiptCoordinates(calls);
  });

  test.each(CALLERS)("$name reconciles a curl transport failure", (caller) => {
    const calls = runExtractedCaller(caller, "transport");
    expect(urls(calls)).toEqual([
      "https://worker.invalid/api/v1/admin/health",
      "https://worker.invalid/api/v1/admin/operation-receipts/resolve",
    ]);
    expectReceiptCoordinates(calls);
  });

  test("the rave watchdog reconciles HTTP 524 and accepts the committed receipt", () => {
    const calls = runWatchdog("committed");
    expect(urls(calls)).toEqual([
      "https://onion.invalid/health",
      "https://worker.invalid/api/v1/admin/health",
      "https://worker.invalid/api/v1/admin/operation-receipts/resolve",
    ]);
    expectReceiptCoordinates(calls);
  });

  test("the rave watchdog replays only after safely-retryable", () => {
    const calls = runWatchdog("retry");
    expect(urls(calls)).toEqual([
      "https://onion.invalid/health",
      "https://worker.invalid/api/v1/admin/health",
      "https://worker.invalid/api/v1/admin/operation-receipts/resolve",
      "https://worker.invalid/api/v1/admin/health",
    ]);
    expectReceiptCoordinates(calls);
  });

  test("the rave watchdog reconciles a curl transport failure", () => {
    const calls = runWatchdog("transport");
    expect(urls(calls)).toEqual([
      "https://onion.invalid/health",
      "https://worker.invalid/api/v1/admin/health",
      "https://worker.invalid/api/v1/admin/operation-receipts/resolve",
    ]);
    expectReceiptCoordinates(calls);
  });
});
