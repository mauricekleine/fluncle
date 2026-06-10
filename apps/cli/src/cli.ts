#!/usr/bin/env bun

import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { setEnvProfile } from "./env";
import { printJson, toJsonFailure } from "./output";
import { formatError } from "./retry";

type GlobalOptions = {
  args: string[];
  envProfile?: string;
};

async function main(): Promise<void> {
  const globalOptions = parseGlobalOptions(process.argv.slice(2));
  setEnvProfile(globalOptions.envProfile);

  const [command, subcommand, ...rest] = globalOptions.args;

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "recent" || command === "list") {
    const { recentCommand } = await import("./commands/recent");
    await runRecent([subcommand, ...rest].filter(Boolean), recentCommand);
    return;
  }

  if (command === "open") {
    const openCommands = await import("./commands/open");
    await runOpen([subcommand, ...rest].filter(Boolean), openCommands);
    return;
  }

  if (command === "random") {
    const { randomCommand } = await import("./commands/random");
    await runRandom([subcommand, ...rest].filter(Boolean), randomCommand);
    return;
  }

  if (command === "submit") {
    const { submitCommand } = await import("./commands/submit");
    await submitCommand([subcommand, ...rest].filter(Boolean).join(" ") || undefined);
    return;
  }

  if (command === "subscribe") {
    const { subscribeCommand } = await import("./commands/subscribe");
    await runSubscribe([subcommand, ...rest].filter(Boolean), subscribeCommand);
    return;
  }

  if (command === "version") {
    const { versionCommand } = await import("./version");
    await runVersion([subcommand, ...rest].filter(Boolean), versionCommand);
    return;
  }

  if (command === "admin" && subcommand === "add") {
    const { addCommand } = await import("./commands/add");
    await runAdd(rest, addCommand);
    return;
  }

  if (command === "admin" && subcommand === "track" && rest[0] === "update") {
    const { trackUpdateCommand } = await import("./commands/track");
    await runTrackUpdate(rest.slice(1), trackUpdateCommand);
    return;
  }

  if (command === "admin" && subcommand === "track" && rest[0] === "video") {
    const { trackVideoCommand } = await import("./commands/track");
    await runTrackVideo(rest.slice(1), trackVideoCommand);
    return;
  }

  if (command === "admin" && subcommand === "track" && rest[0] === "draft") {
    const { trackDraftCommand } = await import("./commands/track");
    await runTrackDraft(rest.slice(1), trackDraftCommand);
    return;
  }

  if (command === "admin" && subcommand === "track" && rest[0] === "social") {
    const { trackSocialShowCommand, trackSocialUpdateCommand } = await import("./commands/track");
    await runTrackSocial(rest.slice(1), trackSocialShowCommand, trackSocialUpdateCommand);
    return;
  }

  if (command === "track" && subcommand === "get") {
    const { trackGetCommand } = await import("./commands/track");
    await runTrackGet(rest, trackGetCommand);
    return;
  }

  if (command === "admin" && subcommand === "submissions") {
    const submissionCommands = await import("./commands/submissions");
    await runAdminSubmissions(rest, submissionCommands);
    return;
  }

  if (command === "admin" && subcommand === "auth" && rest[0] === "spotify") {
    const { authSpotifyCommand } = await import("./commands/auth");
    await authSpotifyCommand();
    return;
  }

  throw new Error(`Unknown command: ${[command, subcommand].filter(Boolean).join(" ")}`);
}

