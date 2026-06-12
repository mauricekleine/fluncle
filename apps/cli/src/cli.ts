#!/usr/bin/env bun

import { existsSync } from "node:fs";
import path from "node:path";
import { Command, CommanderError } from "commander";
import { fluncleAsciiLogo, fluncleTagline } from "./brand";
import { setEnvProfile } from "./env";
import { printJson, toJsonFailure } from "./output";
import { formatError } from "./retry";

type GlobalOptions = {
  env?: string;
};

type AddOptions = {
  dryRun: boolean;
  json: boolean;
  note?: string;
};

type RecentOptions = {
  json: boolean;
  limit: string;
  needsVideo: boolean;
};

type OpenOptions = {
  app: boolean;
  browser: boolean;
  limit: string;
};

type JsonOptions = {
  json: boolean;
};

type SubscribeOptions = JsonOptions;

type VersionOptions = {
  check: boolean;
  json: boolean;
};

type TrackUpdateOptions = {
  bpm?: string;
  features?: string;
  json: boolean;
  key?: string;
  note?: string;
  status?: string;
  videoUrl?: string;
};

type TrackVideoOptions = {
  composition?: string;
  cover?: string;
  dir?: string;
  footage?: string;
  footageSilent?: string;
  json: boolean;
  note?: string;
  poster?: string;
  props?: string;
  render?: string;
};

type TrackDraftOptions = {
  json: boolean;
  platform?: string;
};

type TrackSocialOptions = {
  json: boolean;
  platform?: string;
  scheduledFor?: string;
  status?: string;
  url?: string;
};

type TrackPreviewArchiveOptions = {
  file?: string;
  json: boolean;
  mime?: string;
  source?: string;
};

type PreviewArchiveBackfillOptions = {
  dryRun: boolean;
  json: boolean;
  limit?: string;
};

export function createProgram(): Command {
  const program = configureCommand(new Command());

  program
    .name("fluncle")
    .description(fluncleTagline.toLowerCase())
    .option("--env <local|production>", "Config profile to load (default: production)")
    .showSuggestionAfterError(false)
    .addHelpCommand("help [command]", "display help for command")
    .hook("preAction", (_thisCommand, actionCommand) => {
      const options = actionCommand.optsWithGlobals() as GlobalOptions;
      setEnvProfile(options.env);
    })
    .addHelpText("before", `\n${fluncleAsciiLogo}\n`)
    .addHelpText("after", rootHelpSections);

  addListenCommands(program);
  addShareCommands(program);
  addMetaCommands(program);
  addTrackCommands(program);
  addAdminCommands(program);

  return program;
}

async function main(args = process.argv.slice(2)): Promise<void> {
  const program = createProgram();

  if (args.length === 0) {
    program.outputHelp();
    return;
  }

  try {
    assertParseArgsCompatiblePositionals(args);
    assertParseArgsCompatibleOptionValues(args);
    await program.parseAsync(args, { from: "user" });
  } catch (error) {
    if (isHelpDisplayed(error)) {
      return;
    }

    const normalized = normalizeCommanderError(error);

    if (process.argv.includes("--json") || args.includes("--json")) {
      printJson(toJsonFailure(normalized));
    } else {
      console.error(formatError(normalized));
    }

    process.exit(1);
  }
}

function configureCommand(command: Command): Command {
  return command
    .exitOverride()
    .addHelpCommand(false)
    .configureOutput({
      writeErr: () => {},
    });
}

function addListenCommands(program: Command): void {
  program
    .command("recent")
    .alias("list")
    .description("The latest bangers, newest first")
    .option("--limit <limit>", "Number of tracks to fetch", "10")
    .option("--json", "Print JSON", false)
    .option("--needs-video", "Only findings that do not have a rendered video yet", false)
    .action(async (options: RecentOptions) => {
      const { recentCommand } = await import("./commands/recent");
      await runRecent(options, recentCommand);
    });

  program
    .command("open")
    .description("Pick a track, open it in Spotify")
    .argument("[target]")
    .option("--app", "Open in the native app", false)
    .option("--browser", "Open in the browser", false)
    .option("--limit <limit>", "Number of recent tracks to choose from", "20")
    .allowExcessArguments()
    .action(async (target: string | undefined, options: OpenOptions) => {
      const openCommands = await import("./commands/open");
      await runOpen(target, [], options, openCommands);
    });

  program
    .command("random")
    .description("The archive throws one back")
    .option("--json", "Print JSON", false)
    .action(async (options: JsonOptions) => {
      const { randomCommand } = await import("./commands/random");
      await runRandom(options, randomCommand);
    });

  program
    .command("subscribe")
    .description("Fresh bangers, every Friday")
    .argument("[email]")
    .option("--json", "Print JSON", false)
    .action(async (email: string | undefined, options: SubscribeOptions) => {
      const { subscribeCommand } = await import("./commands/subscribe");
      await subscribeCommand(email, options.json);
    });
}

