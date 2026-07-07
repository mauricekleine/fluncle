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
    const result = await runCli(["tracks", "get", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`{
  "code": "error",
  "message": "Missing id. Usage: fluncle tracks get <track_id|log_id> [--json]",
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

  test("admin tracks queue validates --limit before fetching", async () => {
    const result = await runCli(["admin", "tracks", "queue", "--limit", "0", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Limit must be an integer between 1 and 100");
  });

  test("admin tracks vehicles validates --limit before fetching", async () => {
    const result = await runCli(["admin", "tracks", "vehicles", "--limit", "0", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Limit must be an integer between 1 and 100");
  });

  test("admin tracks enrich --queue validates --limit before fetching", async () => {
    const result = await runCli(["admin", "tracks", "enrich", "--queue", "--limit", "0", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Limit must be an integer between 1 and 100");
  });

  test("admin tracks capture-audio --queue validates --limit before fetching", async () => {
    const result = await runCli([
      "admin",
      "tracks",
      "capture-audio",
      "--queue",
      "--limit",
      "0",
      "--json",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Limit must be an integer between 1 and 100");
  });

  test("admin tracks capture-audio requires --queue (a worklist view, no single-track form)", async () => {
    const result = await runCli(["admin", "tracks", "capture-audio", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("worklist view");
    expect(result.stderr).toContain("capture-audio --queue");
  });

  test("admin tracks group lists the queue + pipeline subcommands", async () => {
    const tracksHelp = await runCli(["admin", "tracks", "--help"]);

    expect(tracksHelp.exitCode).toBe(0);
    // The worklist views are `--queue` flags on the verbs (Convention B §6.4 — no
    // dash-compound `*-queue` commands). The enrichment sweep itself is the on-box
    // `fluncle-enrich` cron, which reads `tracks enrich --queue` to drain the queue.
    expect(tracksHelp.stdout).toContain("enrich");
    // The full-song capture worklist verb (named `capture-audio`, not `capture`, to avoid
    // colliding with `social --capture` / `cron.social-capture`).
    expect(tracksHelp.stdout).toContain("capture-audio");
    expect(tracksHelp.stdout).not.toContain("enrich-queue");
    expect(tracksHelp.stdout).not.toContain("enrich-sweep");
    expect(tracksHelp.stdout).not.toContain("context-queue");
    expect(tracksHelp.stdout).not.toContain("observe-queue");
    expect(tracksHelp.stdout).toContain("queue");
    expect(tracksHelp.stdout).toContain("publish");
    expect(tracksHelp.stdout).toContain("vehicles");
    // The observation-pipeline surface: the context + observe verbs (each with a
    // `--queue` worklist view).
    expect(tracksHelp.stdout).toContain("context");
    expect(tracksHelp.stdout).toContain("observe");
  });

  test("admin tracks video requires a footage cut before any upload", async () => {
    // A --dir with no footage.mp4 fails the local validation before the presign
    // request, so this runs without a server or admin token.
    const result = await runCli([
      "admin",
      "tracks",
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
  "message": "A footage cut is required (--footage <file>, or --dir containing footage.mp4). Pass --allow-partial for a deliberate partial refresh (e.g. poster-only), or upload plates alone (--plate/--plate-background) for the plate-lane pre-upload.",
  "ok": false
}
`);
  });

  test("the singular `admin track` group alias is gone", async () => {
    const result = await runCli([
      "admin",
      "track",
      "video",
      "004.7.2I",
      "--dir",
      "/tmp/fluncle-no-such-bundle",
      "--json",
    ]);

    // The back-compat singular group was removed: `admin track` no longer resolves to
    // the canonical `admin tracks` handler.
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("A footage cut is required");
  });

  test("admin tracks observe requires a script before any render", async () => {
    // No --script / --script-file fails local validation before the API call,
    // so this runs without a server or admin token (and never spends a render).
    const result = await runCli(["admin", "tracks", "observe", "004.7.2I", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: fluncle admin tracks observe");
  });

  test("admin tracks context requires an id before any fetch", async () => {
    // No id fails local validation before the API call, so this runs without a
    // server or admin token (and never spends a Firecrawl fetch).
    const result = await runCli(["admin", "tracks", "context", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: fluncle admin tracks context");
  });

  test("admin tracks get requires an id before any lookup", async () => {
    // No id fails local validation before the API call, so this runs without a
    // server or admin token. The usage names the admin `get`, not the public one.
    const result = await runCli(["admin", "tracks", "get", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`{
  "code": "error",
  "message": "Missing id. Usage: fluncle admin tracks get <track_id|log_id> [--json]",
  "ok": false
}
`);
  });

  test("admin tracks requeue-video requires an id before any clear", async () => {
    // No id fails local validation before the API call, so this runs without a
    // server or admin token (and never clears a live video).
    const result = await runCli(["admin", "tracks", "requeue-video", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: fluncle admin tracks requeue-video");
  });

  test("admin tracks context --queue validates --limit before fetching", async () => {
    const result = await runCli([
      "admin",
      "tracks",
      "context",
      "--queue",
      "--limit",
      "0",
      "--json",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Limit must be an integer between 1 and 100");
  });

  test("admin tracks observe --queue validates --limit before fetching", async () => {
    const result = await runCli([
      "admin",
      "tracks",
      "observe",
      "--queue",
      "--limit",
      "0",
      "--json",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Limit must be an integer between 1 and 100");
  });

  test("admin tracks queue accepts the --has-observation filter", async () => {
    // The boolean filter parses cleanly; --limit still validates first.
    const result = await runCli([
      "admin",
      "tracks",
      "queue",
      "--has-observation",
      "--limit",
      "0",
      "--json",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Limit must be an integer between 1 and 100");
  });

  test("the --has-context no-op flag is gone from admin tracks queue", async () => {
    // The render queue is always context-gated, so the no-op flag was removed:
    // commander now rejects it as an unknown option (surfaced as a JSON error).
    const result = await runCli(["admin", "tracks", "queue", "--has-context", "--json"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("Unknown option '--has-context'");
  });

  test("admin tracks publish resolves; the old flat admin add alias is gone", async () => {
    const canonical = await runCli(["admin", "tracks", "publish", "--json"]);
    const removed = await runCli(["admin", "add", "--json"]);

    expect(canonical.exitCode).toBe(1);
    expect(canonical.stdout).toContain("Missing Spotify track URL");
    // The back-compat flat alias was removed: `admin add` no longer reaches the
    // publish handler.
    expect(removed.exitCode).not.toBe(0);
    expect(removed.stdout).not.toContain("Missing Spotify track URL");
  });

  test("admin tracks preview resolves; the old preview-archive name is gone", async () => {
    const canonical = await runCli(["admin", "tracks", "preview", "--json"]);
    const removed = await runCli(["admin", "tracks", "preview-archive", "--json"]);

    expect(canonical.exitCode).toBe(1);
    expect(canonical.stdout).toContain("Usage: fluncle admin tracks preview");
    // The dash-compound alias was dropped (admin surface, no-alias policy): the old
    // name no longer resolves to the command — it errors instead of printing the
    // `preview` usage.
    expect(removed.exitCode).toBe(1);
    expect(removed.stdout).not.toContain("Usage: fluncle admin tracks preview");
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

  test("admin newsletter draft requires a content payload before any API call", async () => {
    // No --content-file fails local validation (CliError) before the API call, so
    // this runs without a server or admin token.
    const result = await runCli(["admin", "newsletter", "draft", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("missing_content");
  });

  test("admin newsletter update requires an id before any API call", async () => {
    const result = await runCli(["admin", "newsletter", "update", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: fluncle admin newsletter update");
  });

  test("admin newsletter send requires an id before any API call", async () => {
    // Send is operator-gated server-side; the missing-id guard fails first, so this
    // runs without a server or token (and never reaches the Resend broadcast).
    const result = await runCli(["admin", "newsletter", "send", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: fluncle admin newsletter send");
  });

  test("admin newsletter delete requires an id before any API call", async () => {
    const result = await runCli(["admin", "newsletter", "delete", "--yes", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: fluncle admin newsletter delete");
  });

  test("admin newsletter delete requires --yes to confirm the hard delete", async () => {
    // The id is present, so the --yes guard fails first — no server or token needed.
    const result = await runCli(["admin", "newsletter", "delete", "some-id", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("--yes");
  });

  test("admin newsletter group lists its draft/update/send/list/delete subcommands", async () => {
    // The group's default action prints its own help (no subcommand given).
    const help = await runCli(["admin", "newsletter"]);

    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("Usage: fluncle admin newsletter");
    expect(help.stdout).toContain("draft");
    expect(help.stdout).toContain("update");
    expect(help.stdout).toContain("send");
    expect(help.stdout).toContain("list");
    expect(help.stdout).toContain("delete");
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
    // The canonical Convention B groups show in the operator help.
    expect(adminHelp.stdout).toContain("tracks");
    expect(adminHelp.stdout).toContain("submissions");
    expect(adminHelp.stdout).toContain("backfills");
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
