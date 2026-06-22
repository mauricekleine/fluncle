#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
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

type AdminQueueOptions = AdminListOptions & {
  hasContext?: boolean;
  hasObservation?: boolean;
};

// A verb whose worklist is a `--queue` view flag (`tracks enrich|observe|context
// --queue`): the worklist runners read `json`/`limit` off it (AdminListOptions).
type AdminQueueViewOptions = AdminListOptions & {
  queue?: boolean;
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
  footageSocial?: string;
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

type TrackObserveOptions = {
  contextNote?: string;
  durationMs?: string;
  durationTargetSec?: string;
  json: boolean;
  limit?: string;
  model?: string;
  queue?: boolean;
  script?: string;
  scriptFile?: string;
  voiceId?: string;
};

type TrackContextOptions = {
  json: boolean;
  limit?: string;
  query?: string;
  queue?: boolean;
};

type PreviewArchiveBackfillOptions = {
  dryRun: boolean;
  json: boolean;
  limit?: string;
};

type BackfillSyncOptions = {
  dryRun: boolean;
  json: boolean;
  limit?: string;
};

type MixtapeCreateOptions = {
  durationMs?: string;
  json: boolean;
  note?: string;
  recordedAt?: string;
  soundcloudUrl?: string;
};

type MixtapeUpdateOptions = {
  durationMs?: string;
  json: boolean;
  note?: string;
  recordedAt?: string;
  soundcloudUrl?: string;
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

type NewsletterDraftOptions = {
  contentFile?: string;
  json: boolean;
  subject?: string;
  windowSince?: string;
  windowUntil?: string;
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

  // Fire-and-forget update hint, printed to stderr AFTER the command's output.
  // It can never throw, change the exit code, or touch stdout (see
  // update-notifier.ts). Reached only on success — failed commands skip it.
  const { notifyIfUpdateAvailable } = await import("./update-notifier");
  await notifyIfUpdateAvailable(args);
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
  // Convention B (docs/naming-conventions.md §6.3): public CLI groups are PLURAL.
  // The canonical public lookup group is `tracks`; the old singular `track` is kept
  // as a hidden alias so `track get <id>` still resolves (mirrors the admin
  // `tracks`-alias-`track` pattern).
  const tracks = configureCommand(
    program.command("tracks", { hidden: true }).alias("track").description("Public track lookups"),
  );

  tracks
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

  // Convention B (docs/naming-conventions.md §4): the admin CLI is `group
  // noun-verb` with PLURAL groups. The canonical track group is `tracks`; the old
  // singular `track` group is kept as a hidden alias so `admin track <cmd>` still
  // resolves. The formerly-flat `admin add|queue|vehicles` commands move under
  // `tracks` (canonical) and stay registered as hidden flat commands (back-compat
  // for crons + muscle memory). A verb's worklist is a `--queue` view flag on the
  // verb itself (`tracks enrich --queue`, `tracks observe --queue`, `tracks
  // context --queue`), not a dash-compound command (§6.4) — the box `fluncle-enrich`
  // cron reads `tracks enrich --queue` to drain the queue (the Worker no longer
  // re-fires enrichment itself).
  const adminTracks = configureCommand(
    admin.command("tracks").alias("track").description("Track admin commands"),
  );

  adminTracks.action(() => {
    adminTracks.outputHelp();
  });

  // `add_track` → `admin tracks publish` (canonical). Hidden flat `admin add` alias.
  adminTracks
    .command("publish")
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
    .command("add", { hidden: true })
    .description("Publish a Spotify track (alias of `admin tracks publish`)")
    .argument("[spotifyUrl]")
    .option("--note <text>", "Operator note")
    .option("--dry-run", "Preview without publishing", false)
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (spotifyUrl: string | undefined, options: AddOptions) => {
      const { addCommand } = await import("./commands/add");
      await runAdd(spotifyUrl, options, addCommand);
    });

  // The video render queue. `--has-context`/`--has-observation` narrow it to the
  // observation crons' queues (which findings still need field notes / a voice).
  adminTracks
    .command("queue")
    .description("Findings awaiting a video, oldest first (the next to film is first)")
    .option("--limit <limit>", "Number of findings to show", "10")
    .option("--has-context", "Only findings whose field notes are already gathered")
    .option("--has-observation", "Only findings that already have a spoken observation")
    .option("--json", "Print JSON", false)
    .action(async (options: AdminQueueOptions) => {
      const { queueCommand } = await import("./commands/admin-tracks");
      await runAdminQueue(options, queueCommand);
    });

  admin
    .command("queue", { hidden: true })
    .description("Render queue (alias of `admin tracks queue`)")
    .option("--limit <limit>", "Number of findings to show", "10")
    .option("--has-context", "Only findings whose field notes are already gathered")
    .option("--has-observation", "Only findings that already have a spoken observation")
    .option("--json", "Print JSON", false)
    .action(async (options: AdminQueueOptions) => {
      const { queueCommand } = await import("./commands/admin-tracks");
      await runAdminQueue(options, queueCommand);
    });

  // The enrichment verb. Enrichment itself runs as the on-box `fluncle-enrich`
  // `--no-agent` cron (it analyzes on-box and writes back via `tracks update`), so
  // the CLI surface is the worklist view: `--queue` shows findings needing
  // (re-)enrichment — pending ∪ failed ∪ stuck processing. The box cron reads this
  // to drain the queue.
  adminTracks
    .command("enrich")
    .description("Enrichment worklist (pending, failed, or stuck processing) — use --queue")
    .option("--queue", "Show the enrichment worklist, oldest first", false)
    .option("--limit <limit>", "Number of findings to show with --queue", "10")
    .option("--json", "Print JSON", false)
    .action(async (options: AdminQueueViewOptions) => {
      // `--queue` is the worklist view — the on-box `fluncle-enrich` cron's
      // worklist. Enrichment has no single-track CLI form (it runs on the box), so
      // without `--queue` there's nothing to act on; require it, mirroring how
      // `observe`/`context` gate their worklist view on `--queue`.
      if (!options.queue) {
        console.error(
          "`tracks enrich` is a worklist view — enrichment runs on the on-box `fluncle-enrich` cron.\nUse `tracks enrich --queue` to see findings needing (re-)enrichment.",
        );
        process.exitCode = 1;
        return;
      }

      const { enrichQueueCommand } = await import("./commands/admin-tracks");
      await runAdminEnrichQueue(options, enrichQueueCommand);
    });

  adminTracks
    .command("vehicles")
    .description("Recent video vehicles, newest first (the style ledger for diversity)")
    .option("--limit <limit>", "Number of vehicles to show", "10")
    .option("--json", "Print JSON", false)
    .action(async (options: AdminListOptions) => {
      const { vehiclesCommand } = await import("./commands/admin-tracks");
      await runAdminVehicles(options, vehiclesCommand);
    });

  admin
    .command("vehicles", { hidden: true })
    .description("Video vehicles (alias of `admin tracks vehicles`)")
    .option("--limit <limit>", "Number of vehicles to show", "10")
    .option("--json", "Print JSON", false)
    .action(async (options: AdminListOptions) => {
      const { vehiclesCommand } = await import("./commands/admin-tracks");
      await runAdminVehicles(options, vehiclesCommand);
    });

  const adminTrack = adminTracks;

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
    .option("--footage <file>", "Video footage (square crop source)")
    .option("--footage-silent <file>", "Silent video footage (retiring)")
    .option("--footage-social <file>", "Portrait social cut (baked text)")
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
    .command("preview")
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

  adminTrack
    .command("observe")
    .description("Render Fluncle's spoken field observation for a track (ElevenLabs, Worker-side)")
    .argument("[idOrLogId]")
    .option(
      "--queue",
      "Show the observe worklist (notes but no observation yet), oldest first",
      false,
    )
    .option("--limit <limit>", "Number of findings to show with --queue", "10")
    .option("--script <text>", "The voice-gated observation script (the spoken text)")
    .option(
      "--script-file <file>",
      "Read the observation script from a file (e.g. observation.txt)",
    )
    .option("--voice-id <id>", "Override the configured ElevenLabs voice id")
    .option("--model <model>", "TTS model (eleven_multilingual_v2 | eleven_v3)")
    .option("--duration-ms <ms>", "Probed audio duration in ms (the agent runs ffprobe)")
    .option("--duration-target-sec <sec>", "Target observation length in seconds (20–45)")
    .option("--context-note <text>", "Pre-fetched factual context (else the Worker firecrawls)")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (idOrLogId: string | undefined, options: TrackObserveOptions) => {
      // `--queue` is the observe worklist view (findings with notes but no
      // observation yet) — the observe cron's worklist. Otherwise observe one track.
      if (options.queue) {
        const { observeQueueCommand } = await import("./commands/admin-tracks");
        await runAdminObserveQueue(options, observeQueueCommand);
        return;
      }

      const { trackObserveCommand } = await import("./commands/track");
      await runTrackObserve(idOrLogId, options, trackObserveCommand);
    });

  // `context_track` → `admin tracks context` (Convention B). Fetch the field notes
  // (the facts) before Fluncle speaks; `observe` reads them as fuel. Idempotent.
  adminTrack
    .command("context")
    .description("Gather the field notes for a finding (facts only; observe speaks from them)")
    .argument("[idOrLogId]")
    .option(
      "--queue",
      "Show the context worklist (findings missing field notes), oldest first",
      false,
    )
    .option("--limit <limit>", "Number of findings to show with --queue", "10")
    .option("--query <text>", "Override the fact-search query (else the Worker builds one)")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (idOrLogId: string | undefined, options: TrackContextOptions) => {
      // `--queue` is the context worklist view (findings missing field notes) — the
      // context cron's worklist. Otherwise gather one finding's field notes.
      if (options.queue) {
        const { contextQueueCommand } = await import("./commands/admin-tracks");
        await runAdminContextQueue(options, contextQueueCommand);
        return;
      }

      const { trackContextCommand } = await import("./commands/track");
      await runTrackContext(idOrLogId, options, trackContextCommand);
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
    .option("--note <text>", "Operator note")
    .option("--recorded-at <date>", "Recorded date (ISO)")
    .option(
      "--soundcloud-url <url>",
      "SoundCloud URL (manual; YouTube + Mixcloud come from distribute)",
    )
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
    .option("--note <text>", "Operator note")
    .option("--recorded-at <date>", "Recorded date (ISO)")
    .option(
      "--soundcloud-url <url>",
      "SoundCloud URL (manual; YouTube + Mixcloud come from distribute)",
    )
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

  const adminNewsletter = configureCommand(
    admin.command("newsletter").description("Newsletter edition commands"),
  );

  adminNewsletter.action(() => {
    adminNewsletter.outputHelp();
  });

  // `create_edition` → `admin newsletter draft`. The Friday cron persists the
  // authored edition here FIRST (persist-then-offer), then offers the Discord send
  // button. Agent-allowed (admin tier). Re-run updates the stale draft, never dupes.
  adminNewsletter
    .command("draft")
    .description("Persist a newsletter edition draft (the agent authors it, you send it)")
    .option("--content-file <file>", "Structured edition content payload (JSON)")
    .option("--subject <text>", "Email subject line")
    .option("--window-since <date>", "Discovery-window start (ISO)")
    .option("--window-until <date>", "Discovery-window end (ISO)")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (options: NewsletterDraftOptions) => {
      const { newsletterDraftCommand } = await import("./commands/newsletter");
      await runNewsletterDraft(options, newsletterDraftCommand);
    });

  // `update_edition` → `admin newsletter update`. Edit a draft's payload/subject/
  // window before send. Sent editions are frozen (409). Agent-allowed (admin tier).
  adminNewsletter
    .command("update")
    .description("Update a draft edition's payload, subject, or window")
    .argument("[id]")
    .option("--content-file <file>", "Structured edition content payload (JSON)")
    .option("--subject <text>", "Email subject line")
    .option("--window-since <date>", "Discovery-window start (ISO)")
    .option("--window-until <date>", "Discovery-window end (ISO)")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (id: string | undefined, options: NewsletterDraftOptions) => {
      const { newsletterUpdateCommand } = await import("./commands/newsletter");
      await runNewsletterUpdate(id, options, newsletterUpdateCommand);
    });

  // `send_edition` → `admin newsletter send`. OPERATOR ONLY — the human gate (the
  // old Loops dashboard tap). The Worker creates + sends the Resend broadcast and
  // mints the number. A valid AGENT token gets a 403, so the cron can't send.
  adminNewsletter
    .command("send")
    .description("Send an edition — OPERATOR only (Resend broadcast + mint the number)")
    .argument("[id]")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (id: string | undefined, options: { json: boolean }) => {
      const { newsletterSendCommand } = await import("./commands/newsletter");
      await runNewsletterSend(id, options, newsletterSendCommand);
    });

  // `list_editions_admin` → `admin newsletter list`. Every edition INCLUDING drafts
  // (the public archive is sent-only). The cron reads this from a fresh session to
  // find an unsent draft + the last sent edition's window cutoff.
  adminNewsletter
    .command("list")
    .description("List every edition including drafts (the cron's miss-recovery read)")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (options: { json: boolean }) => {
      const { newsletterListCommand } = await import("./commands/newsletter");
      await runNewsletterList(options, newsletterListCommand);
    });

  const submissions = configureCommand(
    admin.command("submissions").description("Review listener submissions"),
  );

  submissions.option("--json", "Print JSON", false).action(async (options: JsonOptions) => {
    const { listSubmissionsCommand } = await import("./commands/submissions");
    await listSubmissionsCommand(options);
  });

  submissions
    .command("review")
    .description("Inspect one submission")
    .argument("[submissionId]")
    .option("--json", "Print JSON", false)
    .action(async (submissionId: string | undefined, options: JsonOptions) => {
      if (!submissionId) {
        throw new Error("Missing submission id for: review");
      }

      const { reviewSubmissionCommand } = await import("./commands/submissions");
      await reviewSubmissionCommand(submissionId, options);
    });

  submissions
    .command("reject")
    .description("Reject a submission")
    .argument("[submissionId]")
    .option("--json", "Print JSON", false)
    .action(async (submissionId: string | undefined, options: JsonOptions) => {
      if (!submissionId) {
        throw new Error("Missing submission id for: reject");
      }

      const { rejectSubmissionCommand } = await import("./commands/submissions");
      await rejectSubmissionCommand(submissionId, options);
    });

  submissions
    .command("approve")
    .description("Approve a submission (--json approves without the confirm prompt)")
    .argument("[submissionId]")
    .option("--json", "Print JSON, skip the confirm prompt", false)
    .action(async (submissionId: string | undefined, options: JsonOptions) => {
      if (!submissionId) {
        throw new Error("Missing submission id for: approve");
      }

      const { approveSubmissionCommand } = await import("./commands/submissions");
      await approveSubmissionCommand(submissionId, options);
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

  auth
    .command("lastfm")
    .description(
      "Authorize Last.fm access (love-on-add). Run once for the URL, then again with --token",
    )
    .option("--token <token>", "The approved request token, to mint the session key")
    .action(async (options: { token?: string }) => {
      const { authLastfmCommand } = await import("./commands/auth-lastfm");
      await authLastfmCommand(options);
    });

  // `backfill_*` ops → plural `backfills` group (Convention B). `backfill` kept as
  // a hidden alias so `admin backfill <provider>` still resolves.
  const backfill = configureCommand(
    admin.command("backfills").alias("backfill").description("Backfill operator-only archives"),
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

  backfill
    .command("lastfm")
    .description(
      "Love already-published findings on Last.fm (idempotent; a no-op until configured)",
    )
    .option(
      "--dry-run",
      "Resolve the set but fire no loves; just report what would be loved",
      false,
    )
    .option("--limit <limit>", "Max findings to love", "50")
    .option("--json", "Print JSON", false)
    .action(async (options: BackfillSyncOptions) => {
      const { backfillLastfmCommand } = await import("./commands/admin-tracks");
      await runBackfillLastfm(options, backfillLastfmCommand);
    });

  backfill
    .command("discogs")
    .description(
      "Resolve missing Discogs release ids for published findings (high-confidence only)",
    )
    .option("--dry-run", "Resolve but write nothing; just report what would be resolved", false)
    .option("--limit <limit>", "Max findings to resolve", "50")
    .option("--json", "Print JSON", false)
    .action(async (options: BackfillSyncOptions) => {
      const { backfillDiscogsCommand } = await import("./commands/admin-tracks");
      await runBackfillDiscogs(options, backfillDiscogsCommand);
    });
}

async function runTrackPreviewArchive(
  idOrLogId: string | undefined,
  options: TrackPreviewArchiveOptions,
  previewArchiveUploadCommand: typeof import("./commands/preview-archive").previewArchiveUploadCommand,
): Promise<void> {
  if (!idOrLogId || !options.file || !options.source || !options.mime) {
    throw new Error(
      "Usage: fluncle admin tracks preview <track_id|log_id> --file <file> --source <source> --mime <mime> [--json]",
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

async function runTrackObserve(
  idOrLogId: string | undefined,
  options: TrackObserveOptions,
  trackObserveCommand: typeof import("./commands/track").trackObserveCommand,
): Promise<void> {
  const script = options.scriptFile ? readFileSync(options.scriptFile, "utf8") : options.script;

  if (!idOrLogId || !script || !script.trim()) {
    throw new Error(
      "Usage: fluncle admin tracks observe <track_id|log_id> (--script <text> | --script-file <file>) [--voice-id <id>] [--model <model>] [--duration-ms <ms>] [--context-note <text>] [--json]",
    );
  }

  const durationMs =
    options.durationMs === undefined ? undefined : Number.parseInt(options.durationMs, 10);

  if (durationMs !== undefined && (!Number.isInteger(durationMs) || durationMs < 1)) {
    throw new Error("--duration-ms must be a positive integer");
  }

  const durationTargetSec =
    options.durationTargetSec === undefined
      ? undefined
      : Number.parseInt(options.durationTargetSec, 10);

  if (
    durationTargetSec !== undefined &&
    (!Number.isInteger(durationTargetSec) || durationTargetSec < 1)
  ) {
    throw new Error("--duration-target-sec must be a positive integer");
  }

  const result = await trackObserveCommand(idOrLogId, {
    contextNote: options.contextNote,
    durationMs,
    durationTargetSec,
    model: options.model,
    script: script.trim(),
    voiceId: options.voiceId,
  });

  if (options.json) {
    printJson(result);
    return;
  }

  console.log(`Recorded observation for ${result.logId}`);
  console.log(`  audio: ${result.audioUrl}`);
  console.log(`  length: ${Math.round(result.durationMs / 1000)}s`);
  console.log(`  voice: ${result.voiceId}`);
}

async function runTrackContext(
  idOrLogId: string | undefined,
  options: TrackContextOptions,
  trackContextCommand: typeof import("./commands/track").trackContextCommand,
): Promise<void> {
  if (!idOrLogId) {
    throw new Error(
      "Usage: fluncle admin tracks context <track_id|log_id> [--query <text>] [--json]",
    );
  }

  const result = await trackContextCommand(idOrLogId, { query: options.query });

  if (options.json) {
    printJson(result);
    return;
  }

  if (result.skipped) {
    console.log(`Field notes already on file for ${result.logId}. Nothing to gather.`);
    return;
  }

  if (!result.contextNote.trim()) {
    console.log(`No field notes turned up for ${result.logId}. The queue will swing back around.`);
    return;
  }

  console.log(`Gathered field notes for ${result.logId}:`);
  console.log(`  ${result.contextNote}`);

  if (result.sources.length > 0) {
    console.log(`  sources: ${result.sources.join(", ")}`);
  }
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

// `--limit` caps the TOTAL findings processed across the whole loop (a bounded
// probe), not a single request. Each endpoint pass is server-clamped to a small
// batch (so it stays inside the Worker budget) and returns a resume cursor; the
// CLI loops the cursor — stopping when the archive is drained (cursor null) or
// the total cap is reached — aggregating the per-pass results.
async function runBackfillLastfm(
  options: BackfillSyncOptions,
  backfillLastfmCommand: typeof import("./commands/admin-tracks").backfillLastfmCommand,
): Promise<void> {
  const limit = parseListLimit(options.limit);
  const loved: string[] = [];
  const failed: Array<{ error: string; logId: string }> = [];
  let cursor: string | undefined;
  let dryRun = options.dryRun;

  while (loved.length + failed.length < limit) {
    const remaining = limit - (loved.length + failed.length);
    const result = await backfillLastfmCommand(remaining, options.dryRun, cursor);
    dryRun = result.dryRun;
    loved.push(...result.loved);
    failed.push(...result.failed);

    if (!options.json) {
      const verb = result.dryRun ? "Would love" : "Loved";
      console.log(`  …${verb.toLowerCase()} ${result.lovedCount}; ${result.failedCount} failed`);
    }

    if (result.nextCursor === null) {
      break;
    }

    cursor = result.nextCursor;
  }

  if (options.json) {
    printJson({
      dryRun,
      failed,
      failedCount: failed.length,
      loved,
      lovedCount: loved.length,
      ok: true,
    });
    return;
  }

  const verb = dryRun ? "Would love" : "Loved";
  console.log(`${verb} ${loved.length} finding(s) on Last.fm; ${failed.length} failed.`);

  for (const logId of loved) {
    console.log(`  ${logId}`);
  }

  for (const item of failed) {
    console.log(`  ${item.logId}: ${item.error}`);
  }
}

async function runBackfillDiscogs(
  options: BackfillSyncOptions,
  backfillDiscogsCommand: typeof import("./commands/admin-tracks").backfillDiscogsCommand,
): Promise<void> {
  const limit = parseListLimit(options.limit);
  const resolved: Array<{ logId: string; masterId?: number; releaseId: number; source: string }> =
    [];
  const unresolved: string[] = [];
  let cursor: string | undefined;
  let dryRun = options.dryRun;

  while (resolved.length + unresolved.length < limit) {
    const remaining = limit - (resolved.length + unresolved.length);
    const result = await backfillDiscogsCommand(remaining, options.dryRun, cursor);
    dryRun = result.dryRun;
    resolved.push(...result.resolved);
    unresolved.push(...result.unresolved);

    if (!options.json) {
      const verb = result.dryRun ? "would resolve" : "resolved";
      console.log(`  …${verb} ${result.resolvedCount}; ${result.unresolvedCount} unresolved`);
    }

    if (result.nextCursor === null) {
      break;
    }

    cursor = result.nextCursor;
  }

  if (options.json) {
    printJson({
      dryRun,
      ok: true,
      resolved,
      resolvedCount: resolved.length,
      unresolved,
      unresolvedCount: unresolved.length,
    });
    return;
  }

  const verb = dryRun ? "Would resolve" : "Resolved";
  console.log(`${verb} ${resolved.length} Discogs release id(s); ${unresolved.length} unresolved.`);

  for (const item of resolved) {
    const master = item.masterId ? ` (master ${item.masterId})` : "";
    console.log(`  ${item.logId}: release ${item.releaseId}${master}`);
  }
}

async function runTrackVideo(
  idOrLogId: string | undefined,
  options: TrackVideoOptions,
  trackVideoCommand: typeof import("./commands/track").trackVideoCommand,
): Promise<void> {
  if (!idOrLogId) {
    throw new Error(
      "Missing id. Usage: fluncle admin tracks video <track_id|log_id> (--dir <dir> | --footage <file> [--footage-social <file>] [--footage-silent <file>] [--poster <file>] [--cover <file>] [--note <file>] [--composition <file>] [--props <file>] [--render <file>])",
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
    footageSocial: resolveFile(options.footageSocial, "footage.social.mp4"),
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
      "Missing id. Usage: fluncle admin tracks draft <track_id|log_id> [--platform tiktok]",
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
      "Missing id. Usage: fluncle admin tracks social <track_id|log_id> [--platform tiktok] [--status scheduled|published [--url <url>]]",
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
    throw new Error("Missing id. Usage: fluncle tracks get <track_id|log_id> [--json]");
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
    throw new Error("Missing track id. Usage: fluncle admin tracks update <track_id>");
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

async function runNewsletterDraft(
  options: NewsletterDraftOptions,
  newsletterDraftCommand: typeof import("./commands/newsletter").newsletterDraftCommand,
): Promise<void> {
  const result = await newsletterDraftCommand(options);

  if (options.json) {
    printJson(result);
    return;
  }

  console.log(
    `Drafted edition ${result.edition.id}. It stays a draft until the operator sends it.`,
  );
}

async function runNewsletterUpdate(
  id: string | undefined,
  options: NewsletterDraftOptions,
  newsletterUpdateCommand: typeof import("./commands/newsletter").newsletterUpdateCommand,
): Promise<void> {
  if (!id) {
    throw new Error("Missing edition id. Usage: fluncle admin newsletter update <id>");
  }

  const result = await newsletterUpdateCommand(id, options);

  if (options.json) {
    printJson(result);
    return;
  }

  console.log(`Saved draft ${result.edition.id}.`);
}

async function runNewsletterSend(
  id: string | undefined,
  options: { json: boolean },
  newsletterSendCommand: typeof import("./commands/newsletter").newsletterSendCommand,
): Promise<void> {
  if (!id) {
    throw new Error("Missing edition id. Usage: fluncle admin newsletter send <id>");
  }

  const result = await newsletterSendCommand(id);

  if (options.json) {
    printJson(result);
    return;
  }

  const number = result.edition.number;
  console.log(
    number === undefined
      ? `Sent edition ${result.edition.id}.`
      : `Sent edition #${number} — it's out to the list and in the archive.`,
  );
}

async function runNewsletterList(
  options: { json: boolean },
  newsletterListCommand: typeof import("./commands/newsletter").newsletterListCommand,
): Promise<void> {
  const editions = await newsletterListCommand();

  if (options.json) {
    printJson({ editions, ok: true });
    return;
  }

  if (editions.length === 0) {
    console.log("No editions yet.");
    return;
  }

  for (const edition of editions) {
    const label = edition.number === undefined ? "draft" : `#${edition.number}`;
    const subject = edition.subject ?? "(no subject)";
    console.log(`${label}\t${edition.status}\t${edition.id}\t${subject}`);
  }
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
  options: AdminQueueOptions,
  queueCommand: typeof import("./commands/admin-tracks").queueCommand,
): Promise<void> {
  const limit = parseListLimit(options.limit);
  const tracks = await queueCommand(limit, {
    hasContext: options.hasContext ? true : undefined,
    hasObservation: options.hasObservation ? true : undefined,
  });

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

async function runAdminContextQueue(
  options: AdminListOptions,
  contextQueueCommand: typeof import("./commands/admin-tracks").contextQueueCommand,
): Promise<void> {
  const limit = parseListLimit(options.limit);
  const tracks = await contextQueueCommand(limit);

  if (options.json) {
    printJson({
      ok: true,
      tracks,
    });
    return;
  }

  if (tracks.length === 0) {
    console.log("Every finding has its field notes. Nothing waiting on context.");
    return;
  }

  const { trackRows } = await import("./format");
  const noun = tracks.length === 1 ? "finding" : "findings";
  console.log(`${tracks.length} ${noun} missing field notes, oldest first:`);
  console.log(trackRows(tracks).join("\n"));
}

async function runAdminObserveQueue(
  options: AdminListOptions,
  observeQueueCommand: typeof import("./commands/admin-tracks").observeQueueCommand,
): Promise<void> {
  const limit = parseListLimit(options.limit);
  const tracks = await observeQueueCommand(limit);

  if (options.json) {
    printJson({
      ok: true,
      tracks,
    });
    return;
  }

  if (tracks.length === 0) {
    console.log("Every finding with notes has its observation. Nothing waiting on a voice.");
    return;
  }

  const { trackRows } = await import("./format");
  const noun = tracks.length === 1 ? "finding" : "findings";
  console.log(`${tracks.length} ${noun} awaiting an observation, oldest first:`);
  console.log(trackRows(tracks).join("\n"));
}

async function runAdminEnrichQueue(
  options: AdminListOptions,
  enrichQueueCommand: typeof import("./commands/admin-tracks").enrichQueueCommand,
): Promise<void> {
  const limit = parseListLimit(options.limit);
  const tracks = await enrichQueueCommand(limit);

  if (options.json) {
    printJson({
      ok: true,
      tracks,
    });
    return;
  }

  if (tracks.length === 0) {
    console.log("Nothing awaiting enrichment. Every finding is enriched.");
    return;
  }

  const { trackRows } = await import("./format");
  const noun = tracks.length === 1 ? "finding" : "findings";
  console.log(`${tracks.length} ${noun} needing (re-)enrichment, oldest first:`);
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
    if (arg === undefined) {
      continue;
    }

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
    if (arg === undefined) {
      continue;
    }

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
    if (arg === undefined) {
      continue;
    }

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
  "--footage-social",
  "--from",
  "--key",
  "--limit",
  "--mime",
  "--note",
  "--platform",
  "--poster",
  "--props",
  "--query",
  "--recorded-at",
  "--render",
  "--scheduled-for",
  "--soundcloud-url",
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
