import { describe, expect, test } from "bun:test";
import { fluncleAsciiLogo } from "./brand";

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

  test("admin queue validates --limit before fetching", async () => {
    const result = await runCli(["admin", "queue", "--limit", "0", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Limit must be an integer between 1 and 100");
  });

  test("admin vehicles validates --limit before fetching", async () => {
    const result = await runCli(["admin", "vehicles", "--limit", "0", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Limit must be an integer between 1 and 100");
  });

  test("admin enrich-queue validates --limit before fetching", async () => {
    const result = await runCli(["admin", "enrich-queue", "--limit", "0", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Limit must be an integer between 1 and 100");
  });

  test("admin enrich-sweep validates --limit before any sweep", async () => {
    const result = await runCli(["admin", "enrich-sweep", "--limit", "0", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Limit must be an integer between 1 and 100");
  });

  test("admin enrich-queue and enrich-sweep show in admin help (distinct from the video queue)", async () => {
    const adminHelp = await runCli(["admin", "help"]);

    expect(adminHelp.exitCode).toBe(0);
    expect(adminHelp.stdout).toContain("enrich-queue");
    expect(adminHelp.stdout).toContain("enrich-sweep");
    // The video render queue stays its own command.
    expect(adminHelp.stdout).toContain("queue");
  });

  test("admin track video requires a footage cut before any upload", async () => {
    // A --dir with no footage.mp4 fails the local validation before the presign
    // request, so this runs without a server or admin token.
    const result = await runCli([
      "admin",
      "track",
      "video",
      "004.7.2I",
      "--dir",
      "/tmp/fluncle-no-such-bundle",
      "--json",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`{
  "code": "error",
  "message": "A footage cut is required (--footage <file>, or --dir containing footage.mp4)",
  "ok": false
}
`);
  });

  test("admin track observe requires a script before any render", async () => {
    // No --script / --script-file fails local validation before the API call,
    // so this runs without a server or admin token (and never spends a render).
    const result = await runCli(["admin", "track", "observe", "004.7.2I", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: fluncle admin track observe");
  });

  test("keeps root help listener-facing", async () => {
    const result = await runCli([]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.startsWith(`\n${fluncleAsciiLogo}`)).toBe(true);
    expect(result.stdout).toContain("recent|list [options]");
    expect(result.stdout).toContain("submit [searchOrSpotifyUrl...]");
    expect(result.stdout).toContain("fluncle version [--check] [--json]");
    expect(result.stdout).toContain("Fluncle elsewhere:");
    expect(result.stdout).toContain("https://www.tiktok.com/@fluncle");
    expect(result.stdout).not.toContain("admin");
    expect(result.stdout).not.toContain("[unexpected");
    expect(result.stdout).not.toContain("[extra");
    expect(result.stdout).not.toContain("Operator:");
  });

  test("about prints the wordmark, the intro, and the grouped link map", async () => {
    const result = await runCli(["about"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(fluncleAsciiLogo);
    expect(result.stdout).toContain("Drum & bass bangers from another dimension");
    expect(result.stdout).toContain("I'm Fluncle.");
    // No exclamation marks anywhere (VOICE.md's Dry Rule).
    expect(result.stdout).not.toContain("!");
    // The grouped link map, verbatim canonical URLs.
    expect(result.stdout).toContain("Where to listen:");
    expect(result.stdout).toContain("Follow the crew:");
    expect(result.stdout).toContain("The mothership:");
    expect(result.stdout).toContain("For the nerds:");
    expect(result.stdout).toContain("https://open.spotify.com/playlist/1m5LADqpLjiBERdtqrIiL0");
    expect(result.stdout).toContain("https://www.mixcloud.com/fluncle/");
    expect(result.stdout).toContain("https://galaxy.fluncle.com");
    expect(result.stdout).toContain("ssh rave.fluncle.com");
    expect(result.stdout).toContain("https://github.com/mauricekleine/fluncle");
  });

  test("about takes no positional argument", async () => {
    const result = await runCli(["about", "extra"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unexpected argument 'extra'");
  });

  test("supports help commands at root and admin levels", async () => {
    const rootHelp = await runCli(["help"]);
    const adminDefault = await runCli(["admin"]);
    const adminHelp = await runCli(["admin", "help"]);

    expect(rootHelp.exitCode).toBe(0);
    expect(rootHelp.stdout.startsWith(`\n${fluncleAsciiLogo}`)).toBe(true);
    expect(rootHelp.stdout).toContain("Usage: fluncle [options] [command]");
    expect(rootHelp.stdout).not.toContain("Operator:");

    expect(adminDefault.exitCode).toBe(0);
    expect(adminDefault.stdout).not.toContain(fluncleAsciiLogo);
    expect(adminDefault.stdout).toContain("Usage: fluncle admin [options] [command]");

    expect(adminHelp.exitCode).toBe(0);
    expect(adminHelp.stderr).toBe("");
    expect(adminHelp.stdout).not.toContain(fluncleAsciiLogo);
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