function addShareCommands(program: Command): void {
  program
    .command("submit")
    .description("Send a track for review")
    .argument("[searchOrSpotifyUrl...]")
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (input: string[]) => {
      const { submitCommand } = await import("./commands/submit");
      await submitCommand(input.join(" ") || undefined);
    });
}

function addMetaCommands(program: Command): void {
  program
    .command("version")
    .description("Print or check the version")
    .option("--check", "Check the latest GitHub release", false)
    .option("--json", "Print JSON", false)
    .action(async (options: VersionOptions) => {
      const { versionCommand } = await import("./version");
      await versionCommand({
        check: options.check,
        json: options.json,
      });
    });
}

function addTrackCommands(program: Command): void {
  const track = configureCommand(
    program.command("track", { hidden: true }).description("Public track lookups"),
  );

  track
    .command("get")
    .description("Look up one finding by id or Log ID")
    .argument("[idOrLogId]")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (idOrLogId: string | undefined, options: JsonOptions) => {
      const { trackGetCommand } = await import("./commands/track");
      await runTrackGet(idOrLogId, options, trackGetCommand);
    });
}

function addAdminCommands(program: Command): void {
  const admin = configureCommand(
    program.command("admin", { hidden: true }).description("Operator commands"),
  );

  admin.action(() => {
    admin.outputHelp();
  });

  admin
    .command("help", { hidden: true })
    .description("display help for command")
    .action(() => {
      admin.outputHelp();
    });

  admin
    .command("add")
    .description("Publish a Spotify track")
    .argument("[spotifyUrl]")
    .option("--note <text>", "Operator note")
    .option("--dry-run", "Preview without publishing", false)
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (spotifyUrl: string | undefined, options: AddOptions) => {
      const { addCommand } = await import("./commands/add");
      await runAdd(spotifyUrl, options, addCommand);
    });

  const adminTrack = configureCommand(admin.command("track").description("Track admin commands"));

  adminTrack.action(() => {
    adminTrack.outputHelp();
  });

  adminTrack
    .command("update")
    .description("Certify a track into the archive")
    .argument("[trackId]")
    .option("--bpm <number>", "Track BPM")
    .option("--features <json>", "Audio feature JSON")
    .option("--json", "Print JSON", false)
    .option("--key <key>", "Musical key")
    .option("--note <text>", "Operator note")
    .option("--status <status>", "Enrichment status")
    .option("--video-url <url>", "Rendered video URL")
    .allowExcessArguments()
    .action(async (trackId: string | undefined, options: TrackUpdateOptions) => {
      const { trackUpdateCommand } = await import("./commands/track");
      await runTrackUpdate(trackId, options, trackUpdateCommand);
    });

  adminTrack
    .command("video")
    .description("Upload a track's video bundle to R2 and link it")
    .argument("[idOrLogId]")
    .option("--composition <file>", "Composition source file")
    .option("--cover <file>", "Cover image")
    .option("--dir <dir>", "Bundle directory")
    .option("--footage <file>", "Video footage")
    .option("--footage-silent <file>", "Silent video footage")
    .option("--json", "Print JSON", false)
    .option("--note <file>", "Note file")
    .option("--poster <file>", "Poster image")
    .option("--props <file>", "Render props JSON")
    .option("--render <file>", "Render metadata JSON")
    .allowExcessArguments()
    .action(async (idOrLogId: string | undefined, options: TrackVideoOptions) => {
      const { trackVideoCommand } = await import("./commands/track");
      await runTrackVideo(idOrLogId, options, trackVideoCommand);
    });

  adminTrack
    .command("draft")
    .description("Push the video to a platform as a draft")
    .argument("[idOrLogId]")
    .option("--json", "Print JSON", false)
    .option("--platform <platform>", "Publishing platform")
    .allowExcessArguments()
    .action(async (idOrLogId: string | undefined, options: TrackDraftOptions) => {
      const { trackDraftCommand } = await import("./commands/track");
      await runTrackDraft(idOrLogId, options, trackDraftCommand);
    });

  adminTrack
    .command("social")
    .description("Show or update a track's per-platform publication status")
    .argument("[idOrLogId]")
    .option("--json", "Print JSON", false)
    .option("--platform <platform>", "Publishing platform")
    .option("--scheduled-for <date>", "Scheduled publication date")
    .option("--status <status>", "scheduled, published, or failed")
    .option("--url <url>", "Published post URL")
    .allowExcessArguments()
    .action(async (idOrLogId: string | undefined, options: TrackSocialOptions) => {
      const { trackSocialShowCommand, trackSocialUpdateCommand } = await import("./commands/track");
      await runTrackSocial(idOrLogId, options, trackSocialShowCommand, trackSocialUpdateCommand);
    });

  adminTrack
    .command("preview-archive")
    .description("Store one official preview at the operator-only archive path for analysis")
    .argument("[idOrLogId]")
    .option("--file <file>", "Preview audio file to archive")
    .option("--mime <mime>", "MIME type of the preview audio")
    .option("--source <source>", "Provenance label for the archived preview")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (idOrLogId: string | undefined, options: TrackPreviewArchiveOptions) => {
      const { previewArchiveUploadCommand } = await import("./commands/preview-archive");
      await runTrackPreviewArchive(idOrLogId, options, previewArchiveUploadCommand);
    });

  const submissions = configureCommand(
    admin.command("submissions").description("Review listener submissions"),
  );

  submissions.action(async () => {
    const { listSubmissionsCommand } = await import("./commands/submissions");
    await listSubmissionsCommand();
  });

  submissions
    .command("review")
    .description("Inspect one submission")
    .argument("[submissionId]")
    .action(async (submissionId: string | undefined) => {
      if (!submissionId) {
        throw new Error("Missing submission id for: review");
      }

      const { reviewSubmissionCommand } = await import("./commands/submissions");
      await reviewSubmissionCommand(submissionId);
    });

  submissions
    .command("reject")
    .description("Reject a submission")
    .argument("[submissionId]")
    .action(async (submissionId: string | undefined) => {
      if (!submissionId) {
        throw new Error("Missing submission id for: reject");
      }

      const { rejectSubmissionCommand } = await import("./commands/submissions");
      await rejectSubmissionCommand(submissionId);
    });

  submissions
    .command("approve")
    .description("Approve a submission")
    .argument("[submissionId]")
    .action(async (submissionId: string | undefined) => {
      if (!submissionId) {
        throw new Error("Missing submission id for: approve");
      }

      const { approveSubmissionCommand } = await import("./commands/submissions");
      await approveSubmissionCommand(submissionId);
    });

  const auth = configureCommand(admin.command("auth").description("Authentication commands"));

  auth
    .command("spotify")
    .description("Authorize Spotify access")
    .action(async () => {
      const { authSpotifyCommand } = await import("./commands/auth");
      await authSpotifyCommand();
    });

  const backfill = configureCommand(
    admin.command("backfill").description("Backfill operator-only archives"),
  );

  backfill.action(() => {
    backfill.outputHelp();
  });

  backfill
    .command("previews")
    .description("Archive missing official previews for analysis")
    .option("--dry-run", "Archive nothing; just report what would be archived", false)
    .option("--limit <limit>", "Maximum number of previews to archive")
    .option("--json", "Print JSON", false)
    .action(async (options: PreviewArchiveBackfillOptions) => {
      const { previewArchiveBackfillCommand } = await import("./commands/preview-archive");
      await runPreviewArchiveBackfill(options, previewArchiveBackfillCommand);
    });
}