async function runTrackVideo(
  args: string[],
  trackVideoCommand: typeof import("./commands/track").trackVideoCommand,
): Promise<void> {
  const parsed = parseArgs({
    allowPositionals: true,
    args,
    options: {
      composition: { type: "string" },
      dir: { type: "string" },
      footage: { type: "string" },
      "footage-silent": { type: "string" },
      json: { default: false, type: "boolean" },
      note: { type: "string" },
      poster: { type: "string" },
      props: { type: "string" },
      render: { type: "string" },
    },
  });

  const idOrLogId = parsed.positionals[0];

  if (!idOrLogId) {
    throw new Error(
      "Missing id. Usage: fluncle admin track video <track_id|log_id> (--dir <dir> | --footage <file> [--footage-silent <file>] [--poster <file>] [--note <file>] [--composition <file>] [--props <file>] [--render <file>])",
    );
  }

  // --dir resolves the conventional bundle names; explicit flags override.
  const dir = parsed.values.dir;
  const fromDir = (name: string): string | undefined => {
    if (!dir) {
      return undefined;
    }

    const candidate = path.join(dir, name);

    return existsSync(candidate) ? candidate : undefined;
  };

  const files = {
    composition: parsed.values.composition ?? fromDir("composition.tsx"),
    footage: parsed.values.footage ?? fromDir("footage.mp4"),
    footageSilent: parsed.values["footage-silent"] ?? fromDir("footage-silent.mp4"),
    note: parsed.values.note ?? fromDir("note.txt"),
    poster: parsed.values.poster ?? fromDir("poster.jpg"),
    props: parsed.values.props ?? fromDir("props.json"),
    render: parsed.values.render ?? fromDir("render.json"),
  };

  if (!files.footage) {
    throw new Error(
      "A footage cut is required (--footage <file>, or --dir containing footage.mp4)",
    );
  }

  const result = await trackVideoCommand(idOrLogId, files);

  if (parsed.values.json) {
    printJson(result);
    return;
  }

  console.log(`Linked video to ${result.logId}`);

  for (const [field, url] of Object.entries(result.urls)) {
    console.log(`  ${field}: ${url}`);
  }
}

async function runTrackDraft(
  args: string[],
  trackDraftCommand: typeof import("./commands/track").trackDraftCommand,
): Promise<void> {
  const parsed = parseArgs({
    allowPositionals: true,
    args,
    options: { json: { default: false, type: "boolean" }, platform: { type: "string" } },
  });

  const idOrLogId = parsed.positionals[0];

  if (!idOrLogId) {
    throw new Error(
      "Missing id. Usage: fluncle admin track draft <track_id|log_id> [--platform tiktok]",
    );
  }

  const platform = parsed.values.platform ?? "tiktok";
  const result = await trackDraftCommand(idOrLogId, platform);

  if (parsed.values.json) {
    printJson(result);
    return;
  }

  console.log(`Pushed ${platform} draft for ${result.trackId} (post ${result.externalId})`);
}

async function runTrackSocial(
  args: string[],
  trackSocialShowCommand: typeof import("./commands/track").trackSocialShowCommand,
  trackSocialUpdateCommand: typeof import("./commands/track").trackSocialUpdateCommand,
): Promise<void> {
  const parsed = parseArgs({
    allowPositionals: true,
    args,
    options: {
      json: { default: false, type: "boolean" },
      platform: { type: "string" },
      "scheduled-for": { type: "string" },
      status: { type: "string" },
      url: { type: "string" },
    },
  });

  const idOrLogId = parsed.positionals[0];

  if (!idOrLogId) {
    throw new Error(
      "Missing id. Usage: fluncle admin track social <track_id|log_id> [--platform tiktok] [--status scheduled|published [--url <url>]]",
    );
  }

  const status = parsed.values.status;

  // No --status: show the track's per-platform state.
  if (!status) {
    const result = await trackSocialShowCommand(idOrLogId);

    if (parsed.values.json) {
      printJson(result);
      return;
    }

    if (result.posts.length === 0) {
      console.log("No social posts yet.");
      return;
    }

    for (const post of result.posts) {
      console.log(`${post.platform}: ${post.status}${post.url ? ` · ${post.url}` : ""}`);
    }

    return;
  }

  if (status !== "scheduled" && status !== "published" && status !== "failed") {
    throw new Error(`Invalid --status: ${status} (expected scheduled, published, or failed)`);
  }

  if (status === "published" && !parsed.values.url) {
    throw new Error("Publishing requires --url <post-url>");
  }

  const platform = parsed.values.platform ?? "tiktok";
  const result = await trackSocialUpdateCommand(idOrLogId, platform, {
    scheduledFor: parsed.values["scheduled-for"],
    status,
    url: parsed.values.url,
  });

  if (parsed.values.json) {
    printJson(result);
    return;
  }

  console.log(`${platform} → ${status} for ${result.trackId}`);
}

