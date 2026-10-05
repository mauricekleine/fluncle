import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { curlUrlConfig } from "./curl-config";

const root = resolve(import.meta.dir, "../../../..");
const sensitive =
  /Authorization|X-Auth-Key|(?:^|[\s"'])-u|--user(?:[\s="']|$)|\b\w*(?:WEBHOOK|BEACON|SECRET_URL|TOKEN_URL)\w*\b|https?:\/\/(?:[^\s"']*discord[^\s"']*\/webhooks\/|[^\s"']*hc-ping\.com\/)/i;

function unsafeCurlCommands(source: string, typescript = false): string[] {
  const argvSource = source.replace(/<<<"\$\(curl_config[^\n]*?\)"/g, "").replace(/\\\n/g, " ");
  const commands = typescript
    ? Array.from(
        argvSource.matchAll(/["']curl["']\s*,\s*\[([^\]]*)\]|\[\s*["']curl["']([^\]]*)\]/g),
        (match) => match[1] ?? match[2] ?? "",
      )
    : argvSource.split("\n").filter((line) => /(?:\bcurl\s|"\$\{?CURL_BIN\}?"\s)/.test(line));
  const secretArrays = Array.from(
    argvSource.matchAll(/(\w+)\+?=\([^\n]*(?:Authorization|X-Auth-Key)[^\n]*\)/gi),
    (match) => match[1],
  );
  if (/auth_headers/.test(argvSource)) {
    secretArrays.push("hdrs", "auth_headers");
  }
  return commands.filter(
    (command) =>
      sensitive.test(command) ||
      secretArrays.some((name) => name !== undefined && command.includes(`\${${name}[@]}`)),
  );
}

test("the secret argv scanner detects exposed headers, credentials, arrays, and URLs", () => {
  for (const command of [
    'curl -H "Authorization: Bearer ${token}" "$url"',
    'curl -H "X-Auth-Key: $key" "$url"',
    'curl -u "$credentials" "$url"',
    'curl -u"$credentials" "$url"',
    'curl --user="$credentials" "$url"',
    'curl "$DISCORD_ALERT_WEBHOOK"',
    'curl "${RAVE01_BEACON_URL}"',
    'auth_headers=( -H "X-Auth-Key: $key" )\ncurl "${auth_headers[@]}" "$url"',
  ]) {
    expect(unsafeCurlCommands(command)).toHaveLength(1);
  }
  expect(unsafeCurlCommands('run("curl", ["-sS", BEACON_URL])', true)).toHaveLength(1);
  expect(
    unsafeCurlCommands('Bun.spawn(["curl", "-H", "Authorization: Bearer token"])', true),
  ).toHaveLength(1);
  expect(
    unsafeCurlCommands(
      'curl --config - <<<"$(curl_config header "Authorization: Bearer $token")" "$url"',
    ),
  ).toEqual([]);
});

test("URL config preserves curl requests with quotes and backslashes", async () => {
  const server = Bun.serve({
    fetch: (request) => new Response(request.url),
    port: 0,
  });
  async function request(args: string[], input?: string) {
    const child = Bun.spawn(["curl", "-sS", "--max-time", "2", "-w", "\n%{http_code}", ...args], {
      stderr: "pipe",
      stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
      stdout: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stderr, stdout };
  }
  try {
    const url = `http://127.0.0.1:${server.port}/?value="quoted"\\tail`;
    const direct = await request([url]);
    expect(direct.code).toBe(0);
    expect(direct.stdout).toEndWith("\n200");
    expect(await request(["--config", "-"], curlUrlConfig(url))).toEqual(direct);
  } finally {
    await server.stop(true);
  }
});

test("tracked host scripts keep curl secrets out of argv", () => {
  const paths = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const violations: string[] = [];
  for (const path of paths) {
    const typescript = /^docs\/agents\/hermes\/scripts\/.*(?<!\.test)\.ts$/.test(path);
    const shellArea = /^(?:docs\/agents\/hermes\/|apps\/[^/]+\/(?:deploy|watchdog|scripts)\/)/.test(
      path,
    );
    if (!path.endsWith(".sh") && !typescript && !shellArea) {
      continue;
    }
    const source = readFileSync(resolve(root, path), "utf8");
    if (!path.endsWith(".sh") && !typescript && !/^#![^\n]*\bbash\b/.test(source)) {
      continue;
    }
    for (const command of unsafeCurlCommands(source, typescript)) {
      violations.push(`${path}: ${command.trim()}`);
    }
  }
  expect(violations).toEqual([]);
});