async function runTrackPreviewArchive(
  idOrLogId: string | undefined,
  options: TrackPreviewArchiveOptions,
  previewArchiveUploadCommand: typeof import("./commands/preview-archive").previewArchiveUploadCommand,
): Promise<void> {
  if (!idOrLogId || !options.file || !options.source || !options.mime) {
    throw new Error(
      "Usage: fluncle admin track preview-archive <track_id|log_id> --file <file> --source <source> --mime <mime> [--json]",
    );
  }

  const result = await previewArchiveUploadCommand(idOrLogId, {
    file: options.file,
    mime: options.mime,
    source: options.source,
  });

  if (options.json) {
    printJson(result);
    return;
  }

  console.log(`Archived preview for ${result.logId}`);
  console.log(`  key: ${result.key}`);
  console.log(`  source: ${result.source}`);
  console.log(`  mime: ${result.mime}`);
}

async function runPreviewArchiveBackfill(
  options: PreviewArchiveBackfillOptions,
  previewArchiveBackfillCommand: typeof import("./commands/preview-archive").previewArchiveBackfillCommand,
): Promise<void> {
  const limit = options.limit === undefined ? undefined : Number.parseInt(options.limit, 10);

  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("Limit must be a positive integer");
  }

  const result = await previewArchiveBackfillCommand({
    dryRun: options.dryRun,
    limit,
  });

  if (options.json) {
    printJson({ ok: true, ...result });
    return;
  }

  const verb = result.dryRun ? "Would archive" : "Archived";
  console.log(`${verb} ${result.archived.length} preview(s).`);
  console.log(`Skipped ${result.skipped.length}; failed ${result.failed.length}.`);

  for (const item of result.archived) {
    console.log(`  ${item.logId}: ${item.source}`);
  }
}