async function runAdminSubmissions(
  args: string[],
  submissionCommands: typeof import("./commands/submissions"),
): Promise<void> {
  const [action, submissionId, extra] = args;

  if (!action) {
    await submissionCommands.listSubmissionsCommand();
    return;
  }

  if (extra) {
    throw new Error(`Unknown submissions arguments: ${args.join(" ")}`);
  }

  if (!submissionId) {
    throw new Error(`Missing submission id for: ${action}`);
  }

  if (action === "review") {
    await submissionCommands.reviewSubmissionCommand(submissionId);
    return;
  }

  if (action === "reject") {
    await submissionCommands.rejectSubmissionCommand(submissionId);
    return;
  }

  if (action === "approve") {
    await submissionCommands.approveSubmissionCommand(submissionId);
    return;
  }

  throw new Error(`Unknown submissions command: ${action}`);
}

async function runTrackGet(
  args: string[],
  trackGetCommand: typeof import("./commands/track").trackGetCommand,
): Promise<void> {
  const parsed = parseArgs({
    allowPositionals: true,
    args,
    options: { json: { default: false, type: "boolean" } },
  });

  const idOrLogId = parsed.positionals[0];

  if (!idOrLogId) {
    throw new Error("Missing id. Usage: fluncle track get <track_id|log_id> [--json]");
  }

  const result = await trackGetCommand(idOrLogId);

  if (parsed.values.json) {
    printJson(result);
    return;
  }

  const t = result.track;
  console.log(`${t.logId ? `${t.logId}  ` : ""}${t.artists.join(", ")} — ${t.title}`);
  console.log(
    [
      t.bpm ? `${t.bpm} bpm` : undefined,
      t.key ?? undefined,
      t.label ?? undefined,
      t.tags?.length ? t.tags.join(", ") : undefined,
      t.enrichmentStatus,
    ]
      .filter(Boolean)
      .join(" · "),
  );
}

async function runTrackUpdate(
  args: string[],
  trackUpdateCommand: typeof import("./commands/track").trackUpdateCommand,
): Promise<void> {
  const parsed = parseArgs({
    allowPositionals: true,
    args,
    options: {
      bpm: { type: "string" },
      features: { type: "string" },
      json: { default: false, type: "boolean" },
      key: { type: "string" },
      note: { type: "string" },
      status: { type: "string" },
      tag: { multiple: true, type: "string" },
      "tag-source": { type: "string" },
      "video-url": { type: "string" },
    },
  });

  const trackId = parsed.positionals[0];

  if (!trackId) {
    throw new Error("Missing track id. Usage: fluncle admin track update <track_id> [--tag ...]");
  }

  const tagSource = parsed.values["tag-source"];

  if (tagSource !== undefined && tagSource !== "auto" && tagSource !== "manual") {
    throw new Error(`Invalid --tag-source: ${tagSource} (expected "auto" or "manual")`);
  }

  const bpm = parsed.values.bpm === undefined ? undefined : Number(parsed.values.bpm);

  if (bpm !== undefined && !Number.isFinite(bpm)) {
    throw new Error(`Invalid --bpm: ${parsed.values.bpm}`);
  }

  const result = await trackUpdateCommand(trackId, {
    bpm,
    features: parsed.values.features,
    key: parsed.values.key,
    note: parsed.values.note,
    status: parsed.values.status,
    tags: parsed.values.tag,
    tagsSource: tagSource,
    videoUrl: parsed.values["video-url"],
  });

  if (parsed.values.json) {
    printJson(result);
    return;
  }

  console.log(`Updated ${result.trackId}: ${result.fields.join(", ")}`);
}

