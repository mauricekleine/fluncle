import { describe, expect, test } from "bun:test";

const cliPath = new URL("./cli.ts", import.meta.url).pathname;

describe("fluncle CLI parsing and JSON output", () => {
  test("prints version JSON", async () => {
    const result = await runCli(["version", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`{
  "ok": true,
  "currentVersion": "0.1.0",
  "message": "fluncle 0.1.0"
}
`);
  });

  test("keeps validation failures as JSON when --json is present", async () => {
    const result = await runCli(["track", "get", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`{
  "code": "error",
  "message": "Missing id. Usage: fluncle track get <track_id|log_id> [--json]",
  "ok": false
}
`);
  });

  test("preserves the recent alias and limit validation before fetching", async () => {
    const result = await runCli(["list", "--limit", "0", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`{
  "code": "error",
  "message": "Limit must be an integer between 1 and 100",
  "ok": false
}
`);
  });

  test("keeps root help listener-facing", async () => {
    const result = await runCli([]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("recent|list [options]");
    expect(result.stdout).toContain("submit [searchOrSpotifyUrl...]");
    expect(result.stdout).toContain("fluncle version [--check] [--json]");
    expect(result.stdout).not.toContain("admin");
    expect(result.stdout).not.toContain("[unexpected");
    expect(result.stdout).not.toContain("[extra");
    expect(result.stdout).not.toContain("Operator:");
  });

  test("supports help commands at root and admin levels", async () => {
    const rootHelp = await runCli(["help"]);
    const adminDefault = await runCli(["admin"]);
    const adminHelp = await runCli(["admin", "help"]);

    expect(rootHelp.exitCode).toBe(0);
    expect(rootHelp.stdout).toContain("Usage: fluncle [options] [command]");
    expect(rootHelp.stdout).not.toContain("Operator:");

    expect(adminDefault.exitCode).toBe(0);
    expect(adminDefault.stdout).toContain("Usage: fluncle admin [options] [command]");

    expect(adminHelp.exitCode).toBe(0);
    expect(adminHelp.stderr).toBe("");
    expect(adminHelp.stdout).toContain("Usage: fluncle admin [options] [command]");
    expect(adminHelp.stdout).toContain("add [options] [spotifyUrl]");
    expect(adminHelp.stdout).toContain("submissions");
  });
});

async function runCli(args: string[]): Promise<{
  exitCode: number;
  stderr: string;
  stdout: string;
}> {
  const proc = Bun.spawn([process.execPath, cliPath, ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return {
    exitCode,
    stderr,
    stdout,
  };
}