async function runTrackVideo(
  idOrLogId: string | undefined,
  options: TrackVideoOptions,
  trackVideoCommand: typeof import("./commands/track").trackVideoCommand,
): Promise<void> {
  if (!idOrLogId) {
    throw new Error(
      "Missing id. Usage: fluncle admin track video <track_id|log_id> (--dir <dir> | --footage <file> [--footage-silent <file>] [--poster <file>] [--cover <file>] [--note <file>] [--composition <file>] [--props <file>] [--render <file>])",
    );
  }

  // --dir resolves the conventional bundle names; explicit flags override.
  const fromDir = (name: string): string | undefined => {
    if (!options.dir) {
      return undefined;
    }

    const candidate = path.join(options.dir, name);

    return existsSync(candidate) ? candidate : undefined;
  };

  const files = {
    composition: options.composition ?? fromDir("composition.tsx"),
    cover: options.cover ?? fromDir("cover.jpg"),
    footage: options.footage ?? fromDir("footage.mp4"),
    footageSilent: options.footageSilent ?? fromDir("footage-silent.mp4"),
    note: options.note ?? fromDir("note.txt"),
    poster: options.poster ?? fromDir("poster.jpg"),
    props: options.props ?? fromDir("props.json"),
    render: options.render ?? fromDir("render.json"),
  };

  if (!files.footage) {
    throw new Error(
      "A footage cut is required (--footage <file>, or --dir containing footage.mp4)",
    );
  }

  const result = await trackVideoCommand(idOrLogId, files);

  if (options.json) {
    printJson(result);
    return;
  }

  console.log(`Linked video to ${result.logId}`);

  for (const [field, url] of Object.entries(result.urls)) {
    console.log(`  ${field}: ${url}`);
  }
}

async function runTrackDraft(
  idOrLogId: string | undefined,
  options: TrackDraftOptions,
  trackDraftCommand: typeof import("./commands/track").trackDraftCommand,
): Promise<void> {
  if (!idOrLogId) {
    throw new Error(
      "Missing id. Usage: fluncle admin track draft <track_id|log_id> [--platform tiktok]",
    );
  }

  const platform = options.platform ?? "tiktok";
  const result = await trackDraftCommand(idOrLogId, platform);

  if (options.json) {
    printJson(result);
    return;
  }

  console.log(`Pushed ${platform} draft for ${result.trackId} (post ${result.externalId})`);
}