async function runAdd(
  args: string[],
  addCommand: typeof import("./commands/add").addCommand,
): Promise<void> {
  const parsed = parseArgs({
    allowPositionals: true,
    args,
    options: {
      "dry-run": {
        default: false,
        type: "boolean",
      },
      json: {
        default: false,
        type: "boolean",
      },
      note: {
        type: "string",
      },
    },
  });

  const spotifyUrl = parsed.positionals[0];

  if (!spotifyUrl) {
    throw new Error("Missing Spotify track URL");
  }

  const result = await addCommand(spotifyUrl, {
    dryRun: parsed.values["dry-run"],
    json: parsed.values.json,
    note: parsed.values.note,
  });

  if (parsed.values.json) {
    printJson({
      ok: true,
      ...result,
    });
  }
}

async function runRecent(
  args: string[],
  recentCommand: typeof import("./commands/recent").recentCommand,
): Promise<void> {
  const parsed = parseArgs({
    allowPositionals: false,
    args,
    options: {
      json: {
        default: false,
        type: "boolean",
      },
      limit: {
        default: "10",
        type: "string",
      },
      "needs-video": {
        default: false,
        type: "boolean",
      },
    },
  });

  const limit = Number.parseInt(parsed.values.limit ?? "10", 10);

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Limit must be an integer between 1 and 100");
  }

  const fetched = await recentCommand(limit);
  // --needs-video: only findings that don't have a rendered video yet.
  const tracks = parsed.values["needs-video"]
    ? fetched.filter((track) => !track.videoUrl)
    : fetched;

  if (parsed.values.json) {
    printJson({
      ok: true,
      tracks,
    });
    return;
  }

  if (tracks.length === 0) {
    console.log("No findings logged yet.");
    return;
  }

  const { trackRows } = await import("./format");
  console.log(trackRows(tracks).join("\n"));
}

async function runOpen(
  args: string[],
  openCommands: typeof import("./commands/open"),
): Promise<void> {
  const parsed = parseArgs({
    allowPositionals: true,
    args,
    options: {
      app: {
        default: false,
        type: "boolean",
      },
      browser: {
        default: false,
        type: "boolean",
      },
      limit: {
        default: "20",
        type: "string",
      },
    },
  });

  if (parsed.values.app && parsed.values.browser) {
    throw new Error("Use either --app or --browser, not both");
  }

  const mode: import("./commands/open").OpenMode = parsed.values.browser
    ? "browser"
    : parsed.values.app
      ? "app"
      : "default";
  const [target, extra] = parsed.positionals;

  if (extra) {
    throw new Error(`Unknown open target: ${parsed.positionals.join(" ")}`);
  }

  if (target === "playlist") {
    await openCommands.openPlaylistCommand(mode);
    return;
  }

  if (target === "telegram") {
    await openCommands.openTelegramCommand(mode);
    return;
  }

  if (target) {
    throw new Error(`Unknown open target: ${target}`);
  }

  const limit = Number.parseInt(parsed.values.limit ?? "20", 10);

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Limit must be an integer between 1 and 100");
  }

  await openCommands.openRecentCommand({
    limit,
    mode,
  });
}

async function runRandom(
  args: string[],
  randomCommand: typeof import("./commands/random").randomCommand,
): Promise<void> {
  const parsed = parseArgs({
    allowPositionals: false,
    args,
    options: {
      json: {
        default: false,
        type: "boolean",
      },
    },
  });

  const track = await randomCommand();

  if (parsed.values.json) {
    printJson({
      ok: true,
      track,
    });
    return;
  }

  const { trackDetailLines } = await import("./format");
  console.log(trackDetailLines(track).join("\n"));

  if (track.note) {
    console.log(`Note: ${track.note}`);
  }

  console.log(track.spotifyUrl);
}

