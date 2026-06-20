#!/usr/bin/env bun

import { existsSync } from "node:fs";
import path from "node:path";
import { Command, CommanderError } from "commander";
import { fluncleAsciiLogo, fluncleTagline } from "./brand";
import { setEnvProfile } from "./env";
import { spotifyPlaylistUrl, telegramUrl } from "./links";
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
  limit?: string;
};

type AdminListOptions = {
  json: boolean;
  limit?: string;
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
  model?: string;
  note?: string;
  poster?: string;
  props?: string;
  reasoning?: string;
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

type MixtapeCreateOptions = {
  durationMs?: string;
  json: boolean;
  mixcloudUrl?: string;
  note?: string;
  recordedAt?: string;
  soundcloudUrl?: string;
  youtubeUrl?: string;
};

type MixtapeUpdateOptions = {
  durationMs?: string;
  json: boolean;
  mixcloudUrl?: string;
  note?: string;
  recordedAt?: string;
  soundcloudUrl?: string;
  youtubeUrl?: string;
};

type MixtapeMembersOptions = {
  from?: string;
  json: boolean;
};

type MixtapeDeleteOptions = {
  json: boolean;
  yes: boolean;
};

type MixtapeDistributeOptions = {
  audio?: string;
  json: boolean;
  mixcloud?: boolean;
  unlisted?: boolean;
  video?: string;
  youtube?: boolean;
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
    .option("--limit <limit>", "Number of tracks to fetch")
    .option("--json", "Print JSON", false)
    .action(async (options: RecentOptions) => {
      const { recentCommand } = await import("./commands/recent");
      await runRecent(options, recentCommand);
    });

  program
    .command("mixtapes")
    .description("Fluncle's checkpoint sets")
    .option("--json", "Print JSON", false)
    .action(async (options: JsonOptions) => {
      const { mixtapesCommand } = await import("./commands/mixtapes");
      await runMixtapes(options, mixtapesCommand);
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
    .command("about")
    .description("Fluncle, and where to find him")
    .action(async () => {
      const { aboutCommand } = await import("./commands/about");
      aboutCommand();
    });

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

  admin
    .command("queue")
    .description("Findings awaiting a video, oldest first (the next to film is first)")
    .option("--limit <limit>", "Number of findings to show", "10")
    .option("--json", "Print JSON", false)
    .action(async (options: AdminListOptions) => {
      const { queueCommand } = await import("./commands/admin-tracks");
      await runAdminQueue(options, queueCommand);
    });

  admin
    .command("vehicles")
    .description("Recent video vehicles, newest first (the style ledger for diversity)")
    .option("--limit <limit>", "Number of vehicles to show", "10")
    .option("--json", "Print JSON", false)
    .action(async (options: AdminListOptions) => {
      const { vehiclesCommand } = await import("./commands/admin-tracks");
      await runAdminVehicles(options, vehiclesCommand);
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
    .option("--model <model>", "Authoring AI model (<provider>/<model>)")
    .option("--note <file>", "Note file")
    .option("--poster <file>", "Poster image")
    .option("--props <file>", "Render props JSON")
    .option("--reasoning <level>", "Authoring model reasoning effort (e.g. high)")
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

  const adminMixtapes = configureCommand(
    admin.command("mixtapes").description("Mixtape admin commands"),
  );

  adminMixtapes.action(() => {
    adminMixtapes.outputHelp();
  });

  adminMixtapes
    .command("create")
    .description("Log a new mixtape draft")
    .option("--duration-ms <duration>", "Duration (mm:ss, h:mm:ss, or ms)")
    .option("--json", "Print JSON", false)
    .option("--mixcloud-url <url>", "Mixcloud URL")
    .option("--note <text>", "Operator note")
    .option("--recorded-at <date>", "Recorded date (ISO)")
    .option("--soundcloud-url <url>", "SoundCloud URL")
    .option("--youtube-url <url>", "YouTube URL")
    .allowExcessArguments()
    .action(async (options: MixtapeCreateOptions) => {
      const { mixtapeCreateCommand } = await import("./commands/mixtapes");
      await runMixtapeCreate(options, mixtapeCreateCommand);
    });

  adminMixtapes
    .command("update")
    .description("Update a mixtape's fields")
    .argument("[id]")
    .option("--duration-ms <duration>", "Duration (mm:ss, h:mm:ss, or ms)")
    .option("--json", "Print JSON", false)
    .option("--mixcloud-url <url>", "Mixcloud URL")
    .option("--note <text>", "Operator note")
    .option("--recorded-at <date>", "Recorded date (ISO)")
    .option("--soundcloud-url <url>", "SoundCloud URL")
    .option("--youtube-url <url>", "YouTube URL")
    .allowExcessArguments()
    .action(async (id: string | undefined, options: MixtapeUpdateOptions) => {
      const { mixtapeUpdateCommand } = await import("./commands/mixtapes");
      await runMixtapeUpdate(id, options, mixtapeUpdateCommand);
    });

  adminMixtapes
    .command("members")
    .description("Set a mixtape's tracklist (refs and/or a cue-sheet file)")
    .argument("[id]")
    .argument("[refs...]")
    .option("--from <file>", "Cue-sheet or JSON file with members")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (id: string | undefined, refs: string[], options: MixtapeMembersOptions) => {
      const { mixtapeMembersCommand } = await import("./commands/mixtapes");
      await runMixtapeMembers(id, refs, options, mixtapeMembersCommand);
    });

  adminMixtapes
    .command("publish")
    .description("Publish a mixtape draft")
    .argument("[id]")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (id: string | undefined, options: { json: boolean }) => {
      const { mixtapePublishCommand } = await import("./commands/mixtapes");
      await runMixtapePublish(id, options, mixtapePublishCommand);
    });

  adminMixtapes
    .command("delete")
    .description("Discard a mixtape draft (published mixtapes can't be deleted)")
    .argument("[id]")
    .option("--json", "Print JSON", false)
    .option("--yes", "Skip confirmation", false)
    .allowExcessArguments()
    .action(async (id: string | undefined, options: MixtapeDeleteOptions) => {
      const { mixtapeDeleteCommand } = await import("./commands/mixtapes");
      await runMixtapeDelete(id, options, mixtapeDeleteCommand);
    });

  adminMixtapes
    .command("list")
    .description("List all mixtapes (including drafts)")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (options: { json: boolean }) => {
      const { mixtapeListCommand } = await import("./commands/mixtapes");
      await runMixtapeList(options, mixtapeListCommand);
    });

  adminMixtapes
    .command("get")
    .description("Show one mixtape by id or log id")
    .argument("[idOrLogId]")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (idOrLogId: string | undefined, options: { json: boolean }) => {
      const { mixtapeGetCommand } = await import("./commands/mixtapes");
      await runMixtapeGet(idOrLogId, options, mixtapeGetCommand);
    });

  adminMixtapes
    .command("distribute")
    .description("Mint + push a mixtape to YouTube (video) and Mixcloud (audio)")
    .argument("[idOrLogId]")
    .option("--video <file>", "Video file for YouTube")
    .option("--audio <file>", "Audio file for Mixcloud")
    .option("--youtube", "Only distribute to YouTube")
    .option("--mixcloud", "Only distribute to Mixcloud")
    .option(
      "--unlisted",
      "Keep Mixcloud private too (YouTube is always unlisted until publish-youtube)",
    )
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (idOrLogId: string | undefined, options: MixtapeDistributeOptions) => {
      const { mixtapeDistributeCommand } = await import("./commands/mixtapes");
      await runMixtapeDistribute(idOrLogId, options, mixtapeDistributeCommand);
    });

  adminMixtapes
    .command("publish-youtube")
    .description("Flip a distributed mixtape's YouTube video from unlisted to public")
    .argument("[idOrLogId]")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (idOrLogId: string | undefined, options: { json: boolean }) => {
      const { publishYoutubeCommand } = await import("./commands/mixtape-youtube");
      await runMixtapePublishYoutube(idOrLogId, options, publishYoutubeCommand);
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

  auth
    .command("youtube")
    .description("Authorize YouTube access (mixtape video distribution)")
    .action(async () => {
      const { authYoutubeCommand } = await import("./commands/mixtape-youtube");
      await authYoutubeCommand();
    });

  auth
    .command("mixcloud")
    .description("Authorize Mixcloud access (mixtape audio distribution)")
    .action(async () => {
      const { authMixcloudCommand } = await import("./commands/mixtape-mixcloud");
      await authMixcloudCommand();
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
  // Resolve against process.cwd() up front so a relative --dir (e.g. out/<id>)
  // becomes an absolute path — Bun.file then never depends on the cwd at PUT time.
  const dir = options.dir ? path.resolve(process.cwd(), options.dir) : undefined;
  const fromDir = (name: string): string | undefined => {
    if (!dir) {
      return undefined;
    }

    const candidate = path.join(dir, name);

    return existsSync(candidate) ? candidate : undefined;
  };

  const resolveFile = (explicit: string | undefined, name: string): string | undefined => {
    if (explicit) {
      return path.resolve(process.cwd(), explicit);
    }

    return fromDir(name);
  };

  const files = {
    composition: resolveFile(options.composition, "composition.tsx"),
    cover: resolveFile(options.cover, "cover.jpg"),
    footage: resolveFile(options.footage, "footage.mp4"),
    footageSilent: resolveFile(options.footageSilent, "footage-silent.mp4"),
    model: options.model,
    note: resolveFile(options.note, "note.txt"),
    poster: resolveFile(options.poster, "poster.jpg"),
    props: resolveFile(options.props, "props.json"),
    reasoning: options.reasoning,
    render: resolveFile(options.render, "render.json"),
  };

  if (!files.footage) {
    throw new Error(
      "A footage cut is required (--footage <file>, or --dir containing footage.mp4)",
    );
  }

  // Progress per file as the bytes go straight to R2 (suppressed under --json so
  // the output stays a single parseable object).
  const onProgress = options.json ? undefined : (message: string) => console.log(message);
  const result = await trackVideoCommand(idOrLogId, files, onProgress);

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

  if ("mixtape" in result) {
    const mixtape = result.mixtape;
    console.log(`${mixtape.logId ? `${mixtape.logId}  ` : ""}${mixtape.title}`);
    console.log(
      [
        `${mixtape.memberCount} ${mixtape.memberCount === 1 ? "banger" : "bangers"}`,
        mixtape.durationMs ? `${Math.round(mixtape.durationMs / 60_000)} min` : undefined,
        mixtape.externalUrls.mixcloud ??
          mixtape.externalUrls.youtube ??
          mixtape.externalUrls.soundcloud,
      ]
        .filter(Boolean)
        .join(" · "),
    );
    return;
  }

  const t = result.track;

  console.log(`${t.logId ? `${t.logId}  ` : ""}${t.artists.join(", ")} — ${t.title}`);
  console.log(
    [t.bpm ? `${t.bpm} bpm` : undefined, t.key, t.label, t.enrichmentStatus]
      .filter(Boolean)
      .join(" · "),
  );

  if (t.logPageUrl) {
    console.log(`Log: ${t.logPageUrl}`);
  }
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

async function runMixtapeCreate(
  options: MixtapeCreateOptions,
  mixtapeCreateCommand: typeof import("./commands/mixtapes").mixtapeCreateCommand,
): Promise<void> {
  const result = await mixtapeCreateCommand(options);

  if (options.json) {
    printJson(result);
    return;
  }

  console.log(`Logged draft ${result.mixtape.id}. It stays a draft until you publish it.`);
}

async function runMixtapeUpdate(
  id: string | undefined,
  options: MixtapeUpdateOptions,
  mixtapeUpdateCommand: typeof import("./commands/mixtapes").mixtapeUpdateCommand,
): Promise<void> {
  if (!id) {
    throw new Error("Missing mixtape id. Usage: fluncle admin mixtapes update <id>");
  }

  const result = await mixtapeUpdateCommand(id, options);

  if (options.json) {
    printJson(result);
    return;
  }

  console.log(`Saved ${result.mixtape.id}.`);
}

async function runMixtapeMembers(
  id: string | undefined,
  refs: string[],
  options: MixtapeMembersOptions,
  mixtapeMembersCommand: typeof import("./commands/mixtapes").mixtapeMembersCommand,
): Promise<void> {
  if (!id) {
    throw new Error("Missing mixtape id. Usage: fluncle admin mixtapes members <id> [refs...]");
  }

  if (refs.length === 0 && !options.from) {
    throw new Error("Provide refs as arguments or a cue-sheet file with --from");
  }

  const result = await mixtapeMembersCommand(id, refs, options);

  if (options.json) {
    printJson(result);
    return;
  }

  console.log(
    `Saved the tracklist: ${result.mixtape.memberCount} bangers on ${result.mixtape.id}.`,
  );
}

async function runMixtapePublish(
  id: string | undefined,
  options: { json: boolean },
  mixtapePublishCommand: typeof import("./commands/mixtapes").mixtapePublishCommand,
): Promise<void> {
  if (!id) {
    throw new Error("Missing mixtape id. Usage: fluncle admin mixtapes publish <id>");
  }

  const result = await mixtapePublishCommand(id);

  if (options.json) {
    printJson(result);
    return;
  }

  console.log(
    `Minted ${result.mixtape.logId} (fluncle://${result.mixtape.logId}) — distributing. ` +
      "Run `distribute` to push it to the platforms.",
  );
}

async function runMixtapeDistribute(
  idOrLogId: string | undefined,
  options: MixtapeDistributeOptions,
  mixtapeDistributeCommand: typeof import("./commands/mixtapes").mixtapeDistributeCommand,
): Promise<void> {
  if (!idOrLogId) {
    throw new Error(
      "Missing mixtape id. Usage: fluncle admin mixtapes distribute <idOrLogId> --video <mp4> --audio <file>",
    );
  }

  const onProgress = options.json ? () => {} : (message: string) => console.log(message);
  const result = await mixtapeDistributeCommand(idOrLogId, options, onProgress);

  if (options.json) {
    printJson(result);
    return;
  }

  const links = result.results.map((r) => `  ${r.platform}: ${r.url}`).join("\n");
  console.log(`Distributed ${result.logId} (fluncle://${result.logId}).\n${links}`);
}

async function runMixtapePublishYoutube(
  idOrLogId: string | undefined,
  options: { json: boolean },
  publishYoutubeCommand: typeof import("./commands/mixtape-youtube").publishYoutubeCommand,
): Promise<void> {
  if (!idOrLogId) {
    throw new Error(
      "Missing mixtape id. Usage: fluncle admin mixtapes publish-youtube <idOrLogId>",
    );
  }

  const result = await publishYoutubeCommand(idOrLogId);

  if (options.json) {
    printJson(result);
    return;
  }

  console.log(`YouTube video is now public: ${result.url}`);
}

async function runMixtapeDelete(
  id: string | undefined,
  options: MixtapeDeleteOptions,
  mixtapeDeleteCommand: typeof import("./commands/mixtapes").mixtapeDeleteCommand,
): Promise<void> {
  if (!id) {
    throw new Error("Missing mixtape id. Usage: fluncle admin mixtapes delete <id> --yes");
  }

  if (!options.yes) {
    throw new Error("Pass --yes to confirm the discard. Published mixtapes can't be deleted.");
  }

  await mixtapeDeleteCommand(id);

  if (options.json) {
    printJson({ id, ok: true });
    return;
  }

  console.log(`Discarded draft ${id}.`);
}

async function runMixtapeList(
  options: { json: boolean },
  mixtapeListCommand: typeof import("./commands/mixtapes").mixtapeListCommand,
): Promise<void> {
  const mixtapes = await mixtapeListCommand();

  if (options.json) {
    printJson({ mixtapes, ok: true });
    return;
  }

  if (mixtapes.length === 0) {
    console.log("No mixtapes yet.");
    return;
  }

  for (const mixtape of mixtapes) {
    const status = mixtape.status ?? "draft";
    const coordinate = mixtape.logId ?? "draft";
    console.log(`${coordinate}\t${status}\t${mixtape.memberCount} bangers\t${mixtape.title}`);
  }
}

async function runMixtapeGet(
  idOrLogId: string | undefined,
  options: { json: boolean },
  mixtapeGetCommand: typeof import("./commands/mixtapes").mixtapeGetCommand,
): Promise<void> {
  if (!idOrLogId) {
    throw new Error("Missing mixtape id or log id. Usage: fluncle admin mixtapes get <id|logId>");
  }

  const mixtape = await mixtapeGetCommand(idOrLogId);

  if (options.json) {
    printJson(mixtape);
    return;
  }

  const coordinate = mixtape.logId ?? "draft";
  const status = mixtape.status ?? "draft";
  console.log(`${mixtape.title}`);
  console.log(`  ${coordinate} · ${status} · ${mixtape.memberCount} bangers`);
  if (mixtape.note) {
    console.log(`  ${mixtape.note}`);
  }
  if (mixtape.members.length > 0) {
    console.log("  Tracklist:");
    for (const member of mixtape.members) {
      const cue = member.startMs !== undefined ? formatCue(member.startMs) + "  " : "";
      console.log(
        `    ${cue}${member.logId ?? member.trackId}\t${member.artists.join(", ")} — ${member.title}`,
      );
    }
  }
}

function formatCue(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
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
  // Bare `recent` in a terminal is an interactive ←/→ pager (10 at a time).
  // `--json`, an explicit `--limit`, or a non-TTY (piped) fall through to a plain
  // newest-first print, so every scripted consumer is untouched.
  if (
    options.limit === undefined &&
    !options.json &&
    process.stdout.isTTY === true &&
    process.stdin.isTTY === true
  ) {
    const { fetchRecentPage } = await import("./commands/recent");
    const { paginateWithKeyboard } = await import("./interactive");
    const { trackRows } = await import("./format");

    await paginateWithKeyboard({
      emptyMessage: "No findings logged yet.",
      fetchPage: async (cursor) => {
        const page = await fetchRecentPage(cursor, 10);

        return {
          lines: trackRows(page.tracks),
          nextCursor: page.nextCursor,
          total: page.totalCount,
        };
      },
      nonInteractiveMessage: "recent needs an interactive terminal; use --json or --limit",
    });
    return;
  }

  const limit = parseListLimit(options.limit);
  const tracks = await recentCommand(limit);

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

async function runMixtapes(
  options: JsonOptions,
  mixtapesCommand: typeof import("./commands/mixtapes").mixtapesCommand,
): Promise<void> {
  const mixtapes = await mixtapesCommand();

  if (options.json) {
    printJson({ mixtapes, ok: true });
    return;
  }

  if (mixtapes.length === 0) {
    console.log("No mixtapes logged yet.");
    return;
  }

  const { trackRows } = await import("./format");
  console.log(trackRows(mixtapes).join("\n"));
}

// Shared limit parse for the listing commands (recent, admin queue, admin
// vehicles): 1-100, default 10. Throws a CLI-friendly error before any fetch.
function parseListLimit(value: string | undefined): number {
  const limit = Number.parseInt(value ?? "10", 10);

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Limit must be an integer between 1 and 100");
  }

  return limit;
}

async function runAdminQueue(
  options: AdminListOptions,
  queueCommand: typeof import("./commands/admin-tracks").queueCommand,
): Promise<void> {
  const limit = parseListLimit(options.limit);
  const tracks = await queueCommand(limit);

  if (options.json) {
    printJson({
      ok: true,
      tracks,
    });
    return;
  }

  if (tracks.length === 0) {
    console.log("Every finding has a video. Nothing in the render queue.");
    return;
  }

  const { trackRows } = await import("./format");
  const noun = tracks.length === 1 ? "finding" : "findings";
  console.log(`${tracks.length} ${noun} awaiting a video, oldest first:`);
  console.log(trackRows(tracks).join("\n"));
}

async function runAdminVehicles(
  options: AdminListOptions,
  vehiclesCommand: typeof import("./commands/admin-tracks").vehiclesCommand,
): Promise<void> {
  const limit = parseListLimit(options.limit);
  const vehicles = await vehiclesCommand(limit);

  if (options.json) {
    printJson({
      ok: true,
      vehicles,
    });
    return;
  }

  if (vehicles.length === 0) {
    console.log("No videos rendered yet.");
    return;
  }

  const { vehicleRows } = await import("./format");
  console.log("Recent video vehicles, newest first:");
  console.log(vehicleRows(vehicles).join("\n"));
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

  console.log(`Spotify: ${track.spotifyUrl}`);
  if (track.logPageUrl) {
    console.log(`Log: ${track.logPageUrl}`);
  }
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
    (command === "recent" ||
      command === "list" ||
      command === "random" ||
      command === "version" ||
      command === "about") &&
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
  "--duration-ms",
  "--features",
  "--file",
  "--footage",
  "--footage-silent",
  "--from",
  "--key",
  "--limit",
  "--mime",
  "--mixcloud-url",
  "--note",
  "--platform",
  "--poster",
  "--props",
  "--recorded-at",
  "--render",
  "--scheduled-for",
  "--soundcloud-url",
  "--source",
  "--status",
  "--url",
  "--video-url",
  "--youtube-url",
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
  fluncle about                        Fluncle, and where to find him
  fluncle version [--check] [--json]   Print or check the version

Fluncle elsewhere:
  Web        https://www.fluncle.com
  Spotify    ${spotifyPlaylistUrl}
  TikTok     https://www.tiktok.com/@fluncle
  Telegram   ${telegramUrl}
  More       fluncle about`;

if (import.meta.main) {
  await main();
}