async function runTrackSocial(
  idOrLogId: string | undefined,
  options: TrackSocialOptions,
  trackSocialShowCommand: typeof import("./commands/track").trackSocialShowCommand,
  trackSocialUpdateCommand: typeof import("./commands/track").trackSocialUpdateCommand,
): Promise<void> {
  if (!idOrLogId) {
    throw new Error(
      "Missing id. Usage: fluncle admin track social <track_id|log_id> [--platform tiktok] [--status scheduled|published [--url <url>]]",
    );
  }

  // No --status: show the track's per-platform state.
  if (!options.status) {
    const result = await trackSocialShowCommand(idOrLogId);

    if (options.json) {
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

  if (
    options.status !== "scheduled" &&
    options.status !== "published" &&
    options.status !== "failed"
  ) {
    throw new Error(
      `Invalid --status: ${options.status} (expected scheduled, published, or failed)`,
    );
  }

  if (options.status === "published" && !options.url) {
    throw new Error("Publishing requires --url <post-url>");
  }

  const platform = options.platform ?? "tiktok";
  const result = await trackSocialUpdateCommand(idOrLogId, platform, {
    scheduledFor: options.scheduledFor,
    status: options.status,
    url: options.url,
  });

  if (options.json) {
    printJson(result);
    return;
  }

  console.log(`${platform} → ${options.status} for ${result.trackId}`);
}

async function runTrackGet(
  idOrLogId: string | undefined,
  options: JsonOptions,
  trackGetCommand: typeof import("./commands/track").trackGetCommand,
): Promise<void> {
  if (!idOrLogId) {
    throw new Error("Missing id. Usage: fluncle track get <track_id|log_id> [--json]");
  }

  const result = await trackGetCommand(idOrLogId);

  if (options.json) {
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
      t.enrichmentStatus,
    ]
      .filter(Boolean)
      .join(" · "),
  );
}

async function runTrackUpdate(
  trackId: string | undefined,
  options: TrackUpdateOptions,
  trackUpdateCommand: typeof import("./commands/track").trackUpdateCommand,
): Promise<void> {
  if (!trackId) {
    throw new Error("Missing track id. Usage: fluncle admin track update <track_id>");
  }

  const bpm = options.bpm === undefined ? undefined : Number(options.bpm);

  if (bpm !== undefined && !Number.isFinite(bpm)) {
    throw new Error(`Invalid --bpm: ${options.bpm}`);
  }

  const result = await trackUpdateCommand(trackId, {
    bpm,
    features: options.features,
    key: options.key,
    note: options.note,
    status: options.status,
    videoUrl: options.videoUrl,
  });

  if (options.json) {
    printJson(result);
    return;
  }

  console.log(`Updated ${result.trackId}: ${result.fields.join(", ")}`);
}

async function runAdd(
  spotifyUrl: string | undefined,
  options: AddOptions,
  addCommand: typeof import("./commands/add").addCommand,
): Promise<void> {
  if (!spotifyUrl) {
    throw new Error("Missing Spotify track URL");
  }

  const result = await addCommand(spotifyUrl, {
    dryRun: options.dryRun,
    json: options.json,
    note: options.note,
  });

  if (options.json) {
    printJson({
      ok: true,
      ...result,
    });
  }
}

async function runRecent(
  options: RecentOptions,
  recentCommand: typeof import("./commands/recent").recentCommand,
): Promise<void> {
  const limit = Number.parseInt(options.limit ?? "10", 10);

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Limit must be an integer between 1 and 100");
  }

  const fetched = await recentCommand(limit);
  // --needs-video: only findings that don't have a rendered video yet.
  const tracks = options.needsVideo ? fetched.filter((track) => !track.videoUrl) : fetched;

  if (options.json) {
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
  target: string | undefined,
  extra: string[],
  options: OpenOptions,
  openCommands: typeof import("./commands/open"),
): Promise<void> {
  if (options.app && options.browser) {
    throw new Error("Use either --app or --browser, not both");
  }

  const mode: import("./commands/open").OpenMode = options.browser
    ? "browser"
    : options.app
      ? "app"
      : "default";

  if (extra.length > 0) {
    throw new Error(`Unknown open target: ${[target, ...extra].filter(Boolean).join(" ")}`);
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

  const limit = Number.parseInt(options.limit ?? "20", 10);

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Limit must be an integer between 1 and 100");
  }

  await openCommands.openRecentCommand({
    limit,
    mode,
  });
}

async function runRandom(
  options: JsonOptions,
  randomCommand: typeof import("./commands/random").randomCommand,
): Promise<void> {
  const track = await randomCommand();

  if (options.json) {
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

function rejectUnexpectedPositionals(positionals: string[]): void {
  if (positionals.length === 0) {
    return;
  }

  throw new Error(
    `Unexpected argument '${positionals[0]}'. This command does not take positional arguments`,
  );
}

function assertParseArgsCompatiblePositionals(args: string[]): void {
  const positionals = positionalArgs(args);
  const [command, subcommand, third, fourth, fifth] = positionals;

  if (
    (command === "recent" || command === "list" || command === "random" || command === "version") &&
    subcommand
  ) {
    rejectUnexpectedPositionals([subcommand]);
    return;
  }

  if (command === "subscribe" && third) {
    throw new Error(`Unknown subscribe arguments: ${positionals.slice(1).join(" ")}`);
  }

  if (command === "open" && third) {
    throw new Error(`Unknown open target: ${positionals.slice(1).join(" ")}`);
  }

  if (command === "admin" && subcommand === "submissions") {
    if (fifth) {
      throw new Error(`Unknown submissions arguments: ${positionals.slice(2).join(" ")}`);
    }

    if (third && !fourth) {
      throw new Error(`Missing submission id for: ${third}`);
    }

    if (third && fourth && third !== "review" && third !== "reject" && third !== "approve") {
      throw new Error(`Unknown submissions command: ${third}`);
    }
  }
}

function assertParseArgsCompatibleOptionValues(args: string[]): void {
  if (topLevelCommand(args) === "submit") {
    return;
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--") {
      return;
    }

    if (arg === "--env") {
      if (args[index + 1] === undefined) {
        throw new Error("Missing value for --env");
      }

      index += 1;
      continue;
    }

    if (!stringOptions.has(arg) || arg.includes("=")) {
      continue;
    }

    const value = args[index + 1];

    if (value === undefined) {
      throw new Error(`Option '${arg} <value>' argument missing`);
    }

    if (value.startsWith("-")) {
      throw new Error(
        `Option '${arg}' argument is ambiguous.\nDid you forget to specify the option argument for '${arg}'?\nTo specify an option argument starting with a dash use '${arg}=-XYZ'.`,
      );
    }

    index += 1;
  }
}

function positionalArgs(args: string[]): string[] {
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--") {
      positionals.push(...args.slice(index + 1));
      return positionals;
    }

    if (arg === "--env") {
      index += 1;
      continue;
    }

    if (arg.startsWith("--env=")) {
      continue;
    }

    if (stringOptions.has(arg)) {
      index += 1;
      continue;
    }

    if (arg.includes("=") && stringOptions.has(arg.slice(0, arg.indexOf("=")))) {
      continue;
    }

    if (arg.startsWith("-")) {
      continue;
    }

    positionals.push(arg);
  }

  return positionals;
}