async function runSubscribe(
  args: string[],
  subscribeCommand: typeof import("./commands/subscribe").subscribeCommand,
): Promise<void> {
  const parsed = parseArgs({
    allowPositionals: true,
    args,
    options: {
      json: {
        default: false,
        type: "boolean",
      },
    },
  });

  const [email, extra] = parsed.positionals;

  if (extra) {
    throw new Error(`Unknown subscribe arguments: ${parsed.positionals.join(" ")}`);
  }

  await subscribeCommand(email, parsed.values.json);
}

async function runVersion(
  args: string[],
  versionCommand: typeof import("./version").versionCommand,
): Promise<void> {
  const parsed = parseArgs({
    allowPositionals: false,
    args,
    options: {
      check: {
        default: false,
        type: "boolean",
      },
      json: {
        default: false,
        type: "boolean",
      },
    },
  });

  await versionCommand({
    check: parsed.values.check,
    json: parsed.values.json,
  });
}

function printHelp(): void {
  console.log(`fluncle — drum & bass bangers from another dimension

Global options:
  --env <local|production>   Config profile to load (default: production)

Listen:
  fluncle recent [--limit 10] [--json]          The latest bangers, newest first
  fluncle list [--limit 10] [--json]            Alias for recent
  fluncle open [--limit 20] [--browser|--app]   Pick a track, open it in Spotify
  fluncle open playlist [--browser|--app]       Open Fluncle's Findings in Spotify
  fluncle open telegram [--browser|--app]       Open the Telegram feed
  fluncle random [--json]                       The archive throws one back
  fluncle subscribe [email]                     Fresh bangers, every Friday

Share:
  fluncle submit [search-or-spotify-url]   Send a track for review

Meta:
  fluncle version [--check] [--json]   Print or check the version

Operator:
  fluncle admin add <spotify-url> [--note "text"] [--dry-run] [--json]
  fluncle track get <track-id|log-id> [--json]      Look up one finding by id or Log ID
  fluncle admin track update <track-id> [--tag t]... [--tag-source auto|manual] [--bpm n] [--key "k"] [--video-url u] [--features json] [--status s] [--note "text"] [--json]
      Certify a track into the archive
  fluncle admin track video <track-id|log-id> (--dir <dir> | --footage <f> [--footage-silent <f>] [--poster <f>] [--note <f>] [--composition <f>] [--props <f>] [--render <f>]) [--json]
      Upload a track's video bundle to R2 and link it
  fluncle admin track draft <track-id|log-id> [--platform tiktok] [--json]
      Push the video to a platform as a draft (TikTok inbox via Postiz)
  fluncle admin track social <track-id|log-id> [--platform tiktok] [--status scheduled|published [--url u]] [--json]
      Show or update a track's per-platform publication status
  fluncle admin submissions                          List pending submissions
  fluncle admin submissions review <submission-id>   Inspect one submission
  fluncle admin submissions reject <submission-id>   Reject a submission
  fluncle admin submissions approve <submission-id>  Approve a submission
  fluncle admin auth spotify                         Authorize Spotify access`);
}

function parseGlobalOptions(args: string[]): GlobalOptions {
  const cleanedArgs: string[] = [];
  let envProfile: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--env") {
      envProfile = args[index + 1];

      if (!envProfile) {
        throw new Error("Missing value for --env");
      }

      index += 1;
      continue;
    }

    if (arg.startsWith("--env=")) {
      envProfile = arg.slice("--env=".length);
      continue;
    }

    cleanedArgs.push(arg);
  }

  return {
    args: cleanedArgs,
    envProfile,
  };
}

main().catch((error) => {
  if (process.argv.includes("--json")) {
    printJson(toJsonFailure(error));
  } else {
    console.error(formatError(error));
  }
  process.exit(1);
});