function topLevelCommand(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--env") {
      index += 1;
      continue;
    }

    if (arg.startsWith("--env=")) {
      continue;
    }

    if (!arg.startsWith("-")) {
      return arg;
    }
  }

  return undefined;
}

function isHelpDisplayed(error: unknown): boolean {
  return (
    error instanceof CommanderError &&
    (error.code === "commander.helpDisplayed" || error.code === "commander.help")
  );
}

function normalizeCommanderError(error: unknown): unknown {
  if (!(error instanceof CommanderError)) {
    return error;
  }

  let message = error.message.startsWith("error: ") ? error.message.slice(7) : error.message;

  if (message.startsWith("unknown option ")) {
    message = `Unknown option ${message.slice("unknown option ".length)}`;
  }

  return new Error(message);
}

const stringOptions = new Set([
  "--bpm",
  "--composition",
  "--cover",
  "--dir",
  "--features",
  "--file",
  "--footage",
  "--footage-silent",
  "--key",
  "--limit",
  "--mime",
  "--note",
  "--platform",
  "--poster",
  "--props",
  "--render",
  "--scheduled-for",
  "--source",
  "--status",
  "--url",
  "--video-url",
]);

const rootHelpSections = `

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
  fluncle version [--check] [--json]   Print or check the version`;

if (import.meta.main) {
  await main();
}
