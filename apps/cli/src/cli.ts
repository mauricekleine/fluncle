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
  hasObservation?: boolean;
};

// `admin tracks requeue-analysis` — the archive-wide BPM/key provenance repair. Dry-run
// unless `--apply`; `--limit` caps the archive walk (absent ⇒ the whole archive).
type AdminRequeueAnalysisOptions = {
  apply?: boolean;
  json: boolean;
  limit?: string;
};

// `admin tracks list` filters. `--no-key` is Commander's negation of a `key`
// boolean (default true), so `key === false` means the flag was passed; `--has-key
// <bool>` is the explicit tri-state form. Absent both ⇒ no key filter (list all).
type AdminTracksListOptions = AdminListOptions & {
  all?: boolean;
  hasKey?: string;
  key?: boolean;
  order?: string;
};

// A verb whose worklist is a `--queue` view flag (`tracks enrich|observe|context|
// note --queue`): the worklist runners read `json`/`limit` off it (AdminListOptions).
type AdminQueueViewOptions = AdminListOptions & {
  queue?: boolean;
};

// The Fluncle Studio clip-library list filter (`admin clips list`).
type ClipListOptions = {
  json: boolean;
  recording?: string;
  status?: string;
};

// The Fluncle Studio recording admin options (`admin recordings create|update`).
type RecordingCreateOptions = {
  json: boolean;
  plan?: boolean;
  recordedAt?: string;
  title?: string;
  video?: string;
};

type RecordingUpdateOptions = {
  json: boolean;
  parentId?: string;
  recordedAt?: string;
  title?: string;
  tracklistFile?: string;
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
  analyzedAt?: string;
  analyzedFrom?: string;
  bpm?: string;
  bpmConfidence?: string;
  bpmSource?: string;
  embedding?: string;
  embeddingFile?: string;
  features?: string;
  json: boolean;
  key?: string;
  keyConfidence?: string;
  keySource?: string;
  note?: string;
  status?: string;
  videoUrl?: string;
};

type TrackVideoOptions = {
  allowPartial?: boolean;
  composition?: string;
  cover?: string;
  dir?: string;
  footage?: string;
  footageLandscape?: string;
  footageLandscapeSocial?: string;
  footageNotext?: string;
  footageSocial?: string;
  intent?: string;
  json: boolean;
  metrics?: string;
  model?: string;
  note?: string;
  plate?: string;
  plateBackground?: string;
  poster?: string;
  props?: string;
  reasoning?: string;
  render?: string;
  scene?: string;
};

type TrackDraftOptions = {
  json: boolean;
  platform?: string;
};

type TrackSocialOptions = {
  capture?: boolean;
  json: boolean;
  limit?: string;
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
  force?: boolean;
  json: boolean;
  limit?: string;
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
  refresh?: boolean;
  retryEmpty?: boolean;
};

type TrackNoteOptions = {
  json: boolean;
  limit?: string;
  queue?: boolean;
  script?: string;
  scriptFile?: string;
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

type MigratePreviewArchiveOptions = {
  deletePublic: boolean;
  execute: boolean;
  json: boolean;
  limit?: string;
  verify: boolean;
};

type ArtistResolveOptions = {
  json: boolean;
  limit?: string;
  queue?: boolean;
};

type MixtapeUpdateOptions = {
  durationMs?: string;
  json: boolean;
  note?: string;
  recordedAt?: string;
  soundcloudUrl?: string;
};

type MixtapeDistributeOptions = {
  audio?: string;
  json: boolean;
  mixcloud?: boolean;
  unlisted?: boolean;
  video?: string;
  youtube?: boolean;
};

type MixtapeResyncOptions = {
  json: boolean;
  mixcloud?: boolean;
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
  addAccountCommands(program);
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
    .command("artists")
    .description("Browse artists in Fluncle's archive")
    .argument("[slug]", "Artist slug (omit for the full list)")
    .option("--json", "Print JSON", false)
    .action(async (slug: string | undefined, options: JsonOptions) => {
      const { artistsListCommand, artistsGetCommand } = await import("./commands/artists");
      await runArtists(slug, options, { artistsGetCommand, artistsListCommand });
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

// The cross-surface ACCOUNT tier (`fluncle login`). A signed-in listener links
// this device to their OWN Fluncle account (the device-authorization flow) to sync
// their Galaxy progress + saved findings. The minted user token is stored
// HARD-SEPARATE from the admin FLUNCLE_API_TOKEN (see user-token.ts); these
// commands never read or write the admin grant.
function addAccountCommands(program: Command): void {
  program
    .command("login")
    .description("Link this device to your Fluncle account (sync your Galaxy)")
    .action(async () => {
      const { loginCommand } = await import("./commands/login");
      await loginCommand();
    });

  program
    .command("logout")
    .description("Unlink this device from your account")
    .action(async () => {
      const { logoutCommand } = await import("./commands/login");
      await logoutCommand();
    });

  program
    .command("me")
    .description("Your account and Galaxy progress (sign in with `fluncle login`)")
    .option("--json", "Print JSON", false)
    .action(async (options: JsonOptions) => {
      const { meCommand } = await import("./commands/me");
      await runMe(options, meCommand);
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

  program
    .command("status")
    .description("How Fluncle's services are holding up")
    .option("--json", "Print JSON", false)
    .action(async (options: JsonOptions) => {
      const { statusCommand } = await import("./commands/status");
      await runStatus(options, statusCommand);
    });
}

function addTrackCommands(program: Command): void {
  // Convention B: public CLI groups are PLURAL. The canonical public lookup group is
  // `tracks`.
  const tracks = configureCommand(
    program.command("tracks", { hidden: true }).description("Public track lookups"),
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

  // `get_attention` → `admin queue` (Convention B: a bare admin verb for the operator's
  // own read). The `/admin` attention queue + the day's dispatch, off the Worker — the
  // same digest the Raycast menu-bar command reads. Distinct from `admin tracks queue`
  // (the video render queue).
  admin
    .command("queue")
    .description("The attention queue: what's waiting, and the day's dispatch")
    .option("--json", "Print JSON", false)
    .action(async (options: JsonOptions) => {
      const { attentionQueueCommand } = await import("./commands/admin-attention");
      await runAdminAttention(options, attentionQueueCommand);
    });

  // Convention B: the admin CLI is `group noun-verb` with PLURAL groups. The canonical
  // track group is `tracks`. A verb's worklist is a `--queue` view flag on the verb
  // itself (`tracks enrich --queue`, `tracks observe --queue`, `tracks context
  // --queue`), not a dash-compound command (§6.4) — the box `fluncle-enrich` cron reads
  // `tracks enrich --queue` to drain the queue (the Worker no longer re-fires
  // enrichment itself).
  const adminTracks = configureCommand(admin.command("tracks").description("Track admin commands"));

  adminTracks.action(() => {
    adminTracks.outputHelp();
  });

  // `add_track` → `admin tracks publish` (canonical).
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

  // The video render queue. It is HARD-GATED on `hasContext=true`: it only ever
  // surfaces findings that already carry a stored context note, so the render's
  // context read is a guaranteed cached no-op (never a Firecrawl trigger).
  // `--has-observation` narrows it to the already-voiced subset.
  adminTracks
    .command("queue")
    .description("Findings awaiting a video, oldest first (the next to film is first)")
    .option("--limit <limit>", "Number of findings to show", "10")
    .option("--has-observation", "Only findings that already have a spoken observation")
    .option("--json", "Print JSON", false)
    .action(async (options: AdminQueueOptions) => {
      const { queueCommand } = await import("./commands/admin-tracks");
      await runAdminQueue(options, queueCommand);
    });

  // A filterable listing of findings. Primary use: `--no-key` surfaces the
  // missing-musical-key backlog (findings the DSP left key-null below its
  // confidence floor) so it's countable + targetable — the input query for the
  // Rekordbox key-backfill (fluncle-key-backfill skill). `--has-key <bool>` is the
  // explicit tri-state (list only those WITH, or only those WITHOUT, a key).
  adminTracks
    .command("list")
    .description("List findings, filterable by musical-key presence (--no-key / --has-key)")
    .option("--limit <limit>", "Number of findings to show (1-100)", "50")
    .option(
      "--all",
      "Fetch the ENTIRE catalogue, paginating past the 100-row cap (overrides --limit)",
      false,
    )
    .option("--no-key", "Only findings with NO stored musical key (the key-backfill backlog)")
    .option("--has-key <bool>", "Filter by key presence: true (has key) or false (missing)")
    .option("--order <order>", "Sort: asc (oldest first) or desc (newest first)", "desc")
    .option("--json", "Print JSON", false)
    .action(async (options: AdminTracksListOptions) => {
      const { listCommand } = await import("./commands/admin-tracks");
      await runAdminTracksList(options, listCommand);
    });

  // The enrichment verb. Enrichment itself runs as the on-box `fluncle-enrich`
  // `--no-agent` cron (it analyzes on-box and writes back via `tracks update`), so
  // the CLI surface is the worklist view: `--queue` shows findings needing
  // (re-)enrichment — pending ∪ failed ∪ stuck processing. The box cron reads this
  // to drain the queue.
  adminTracks
    .command("enrich")
    .description("Enrichment worklist (pending, failed, or stuck processing). Use --queue")
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
          "`tracks enrich` is a worklist view. Enrichment runs on the on-box `fluncle-enrich` cron.\nUse `tracks enrich --queue` to see findings needing (re-)enrichment.",
        );
        process.exitCode = 1;
        return;
      }

      const { enrichQueueCommand } = await import("./commands/admin-tracks");
      await runAdminEnrichQueue(options, enrichQueueCommand);
    });

  // The audio-embedding verb. The MuQ embedding runs as the on-box `fluncle-embed`
  // `--no-agent` cron (it embeds on-box with torch and writes the vector back via
  // `tracks update <id> --embedding-file`), so the CLI surface is the worklist view:
  // `--queue` shows findings with no embedding yet. The box cron reads this to drain
  // the queue. See docs/track-lifecycle.md.
  adminTracks
    .command("embed")
    .description("Audio-embedding worklist (findings with no MuQ vector yet). Use --queue")
    .option("--queue", "Show the embedding worklist, oldest first", false)
    .option("--limit <limit>", "Number of findings to show with --queue", "10")
    .option("--json", "Print JSON", false)
    .action(async (options: AdminQueueViewOptions) => {
      // `--queue` is the worklist view — the on-box `fluncle-embed` cron's worklist.
      // Embedding has no single-track CLI form (it runs on the box), so without
      // `--queue` there's nothing to act on; require it, mirroring `enrich`.
      if (!options.queue) {
        console.error(
          "`tracks embed` is a worklist view. Embedding runs on the on-box `fluncle-embed` cron.\nUse `tracks embed --queue` to see findings needing an audio embedding.",
        );
        process.exitCode = 1;
        return;
      }

      const { embedQueueCommand } = await import("./commands/admin-tracks");
      await runAdminEmbedQueue(options, embedQueueCommand);
    });

  // The full-song capture verb. Capture runs as the on-box `fluncle-capture`
  // `--no-agent` host-timer cron (it runs yt-dlp through a residential proxy, stores
  // the song in the private `fluncle-source-audio` R2 bucket, and writes back via
  // `tracks update`), so the CLI surface is the worklist view: `--queue` shows findings
  // still needing a capture, NEWEST FIRST (a fresh add jumps ahead of the backfill).
  // Named `capture-audio` (not `capture`) to avoid colliding with `social --capture` /
  // `cron.social-capture`. See docs/agents/hermes/scripts/capture-sweep.*.
  adminTracks
    .command("capture-audio")
    .description("Full-song capture worklist (findings with no source audio yet). Use --queue")
    .option("--queue", "Show the capture worklist, newest first", false)
    .option("--limit <limit>", "Number of findings to show with --queue", "10")
    .option("--json", "Print JSON", false)
    .action(async (options: AdminQueueViewOptions) => {
      // `--queue` is the worklist view — the on-box `fluncle-capture` cron's worklist.
      // Capture has no single-track CLI form (it runs on the box), so without `--queue`
      // there's nothing to act on; require it, mirroring `enrich`/`embed`.
      if (!options.queue) {
        console.error(
          "`tracks capture-audio` is a worklist view. Capture runs on the on-box `fluncle-capture` cron.\nUse `tracks capture-audio --queue` to see findings needing a full-song capture.",
        );
        process.exitCode = 1;
        return;
      }

      const { captureQueueCommand } = await import("./commands/admin-tracks");
      await runAdminCaptureQueue(options, captureQueueCommand);
    });

  // `requeue_analysis` → `admin tracks requeue-analysis` (Convention B; the `requeue` verb is
  // shared with `requeue_video`). The archive-wide analysis-provenance repair (RFC
  // bpm-key-accuracy): re-queue every finding whose BPM/key are preview-grade (`analyzedFrom
  // != full` — NULL legacy rows included) so the on-box `fluncle-enrich` sweep re-derives
  // them. PURE CLI orchestration over the existing `list_tracks_admin` + `update_track` ops.
  // DRY-RUN by default; `--apply` flips the statuses. Rows with no captured full song are
  // reported separately (they re-derive from a preview). Operator-authenticated.
  adminTracks
    .command("requeue-analysis")
    .description("Re-queue findings whose BPM/key are preview-grade (dry-run; --apply to flip)")
    .option("--apply", "Actually flip statuses (default is a dry-run preview)", false)
    .option("--limit <limit>", "Cap the archive walk (default: the whole archive)")
    .option("--json", "Print JSON", false)
    .action(async (options: AdminRequeueAnalysisOptions) => {
      const { requeueAnalysisCommand } = await import("./commands/admin-tracks");
      await runAdminRequeueAnalysis(options, requeueAnalysisCommand);
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

  const adminTrack = adminTracks;

  // `get_track_admin` → `admin tracks get` (Convention B). The authoritative
  // single-finding lookup with FULL admin fields (vibe coords, the video ledger, the
  // observation, the note) — so a lookup never has to scan a list (and can't misread a
  // live finding as nonexistent). Accepts a Spotify id OR a Log ID. Agent-allowed read.
  adminTrack
    .command("get")
    .description("Look up one finding by id or Log ID, with full admin fields")
    .argument("[idOrLogId]")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (idOrLogId: string | undefined, options: JsonOptions) => {
      const { trackGetAdminCommand } = await import("./commands/track");
      await runTrackGetAdmin(idOrLogId, options, trackGetAdminCommand);
    });

  adminTrack
    .command("update")
    .description("Certify a track into the archive")
    .argument("[trackId]")
    .option("--analyzed-at <iso>", "Analysis-write ISO timestamp (BPM/key provenance)")
    .option("--analyzed-from <class>", "Audio class BPM/key were analyzed from: full or preview")
    .option("--bpm <number>", "Track BPM")
    .option("--bpm-confidence <number>", "Analyzer confidence in the BPM (0..1)")
    .option("--bpm-source <source>", "Where the BPM came from (analyzer bpmSource)")
    .option("--embedding <json>", "MuQ audio embedding as a JSON array of 1024 floats")
    .option("--embedding-file <file>", "Read the MuQ embedding JSON array from a file")
    .option("--features <json>", "Audio feature JSON")
    .option("--json", "Print JSON", false)
    .option("--key <key>", "Musical key")
    .option("--key-confidence <number>", "Analyzer confidence in the key (0..1)")
    .option("--key-source <source>", "Where the key came from (analyzer keySource)")
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
    .option(
      "--allow-partial",
      "Allow an intentionally partial upload (skip the re-render-contract check; e.g. poster-only)",
      false,
    )
    .option("--composition <file>", "Composition source file")
    .option("--cover <file>", "Cover image")
    .option("--dir <dir>", "Bundle directory")
    .option("--footage <file>", "Video footage (square crop source)")
    .option("--footage-landscape <file>", "Clean landscape cut (optional escape hatch)")
    .option("--footage-landscape-social <file>", "Landscape cut with baked text (optional)")
    .option("--footage-notext <file>", "Portrait cut without the type layer (optional)")
    .option("--footage-social <file>", "Portrait social cut (baked text)")
    .option("--intent <file>", "Render-intent JSON (optional)")
    .option("--json", "Print JSON", false)
    .option("--metrics <file>", "Gate metrics JSON (optional)")
    .option("--model <model>", "Authoring AI model (<provider>/<model>)")
    .option("--note <file>", "Note file")
    .option("--plate <file>", "Plate-lane photographic plate (plate.png; uploadable pre-render)")
    .option(
      "--plate-background <file>",
      "The plate's subject-removed background (plate.background.png, optional)",
    )
    .option("--poster <file>", "Poster image")
    .option("--props <file>", "Render props JSON")
    .option("--reasoning <level>", "Authoring model reasoning effort (e.g. high)")
    .option("--render <file>", "Render metadata JSON")
    .option("--scene <file>", "Scene replay manifest JSON (fluncle.scene/1, optional)")
    .allowExcessArguments()
    .action(async (idOrLogId: string | undefined, options: TrackVideoOptions) => {
      const { trackVideoCommand } = await import("./commands/track");
      await runTrackVideo(idOrLogId, options, trackVideoCommand);
    });

  adminTrack
    .command("requeue-video")
    .description("Clear a finding's video so it re-enters the render queue (operator)")
    .argument("[idOrLogId]")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (idOrLogId: string | undefined, options: JsonOptions) => {
      const { trackRequeueVideoCommand } = await import("./commands/track");
      await runTrackRequeueVideo(idOrLogId, options, trackRequeueVideoCommand);
    });

  adminTrack
    .command("purge-video")
    .description("Purge a finding's stale Cloudflare video renditions from the edge (operator)")
    .argument("[idOrLogId]")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (idOrLogId: string | undefined, options: JsonOptions) => {
      const { trackPurgeVideoCommand } = await import("./commands/track");
      await runTrackPurgeVideo(idOrLogId, options, trackPurgeVideoCommand);
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
    .option(
      "--capture",
      "Sweep: capture missing YouTube/TikTok post URLs from Postiz (no id needed)",
      false,
    )
    .option("--limit <limit>", "Max pending posts to poll with --capture", "25")
    .option("--json", "Print JSON", false)
    .option("--platform <platform>", "Publishing platform")
    .option("--scheduled-for <date>", "Scheduled publication date")
    .option("--status <status>", "scheduled, published, or failed")
    .option("--url <url>", "Published post URL")
    .allowExcessArguments()
    .action(async (idOrLogId: string | undefined, options: TrackSocialOptions) => {
      // `--capture` is the collection-level sweep (no track id) — the box capture
      // cron's worklist. Otherwise show/update one track's per-platform state.
      if (options.capture) {
        const { trackSocialCaptureCommand } = await import("./commands/track");
        await runTrackSocialCapture(options, trackSocialCaptureCommand);
        return;
      }

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
    .description("Render Fluncle's spoken field observation for a track (Cartesia, Worker-side)")
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
    .option("--voice-id <id>", "Override the configured Cartesia voice id")
    .option("--duration-ms <ms>", "Probed audio duration in ms (else derived from word timestamps)")
    .option("--duration-target-sec <sec>", "Target observation length in seconds (20–45)")
    .option("--context-note <text>", "Pre-fetched factual context (else the Worker firecrawls)")
    .option(
      "--force",
      "Re-render even if an observation already exists (voice re-tune / fix)",
      false,
    )
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
    .option(
      "--retry-empty",
      "With --queue: also re-pick finds confirmed empty last pass (widen the net)",
      false,
    )
    .option("--limit <limit>", "Number of findings to show with --queue", "10")
    .option("--query <text>", "Override the fact-search query (else the Worker builds one)")
    .option("--refresh", "Re-run the fetch even if a note exists (backfill/sharpen)", false)
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (idOrLogId: string | undefined, options: TrackContextOptions) => {
      // `--queue` is the context worklist view (findings missing field notes) — the
      // context cron's worklist. `--retry-empty` widens it to also re-pick finds the
      // prior pass confirmed empty. Otherwise gather one finding's field notes.
      if (options.queue) {
        const { contextQueueCommand } = await import("./commands/admin-tracks");
        await runAdminContextQueue(options, contextQueueCommand);
        return;
      }

      const { trackContextCommand } = await import("./commands/track");
      await runTrackContext(idOrLogId, options, trackContextCommand);
    });

  // `note_track` → `admin tracks note` (Convention B). Author + store the finding's
  // editorial note (the written-note sibling of `observe`). Fills an EMPTY note only;
  // an operator note is never clobbered. `--queue` is the note cron's worklist.
  adminTrack
    .command("note")
    .description("Author the editorial note for a finding (fills an empty note only)")
    .argument("[idOrLogId]")
    .option(
      "--queue",
      "Show the note worklist (context'd findings with no note yet), oldest first",
      false,
    )
    .option("--limit <limit>", "Number of findings to show with --queue", "10")
    .option("--script <text>", "The voice-gated editorial note")
    .option("--script-file <file>", "Read the editorial note from a file")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (idOrLogId: string | undefined, options: TrackNoteOptions) => {
      // `--queue` is the note worklist view (context'd findings with no note yet) —
      // the note cron's worklist. Otherwise author one finding's note.
      if (options.queue) {
        const { noteQueueCommand } = await import("./commands/admin-tracks");
        await runAdminNoteQueue(options, noteQueueCommand);
        return;
      }

      const { trackNoteCommand } = await import("./commands/track");
      await runTrackNote(idOrLogId, options, trackNoteCommand);
    });

  const adminMixtapes = configureCommand(
    admin.command("mixtapes").description("Mixtape admin commands"),
  );

  adminMixtapes.action(() => {
    adminMixtapes.outputHelp();
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
    .command("list")
    .description("List all mixtapes (including distributing)")
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
    .description(
      "Push a promoted mixtape to YouTube (video) and Mixcloud (audio). The mixtape must already be promoted (`recordings promote`). Distribute is push-only.",
    )
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

  adminMixtapes
    .command("resync")
    .description(
      "Re-push a published mixtape's YouTube chapters + Mixcloud sections from its current cues (no re-upload)",
    )
    .argument("[idOrLogId]")
    .option("--youtube", "Only re-sync YouTube")
    .option("--mixcloud", "Only re-sync Mixcloud")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (idOrLogId: string | undefined, options: MixtapeResyncOptions) => {
      const { mixtapeResyncCommand } = await import("./commands/mixtapes");
      await runMixtapeResync(idOrLogId, options, mixtapeResyncCommand);
    });

  // Fluncle Studio clips. `list` is the agent-allowed read;
  // `cut` is the box's footage cut — the `fluncle-studio-clip` cron
  // calls `admin clips cut <clipId>` per pending clip (presign + ffmpeg + ship +
  // finalize, all behind the agent token).
  const adminClips = configureCommand(
    admin.command("clips").description("Mixtape clip (Fluncle Studio) commands"),
  );

  adminClips.action(() => {
    adminClips.outputHelp();
  });

  adminClips
    .command("list")
    .description("List clips (filter by --status pending|done and/or --recording <id>)")
    .option("--status <status>", "Filter by cut status (pending|done)")
    .option("--recording <id>", "Filter by recording id")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (options: ClipListOptions) => {
      const { clipsListCommand, clipPostsListCommand } = await import("./commands/clips");
      await runClipsList(options, clipsListCommand, clipPostsListCommand);
    });

  adminClips
    .command("schedule")
    .description("Set or override a clip's Instagram drip slot (operator)")
    .argument("[clipId]")
    .requiredOption("--at <iso>", "The drip slot, an ISO-8601 timestamp")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (clipId: string | undefined, options: { at: string; json: boolean }) => {
      const { clipScheduleCommand } = await import("./commands/clips");
      await runClipsSchedule(clipId, options, clipScheduleCommand);
    });

  adminClips
    .command("drip-pause")
    .description("Pause the whole Instagram drip-feed, the kill switch (operator)")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (options: { json: boolean }) => {
      const { clipDripPauseCommand } = await import("./commands/clips");
      await runClipsDripPause(true, options, clipDripPauseCommand);
    });

  adminClips
    .command("drip-resume")
    .description("Resume the Instagram drip-feed, clear the kill switch (operator)")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (options: { json: boolean }) => {
      const { clipDripPauseCommand } = await import("./commands/clips");
      await runClipsDripPause(false, options, clipDripPauseCommand);
    });

  adminClips
    .command("cut")
    .description("Cut one clip's framed 9:16 footage from its set rendition, then ship it")
    .argument("[clipId]")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (clipId: string | undefined, options: { json: boolean }) => {
      const { clipCutCommand } = await import("./commands/clips");
      await runClipsCut(clipId, options, clipCutCommand);
    });

  // Fluncle Studio recordings (RFC recording-primitive, Design B). A recording is a
  // captured set clipped WITHOUT minting a coordinate; `promote` turns it into a full
  // published mixtape later (reusing the already-staged video, no re-upload).
  const adminRecordings = configureCommand(
    admin.command("recordings").description("Recording (unpublished set) commands"),
  );

  adminRecordings.action(() => {
    adminRecordings.outputHelp();
  });

  adminRecordings
    .command("create")
    .description("Create a recording (--video to stage a take, or --plan for a videoless plan)")
    .option("--plan", "Create a videoless PLAN (server mints a Galaxy-vocab handle)", false)
    .option("--title <text>", "Recording title (a take)")
    .option("--video <file>", "Set-video master to stage (a 1080p rendition is derived)")
    .option("--recorded-at <date>", "Recorded date (ISO)")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (options: RecordingCreateOptions) => {
      const { recordingCreateCommand } = await import("./commands/recordings");
      await recordingCreateCommand(options);
    });

  adminRecordings
    .command("list")
    .description("List recordings (--kind plan|take, --parent-id <plan> for a plan's takes)")
    .option("--kind <kind>", "Filter by kind: plan | take")
    .option("--parent-id <id>", "List the takes attached to this plan")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (options: { json: boolean; kind?: string; parentId?: string }) => {
      const { recordingsListCommand } = await import("./commands/recordings");
      await recordingsListCommand(options);
    });

  adminRecordings
    .command("get")
    .description("Show one recording by id")
    .argument("[id]")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (id: string | undefined, options: { json: boolean }) => {
      const { recordingGetCommand } = await import("./commands/recordings");
      await recordingGetCommand(id, options);
    });

  adminRecordings
    .command("update")
    .description("Update a recording's title/recorded date/tracklist, or attach it to a plan")
    .argument("[id]")
    .option("--title <text>", "Recording title")
    .option("--recorded-at <date>", "Recorded date (ISO)")
    .option("--parent-id <id>", "Attach this take to its plan (assigns the take's version)")
    .option("--tracklist-file <file>", "JSON file with the whole cue tracklist array")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (id: string | undefined, options: RecordingUpdateOptions) => {
      const { recordingUpdateCommand } = await import("./commands/recordings");
      await recordingUpdateCommand(id, options);
    });

  adminRecordings
    .command("replace-cues")
    .description("Replace a recording's whole cue tracklist from a JSON file (--cues-file)")
    .argument("[id]")
    .option("--cues-file <file>", "JSON file with the ordered cue array")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (id: string | undefined, options: { cuesFile?: string; json: boolean }) => {
      const { recordingReplaceCuesCommand } = await import("./commands/recordings");
      await recordingReplaceCuesCommand(id, options);
    });

  adminRecordings
    .command("delete")
    .description("Delete a recording (cascade its clips)")
    .argument("[id]")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (id: string | undefined, options: { json: boolean }) => {
      const { recordingDeleteCommand } = await import("./commands/recordings");
      await recordingDeleteCommand(id, options);
    });

  adminRecordings
    .command("promote")
    .description("Promote a recording to a published mixtape (mint-or-reuse; idempotent)")
    .argument("[id]")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (id: string | undefined, options: { json: boolean }) => {
      const { recordingPromoteCommand } = await import("./commands/recordings");
      await recordingPromoteCommand(id, options);
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

  // `send_edition` → `admin newsletter send`. OPERATOR ONLY — the human send gate.
  // The Worker creates + sends the Resend broadcast and mints the number. A valid
  // AGENT token gets a 403, so the cron can't send.
  adminNewsletter
    .command("send")
    .description("Send an edition, OPERATOR only (Resend broadcast + mint the number)")
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

  // `delete_edition` → `admin newsletter delete`. OPERATOR ONLY — the hard delete that
  // pulls an edition (draft OR sent back-issue) from the archive. Deleting a sent one
  // reopens the self-healing window so its finds re-enter the next edition. --yes guards.
  adminNewsletter
    .command("delete")
    .description("Delete an edition (draft or sent). OPERATOR only; reopens the send window")
    .argument("[id]")
    .option("--yes", "Confirm the delete", false)
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (id: string | undefined, options: { json: boolean; yes: boolean }) => {
      const { newsletterDeleteCommand } = await import("./commands/newsletter");
      await runNewsletterDelete(id, options, newsletterDeleteCommand);
    });

  const adminLogbook = configureCommand(
    admin.command("logbook").description("Fluncle's Logbook (travelogue) commands"),
  );

  adminLogbook.action(() => {
    adminLogbook.outputHelp();
  });

  // `list_logbook_gaps` → `admin logbook gaps`. The nightly sweep's queue + material:
  // sector-days with findings but no entry, oldest first, each with its findings'
  // authoring fuel. Agent-allowed (admin tier).
  adminLogbook
    .command("gaps")
    .description("List sector-days with findings but no logbook entry (the sweep's worklist)")
    .option("--limit <limit>", "Max gaps to return")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (options: { json: boolean; limit?: string }) => {
      const { logbookGapsCommand } = await import("./commands/admin-logbook");
      await runLogbookGaps(options, logbookGapsCommand);
    });

  // `create_logbook_entry` → `admin logbook create`. The FILL-EMPTY-ONLY author the
  // on-box `fluncle-logbook` sweep drives with its agent token. A sector that already
  // has an entry is a no-op (`skipped: true`) — never a clobber. Agent-allowed (admin tier).
  adminLogbook
    .command("create")
    .description("Author a sector-day's entry (fills an empty sector only)")
    .argument("[sector]")
    .option("--title <text>", "The entry title")
    .option("--body <text>", "The entry body (markdown; [[logId]] figure tokens)")
    .option("--body-file <file>", "Read the body from a file (the sweep's path)")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (sector: string | undefined, options: LogbookWriteCliOptions) => {
      const { logbookCreateCommand } = await import("./commands/admin-logbook");
      await runLogbookWrite(sector, options, logbookCreateCommand);
    });

  // `update_logbook_entry` → `admin logbook update`. OPERATOR ONLY — the overwrite/edit
  // path that CAN replace a cron-authored entry (and stamps it operator-authored, so
  // the agent create thereafter treats it as sacred). A valid AGENT token gets a 403.
  adminLogbook
    .command("update")
    .description("Create or overwrite a sector-day's entry. OPERATOR only")
    .argument("[sector]")
    .option("--title <text>", "The entry title")
    .option("--body <text>", "The entry body (markdown; [[logId]] figure tokens)")
    .option("--body-file <file>", "Read the body from a file")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (sector: string | undefined, options: LogbookWriteCliOptions) => {
      const { logbookUpdateCommand } = await import("./commands/admin-logbook");
      await runLogbookWrite(sector, options, logbookUpdateCommand);
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

  // `triage_submission` → `admin submissions triage` (Convention B). Write the pre-chew
  // advisory verdict onto a PENDING submission (the on-box `fluncle-triage` sweep's
  // delivery step). AGENT tier: moves no approve/reject authority. `--verdict-file` is
  // the sweep's path (a claude-authored line, no shell-escaping); `--verdict` is inline.
  submissions
    .command("triage")
    .description("Write the pre-chew triage verdict onto a pending submission")
    .argument("[submissionId]")
    .option("--verdict <text>", "The triage verdict one-liner")
    .option("--verdict-file <file>", "Read the verdict from a file")
    .option("--json", "Print JSON", false)
    .action(
      async (
        submissionId: string | undefined,
        options: { json?: boolean; verdict?: string; verdictFile?: string },
      ) => {
        if (!submissionId) {
          throw new Error("Missing submission id for: triage");
        }

        const verdict = options.verdictFile
          ? readFileSync(options.verdictFile, "utf8")
          : options.verdict;

        if (!verdict || !verdict.trim()) {
          throw new Error(
            "Usage: fluncle admin submissions triage <submissionId> (--verdict <text> | --verdict-file <file>) [--json]",
          );
        }

        const { triageSubmissionCommand } = await import("./commands/submissions");
        await triageSubmissionCommand(submissionId, verdict, { json: options.json });
      },
    );

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

  // `backfill_*` ops → plural `backfills` group (Convention B).
  // `admin artists` — the artist-relationship epic's agent-tier commands: the social-identity
  // resolution sweep (`resolve`), driven by the on-box `fluncle-artist-sweep` cron.
  const artists = configureCommand(
    admin.command("artists").description("Artist entity + resolution commands"),
  );

  artists.action(() => {
    artists.outputHelp();
  });

  const backfill = configureCommand(
    admin.command("backfills").description("Backfill operator-only archives"),
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

  // `backfill_artists` → `admin backfills artists`. Back-fills the artist entity
  // tables (artists + track_artists) for existing findings that predate Unit 1.
  backfill
    .command("artists")
    .description("Back-fill the artist entity (artists + track_artists) for existing findings")
    .option("--dry-run", "Report which findings would be upserted without touching the DB", false)
    .option("--limit <limit>", "Max findings to process", "50")
    .option("--json", "Print JSON", false)
    .action(async (options: BackfillSyncOptions) => {
      const { backfillArtistsCommand } = await import("./commands/admin-artists");
      await runBackfillArtists(options, backfillArtistsCommand);
    });

  // `list_artists` + `resolve_artist` → `admin artists resolve` (Convention B). The
  // on-box `fluncle-artist-sweep` cron drives BOTH modes: `--queue` reads the resolve
  // worklist (artists awaiting resolution), and `resolve <artistId>` triggers the
  // Worker's MB url-rels walk + Firecrawl /v2/extract gap-fill for one artist.
  artists
    .command("resolve")
    .description("Resolve an artist's social identity (MB url-rels + Firecrawl gap-fill)")
    .argument("[artistId]")
    .option(
      "--queue",
      "Show the resolve worklist (artists awaiting resolution), oldest first",
      false,
    )
    .option("--limit <limit>", "Number of artists to show with --queue", "50")
    .option("--json", "Print JSON", false)
    .allowExcessArguments()
    .action(async (artistId: string | undefined, options: ArtistResolveOptions) => {
      // `--queue` is the resolve worklist view (artists awaiting resolution) — the
      // sweep's worklist. Otherwise resolve one artist's social identity.
      if (options.queue) {
        const { listArtistsCommand } = await import("./commands/admin-artists");
        await runArtistResolveQueue(options, listArtistsCommand);
        return;
      }

      const { resolveArtistCommand } = await import("./commands/admin-artists");
      await runArtistResolve(artistId, options, resolveArtistCommand);
    });

  // `migrate_*` ops → `admin migrations` group (Convention B). One-off, operator-run
  // data migrations. REF-05: move the archived 30s previews off the PUBLIC bucket
  // (a copyright exposure) into the PRIVATE one. Three modes, DRY-RUN BY DEFAULT:
  // (default) copy public → private; `--delete-public` sweeps the whole public
  // `analysis/previews/` prefix (incl. orphans no DB row points at) — run only after
  // a full copy; `--verify` is a read-only count of what remains under the prefix
  // (the operator's proof before/after the CDN purge). `--execute` performs a mutating
  // mode. Never copies and deletes in one pass.
  const migrations = configureCommand(
    admin.command("migrations").description("One-off operator data migrations"),
  );

  migrations.action(() => {
    migrations.outputHelp();
  });

  migrations
    .command("preview-archive")
    .description("Move archived 30s previews from the public bucket to the private one (REF-05)")
    .option("--execute", "Actually perform the migration (default is a dry run)", false)
    .option(
      "--delete-public",
      "Delete phase: sweep the whole public analysis/previews/ prefix (run only after a full copy)",
      false,
    )
    .option(
      "--verify",
      "Read-only: count the objects still under the public analysis/previews/ prefix",
      false,
    )
    .option("--limit <limit>", "Max findings/objects to process per pass", "50")
    .option("--json", "Print JSON", false)
    .action(async (options: MigratePreviewArchiveOptions) => {
      const { migratePreviewArchiveCommand } = await import("./commands/preview-migration");
      await runMigratePreviewArchive(options, migratePreviewArchiveCommand);
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
      "Usage: fluncle admin tracks observe <track_id|log_id> (--script <text> | --script-file <file>) [--voice-id <id>] [--duration-ms <ms>] [--context-note <text>] [--json]",
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
    force: options.force,
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
      "Usage: fluncle admin tracks context <track_id|log_id> [--query <text>] [--refresh] [--json]",
    );
  }

  const result = await trackContextCommand(idOrLogId, {
    query: options.query,
    refresh: options.refresh,
  });

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

async function runTrackNote(
  idOrLogId: string | undefined,
  options: TrackNoteOptions,
  trackNoteCommand: typeof import("./commands/track").trackNoteCommand,
): Promise<void> {
  const note = options.scriptFile ? readFileSync(options.scriptFile, "utf8") : options.script;

  if (!idOrLogId || !note || !note.trim()) {
    throw new Error(
      "Usage: fluncle admin tracks note <track_id|log_id> (--script <text> | --script-file <file>) [--json]",
    );
  }

  const result = await trackNoteCommand(idOrLogId, { note: note.trim() });

  if (options.json) {
    printJson(result);
    return;
  }

  if (result.skipped) {
    console.log(`A note is already on file for ${result.logId}. The operator's note stands.`);
    return;
  }

  console.log(`Authored the note for ${result.logId}:`);
  console.log(`  ${result.note}`);
}

// REF-05 — drive the public → private preview-bucket migration. Three modes:
// `--verify` (read-only count under the public prefix), `--delete-public` (the
// prefix sweep), else copy. `--limit` is the per-pass batch; the CLI loops the
// returned cursor until the phase's set is drained (nextCursor null), aggregating
// per-pass results. Dry-run unless `--execute` (ignored by the read-only verify).
async function runMigratePreviewArchive(
  options: MigratePreviewArchiveOptions,
  migratePreviewArchiveCommand: typeof import("./commands/preview-migration").migratePreviewArchiveCommand,
): Promise<void> {
  const limit = options.limit === undefined ? 50 : Number.parseInt(options.limit, 10);

  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Limit must be a positive integer");
  }

  // Verify wins over delete (it is read-only and safe); delete wins over the copy
  // default. `--execute` only matters for the mutating modes.
  const mode = options.verify ? "verify" : options.deletePublic ? "delete" : "copy";
  const dryRun = mode === "verify" ? true : !options.execute;

  // Verify is a single read-only pass: no cursor loop, no mutation.
  if (mode === "verify") {
    const result = await migratePreviewArchiveCommand({ dryRun: true, limit, mode });

    if (options.json) {
      printJson({ mode, ok: true, remaining: result.remaining, sampleKeys: result.sampleKeys });
      return;
    }

    console.log(`${result.remaining} object(s) remain under the public analysis/previews/ prefix.`);

    for (const key of result.sampleKeys) {
      console.log(`  ${key}`);
    }

    return;
  }

  const copied: Array<{ logId: string; newKey: string; oldKey: string; trackId: string }> = [];
  const deleted: Array<{ oldKey: string; trackId: string }> = [];
  const skipped: Array<{ reason: string; trackId: string }> = [];
  const failed: Array<{ error: string; trackId: string }> = [];
  let cursor: string | undefined;
  let remaining = 0;
  let blocked: string | null = null;

  // Loop the cursor until the phase is drained. The cursor advances monotonically
  // (DB track_id for copy, R2 list cursor for delete), so the loop always terminates.
  for (;;) {
    const result = await migratePreviewArchiveCommand({ cursor, dryRun, limit, mode });

    // A refusal (e.g. the delete sweep with legacy rows still uncopied) stops here.
    if (result.blocked) {
      blocked = result.blocked;
      remaining = result.remaining;
      break;
    }

    copied.push(...result.copied);
    deleted.push(...result.deleted);
    skipped.push(...result.skipped);
    failed.push(...result.failed);
    remaining = result.remaining;

    if (!options.json) {
      const verb = dryRun ? "would" : "did";
      console.log(
        `  …${mode} pass (${verb}): +${result.copiedCount} copied, +${result.deletedCount} deleted, ${result.skippedCount} skipped, ${result.failedCount} failed; ${result.remaining} remaining`,
      );
    }

    if (result.nextCursor === null) {
      break;
    }

    cursor = result.nextCursor;
  }

  if (options.json) {
    printJson({
      blocked,
      copied,
      copiedCount: copied.length,
      deleted,
      deletedCount: deleted.length,
      dryRun,
      failed,
      failedCount: failed.length,
      mode,
      ok: true,
      remaining,
      skipped,
      skippedCount: skipped.length,
    });
    return;
  }

  if (blocked) {
    console.log(`REFUSED (${blocked}): ${remaining} legacy row(s) still need copying first.`);
    return;
  }

  const done = mode === "delete" ? deleted.length : copied.length;
  const noun =
    mode === "delete" ? "public object(s) deleted" : "preview(s) copied to the private bucket";
  const prefix = dryRun ? "DRY RUN — would have: " : "";
  console.log(
    `${prefix}${done} ${noun}; ${skipped.length} skipped; ${failed.length} failed; ${remaining} still under the prefix.`,
  );

  for (const item of skipped) {
    if (item.reason === "private_copy_absent") {
      console.log(`  LEFT (no private copy) ${item.trackId}`);
    }
  }

  for (const item of failed) {
    console.log(`  FAILED ${item.trackId}: ${item.error}`);
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
  const skipped: string[] = [];
  let cursor: string | undefined;
  let dryRun = options.dryRun;
  let throttled = false;

  // The cap is on findings actually HANDLED (loved + failed); skips don't count, so
  // the loop keeps draining cursors past cooling-down findings until the cap is met
  // or the archive is exhausted (nextCursor null).
  while (loved.length + failed.length < limit) {
    const remaining = limit - (loved.length + failed.length);
    const result = await backfillLastfmCommand(remaining, options.dryRun, cursor);
    dryRun = result.dryRun;
    loved.push(...result.loved);
    failed.push(...result.failed);
    skipped.push(...result.skipped);

    if (!options.json) {
      const verb = result.dryRun ? "Would love" : "Loved";
      console.log(
        `  …${verb.toLowerCase()} ${result.lovedCount}; ${result.failedCount} failed; ${result.skippedCount} skipped`,
      );
    }

    if (result.rateLimited) {
      // Last.fm circuit breaker tripped (active rate-limiting). Stop looping the
      // cursor — re-firing it just grinds into the same wall until the cron's 120s
      // timeout; the next tick resumes from a fresh rate-limit window.
      throttled = true;
      break;
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
      rateLimited: throttled,
      skipped,
      skippedCount: skipped.length,
    });
    return;
  }

  const verb = dryRun ? "Would love" : "Loved";
  console.log(
    `${verb} ${loved.length} finding(s) on Last.fm; ${failed.length} failed; ${skipped.length} skipped.`,
  );

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
  const skipped: string[] = [];
  let cursor: string | undefined;
  let dryRun = options.dryRun;
  let throttled = false;

  // The cap is on findings actually HANDLED (resolved + unresolved); skips don't
  // count, so the loop keeps draining cursors past cooling-down/done findings until
  // the cap is met or the archive is exhausted (nextCursor null).
  while (resolved.length + unresolved.length < limit) {
    const remaining = limit - (resolved.length + unresolved.length);
    const result = await backfillDiscogsCommand(remaining, options.dryRun, cursor);
    dryRun = result.dryRun;
    resolved.push(...result.resolved);
    unresolved.push(...result.unresolved);
    skipped.push(...result.skipped);

    if (!options.json) {
      const verb = result.dryRun ? "would resolve" : "resolved";
      console.log(
        `  …${verb} ${result.resolvedCount}; ${result.unresolvedCount} unresolved; ${result.skippedCount} skipped`,
      );
    }

    if (result.rateLimited) {
      // Discogs circuit breaker tripped (active 429s). Stop looping the cursor —
      // re-firing it just grinds into the same wall until the cron's 120s timeout;
      // the next tick resumes from a fresh rate-limit window.
      throttled = true;
      break;
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
      rateLimited: throttled,
      resolved,
      resolvedCount: resolved.length,
      skipped,
      skippedCount: skipped.length,
      unresolved,
      unresolvedCount: unresolved.length,
    });
    return;
  }

  const verb = dryRun ? "Would resolve" : "Resolved";
  console.log(
    `${verb} ${resolved.length} Discogs release id(s); ${unresolved.length} unresolved; ${skipped.length} skipped.`,
  );

  for (const item of resolved) {
    const master = item.masterId ? ` (master ${item.masterId})` : "";
    console.log(`  ${item.logId}: release ${item.releaseId}${master}`);
  }
}

async function runBackfillArtists(
  options: BackfillSyncOptions,
  backfillArtistsCommand: typeof import("./commands/admin-artists").backfillArtistsCommand,
): Promise<void> {
  const limit = parseListLimit(options.limit);
  const upserted: string[] = [];
  const failed: Array<{ error: string; logId: string }> = [];
  const skipped: string[] = [];
  let cursor: string | undefined;
  let dryRun = options.dryRun;

  while (upserted.length + failed.length < limit) {
    const remaining = limit - (upserted.length + failed.length);
    const result = await backfillArtistsCommand(remaining, options.dryRun, cursor);
    dryRun = result.dryRun;
    upserted.push(...result.upserted);
    failed.push(...result.failed);
    skipped.push(...result.skipped);

    if (!options.json) {
      const verb = result.dryRun ? "would upsert" : "upserted";
      console.log(
        `  …${verb} ${result.upsertedCount}; ${result.failedCount} failed; ${result.skippedCount} skipped`,
      );
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
      ok: true,
      skipped,
      skippedCount: skipped.length,
      upserted,
      upsertedCount: upserted.length,
    });
    return;
  }

  const verb = dryRun ? "Would upsert" : "Upserted";
  console.log(
    `${verb} ${upserted.length} artist entity row(s); ${failed.length} failed; ${skipped.length} skipped.`,
  );

  for (const logId of upserted) {
    console.log(`  ${logId}`);
  }

  for (const item of failed) {
    console.log(`  ${item.logId}: ${item.error}`);
  }
}

// `admin artists resolve --queue`: the resolve worklist (artists awaiting social
// resolution, oldest first). One bounded page — the sweep reads this, then resolves
// each row. `--limit` caps the page (server-clamped to 50).
async function runArtistResolveQueue(
  options: ArtistResolveOptions,
  listArtistsCommand: typeof import("./commands/admin-artists").listArtistsCommand,
): Promise<void> {
  const limit = parseListLimit(options.limit);
  const result = await listArtistsCommand(limit ?? 50);

  if (options.json) {
    printJson({ artists: result.artists, ok: true });
    return;
  }

  if (result.artists.length === 0) {
    console.log("Resolved every artist. Nothing waiting on the sweep.");
    return;
  }

  const noun = result.artists.length === 1 ? "artist" : "artists";
  console.log(`${result.artists.length} ${noun} awaiting resolution, oldest first:`);

  for (const artist of result.artists) {
    console.log(`  ${artist.id}  ${artist.name}`);
  }
}

// `admin artists resolve <artistId>`: trigger the Worker's social resolution for one
// artist (MB url-rels walk + Firecrawl gap-fill). The sweep loops this over the queue.
async function runArtistResolve(
  artistId: string | undefined,
  options: ArtistResolveOptions,
  resolveArtistCommand: typeof import("./commands/admin-artists").resolveArtistCommand,
): Promise<void> {
  if (!artistId) {
    throw new Error("Usage: fluncle admin artists resolve <artist_id> [--json]");
  }

  const result = await resolveArtistCommand(artistId);

  if (options.json) {
    printJson(result);
    return;
  }

  if (result.rateLimited) {
    console.log(
      `MusicBrainz throttled the walk for ${artistId}. The sweep will swing back around.`,
    );
    return;
  }

  const mbid = result.mbid ?? "(no MusicBrainz match)";
  const noun = result.socialsCount === 1 ? "social" : "socials";
  console.log(`Resolved ${artistId}: mbid=${mbid}, ${result.socialsCount} ${noun}.`);

  for (const social of result.socials) {
    console.log(`  ${social.platform} (${social.source}): ${social.url}`);
  }

  if (result.wikidataQid) {
    console.log(`  wikidata: ${result.wikidataQid}`);
  }
}

async function runTrackVideo(
  idOrLogId: string | undefined,
  options: TrackVideoOptions,
  trackVideoCommand: typeof import("./commands/track").trackVideoCommand,
): Promise<void> {
  if (!idOrLogId) {
    throw new Error(
      "Missing id. Usage: fluncle admin tracks video <track_id|log_id> (--dir <dir> | --footage <file> [--footage-social <file>] [--footage-notext <file>] [--footage-landscape <file>] [--footage-landscape-social <file>] [--poster <file>] [--cover <file>] [--note <file>] [--composition <file>] [--props <file>] [--render <file>] [--intent <file>] [--metrics <file>] [--scene <file>] | --plate <file> [--plate-background <file>]) [--allow-partial]",
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
    footageLandscape: resolveFile(options.footageLandscape, "footage.landscape.mp4"),
    footageLandscapeSocial: resolveFile(
      options.footageLandscapeSocial,
      "footage.landscape.social.mp4",
    ),
    footageNotext: resolveFile(options.footageNotext, "footage.notext.mp4"),
    footageSocial: resolveFile(options.footageSocial, "footage.social.mp4"),
    intent: resolveFile(options.intent, "intent.json"),
    metrics: resolveFile(options.metrics, "metrics.json"),
    model: options.model,
    note: resolveFile(options.note, "note.txt"),
    plate: resolveFile(options.plate, "plate.png"),
    plateBackground: resolveFile(options.plateBackground, "plate.background.png"),
    poster: resolveFile(options.poster, "poster.jpg"),
    props: resolveFile(options.props, "props.json"),
    reasoning: options.reasoning,
    render: resolveFile(options.render, "render.json"),
    scene: resolveFile(options.scene, "scene.json"),
  };

  // A footage cut is required for the normal (full-bundle) upload; --allow-partial
  // lifts that for a deliberate partial refresh (e.g. poster-only). The plate-lane
  // PRE-upload (plates and nothing else — the upload-first order, before the
  // composition exists) is sanctioned as-is: no footage, no --allow-partial needed.
  const { isPlatesOnlyUpload } = await import("./commands/track");
  if (!files.footage && !options.allowPartial && !isPlatesOnlyUpload(files)) {
    throw new Error(
      "A footage cut is required (--footage <file>, or --dir containing footage.mp4). Pass --allow-partial for a deliberate partial refresh (e.g. poster-only), or upload plates alone (--plate/--plate-background) for the plate-lane pre-upload.",
    );
  }

  // Progress per file as the bytes go straight to R2 (suppressed under --json so
  // the output stays a single parseable object).
  const onProgress = options.json ? undefined : (message: string) => console.log(message);
  const result = await trackVideoCommand(idOrLogId, files, onProgress, {
    allowPartial: options.allowPartial,
  });

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

async function runTrackSocialCapture(
  options: TrackSocialOptions,
  trackSocialCaptureCommand: typeof import("./commands/track").trackSocialCaptureCommand,
): Promise<void> {
  const limit = options.limit === undefined ? undefined : Number.parseInt(options.limit, 10);

  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }

  const result = await trackSocialCaptureCommand(limit);

  if (options.json) {
    printJson(result);
    return;
  }

  if (result.captured.length === 0) {
    console.log(`Polled ${result.polled} pending post(s); nothing new to capture.`);
    return;
  }

  console.log(`Captured ${result.captured.length} post URL(s) from ${result.polled} polled:`);

  for (const post of result.captured) {
    console.log(`  ${post.platform}: ${post.url}`);
  }
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

async function runTrackGetAdmin(
  idOrLogId: string | undefined,
  options: JsonOptions,
  trackGetAdminCommand: typeof import("./commands/track").trackGetAdminCommand,
): Promise<void> {
  if (!idOrLogId) {
    throw new Error("Missing id. Usage: fluncle admin tracks get <track_id|log_id> [--json]");
  }

  const result = await trackGetAdminCommand(idOrLogId);

  if (options.json) {
    printJson(result);
    return;
  }

  const t = result.track;

  console.log(`${t.logId ? `${t.logId}  ` : ""}${t.artists.join(", ")} — ${t.title}`);
  console.log(
    [t.bpm ? `${t.bpm} bpm` : undefined, t.key, t.label, t.enrichmentStatus]
      .filter(Boolean)
      .join(" · "),
  );

  // The admin-only state a public list row hides — the reason this read exists over
  // `fluncle tracks get`: where it sits on the map, whether it's filmed and voiced.
  const placed = t.galaxy && t.vibeX !== undefined && t.vibeY !== undefined;
  console.log(
    `Placement: ${placed && t.galaxy ? `${t.galaxy.name} (${t.vibeX?.toFixed(2)}, ${t.vibeY?.toFixed(2)})` : "unplaced"}`,
  );
  console.log(
    `Video: ${
      t.videoUrl
        ? [t.videoSquaredAt ? "squared master" : "linked", t.videoVehicle]
            .filter(Boolean)
            .join(" · ")
        : "none (in the render queue)"
    }`,
  );
  console.log(
    `Observation: ${
      t.observationAudioUrl
        ? `voiced${t.observationDurationMs ? ` · ${Math.round(t.observationDurationMs / 1000)}s` : ""}`
        : "none"
    }`,
  );
  console.log(`Note: ${t.note ? t.note : "none"}`);
  console.log(`Spotify: ${t.spotifyUrl}`);

  if (t.logPageUrl) {
    console.log(`Log: ${t.logPageUrl}`);
  }
}

// Parse a `--embedding` / `--embedding-file` value into a MuQ vector. `undefined`
// (the flag absent) stays undefined; anything present must be a JSON array of finite
// numbers (the server enforces the exact 1024-d width). Fails fast so a truncated
// on-box MuQ run errors locally instead of round-tripping to a 400.
function parseEmbeddingArg(raw: string | undefined): number[] | undefined {
  if (raw === undefined) {
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid --embedding: expected a JSON array of 1024 floats");
  }

  if (
    !Array.isArray(parsed) ||
    parsed.some((value) => typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new Error("Invalid --embedding: expected a JSON array of 1024 finite numbers");
  }

  return parsed as number[];
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

  // BPM/key analysis provenance (RFC bpm-key-accuracy). The confidences parse to numbers
  // (fail fast on garbage); analyzedFrom is validated to the two-value enum so a typo can't
  // silently poison the capture re-derive predicate; the sources + analyzedAt pass through.
  const bpmConfidence =
    options.bpmConfidence === undefined ? undefined : Number(options.bpmConfidence);

  if (bpmConfidence !== undefined && !Number.isFinite(bpmConfidence)) {
    throw new Error(`Invalid --bpm-confidence: ${options.bpmConfidence}`);
  }

  const keyConfidence =
    options.keyConfidence === undefined ? undefined : Number(options.keyConfidence);

  if (keyConfidence !== undefined && !Number.isFinite(keyConfidence)) {
    throw new Error(`Invalid --key-confidence: ${options.keyConfidence}`);
  }

  if (
    options.analyzedFrom !== undefined &&
    options.analyzedFrom !== "full" &&
    options.analyzedFrom !== "preview"
  ) {
    throw new Error(`Invalid --analyzed-from: ${options.analyzedFrom} (expected full or preview)`);
  }

  // The MuQ embedding: read from a file (--embedding-file, the box orchestrator's
  // path — a 1024-float array is large) or inline (--embedding), parse to a number
  // array, and let the server validate the 1024-d shape. An empty string clears it.
  const embeddingRaw = options.embeddingFile
    ? readFileSync(options.embeddingFile, "utf8")
    : options.embedding;
  const embedding = parseEmbeddingArg(embeddingRaw);

  const result = await trackUpdateCommand(trackId, {
    analyzedAt: options.analyzedAt,
    analyzedFrom: options.analyzedFrom,
    bpm,
    bpmConfidence,
    bpmSource: options.bpmSource,
    embedding,
    features: options.features,
    key: options.key,
    keyConfidence,
    keySource: options.keySource,
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

async function runTrackRequeueVideo(
  idOrLogId: string | undefined,
  options: JsonOptions,
  trackRequeueVideoCommand: typeof import("./commands/track").trackRequeueVideoCommand,
): Promise<void> {
  if (!idOrLogId) {
    throw new Error("Missing id. Usage: fluncle admin tracks requeue-video <track_id|log_id>");
  }

  const result = await trackRequeueVideoCommand(idOrLogId);

  if (options.json) {
    printJson(result);
    return;
  }

  console.log(
    result.alreadyClear
      ? `${result.logId} already had no video. Nothing to clear.`
      : `Cleared the video for ${result.logId}. It's back on the render queue (and off radio until re-rendered).`,
  );
}

async function runTrackPurgeVideo(
  idOrLogId: string | undefined,
  options: JsonOptions,
  trackPurgeVideoCommand: typeof import("./commands/track").trackPurgeVideoCommand,
): Promise<void> {
  if (!idOrLogId) {
    throw new Error("Missing id. Usage: fluncle admin tracks purge-video <track_id|log_id>");
  }

  const result = await trackPurgeVideoCommand(idOrLogId);

  if (options.json) {
    printJson(result);
    return;
  }

  console.log(
    result.noVideo
      ? `${result.logId} has no video. Nothing to purge.`
      : `Purging the stale renditions for ${result.logId} from the edge. The next play picks up the fresh render.`,
  );
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

async function runMixtapeResync(
  idOrLogId: string | undefined,
  options: MixtapeResyncOptions,
  mixtapeResyncCommand: typeof import("./commands/mixtapes").mixtapeResyncCommand,
): Promise<void> {
  if (!idOrLogId) {
    throw new Error("Missing mixtape id. Usage: fluncle admin mixtapes resync <idOrLogId>");
  }

  const onProgress = options.json ? () => {} : (message: string) => console.log(message);
  const result = await mixtapeResyncCommand(idOrLogId, options, onProgress);

  if (options.json) {
    printJson(result);
    return;
  }

  const links = result.results.map((r) => `  ${r.platform}: ${r.url}`).join("\n");
  console.log(`Re-synced ${result.logId} (fluncle://${result.logId}).\n${links}`);
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
    const status = mixtape.status ?? "distributing";
    const coordinate = mixtape.logId ?? "unminted";
    console.log(`${coordinate}\t${status}\t${mixtape.memberCount} bangers\t${mixtape.title}`);
  }
}

async function runClipsList(
  options: ClipListOptions,
  clipsListCommand: typeof import("./commands/clips").clipsListCommand,
  clipPostsListCommand: typeof import("./commands/clips").clipPostsListCommand,
): Promise<void> {
  const [clips, posts] = await Promise.all([
    clipsListCommand({ recordingId: options.recording, status: options.status }),
    // The drip-feed rows, merged onto each clip below. Best-effort — a read failure must
    // not blank the clip list; fall back to no drip column.
    clipPostsListCommand().catch(() => [] as Awaited<ReturnType<typeof clipPostsListCommand>>),
  ]);
  const dripByClip = new Map(posts.map((post) => [post.clipId, post]));

  if (options.json) {
    printJson({
      clips: clips.map((clip) => ({ ...clip, drip: dripByClip.get(clip.id) })),
      ok: true,
    });
    return;
  }

  if (clips.length === 0) {
    console.log("No clips.");
    return;
  }

  for (const clip of clips) {
    const source = clip.recordingId ?? "—";
    const post = dripByClip.get(clip.id);
    // The drip column: e.g. `scheduled 2026-07-06T…` / `posted` / `failed`, or `—` when a
    // clip has no drip row (never auto-queued, or unscheduled).
    const drip = post ? `${post.status} ${post.scheduledFor}` : "—";
    console.log(
      `${clip.id}\t${clip.status}\t${source}\t${clip.inMs}-${clip.outMs}ms\tx=${clip.xOffset}\t${drip}`,
    );
  }
}

async function runClipsCut(
  clipId: string | undefined,
  options: { json: boolean },
  clipCutCommand: typeof import("./commands/clips").clipCutCommand,
): Promise<void> {
  if (!clipId) {
    throw new Error("Missing clip id. Usage: fluncle admin clips cut <clipId>");
  }

  const onProgress = options.json ? () => {} : (message: string) => console.log(message);
  const result = await clipCutCommand(clipId, onProgress);

  if (options.json) {
    printJson({ ok: true, ...result });
    return;
  }

  console.log(
    `Cut ${result.clipId} → ${result.url} (${(result.sizeBytes / 1_000_000).toFixed(1)} MB).`,
  );
}

async function runClipsSchedule(
  clipId: string | undefined,
  options: { at: string; json: boolean },
  clipScheduleCommand: typeof import("./commands/clips").clipScheduleCommand,
): Promise<void> {
  if (!clipId) {
    throw new Error("Missing clip id. Usage: fluncle admin clips schedule <clipId> --at <iso>");
  }

  const post = await clipScheduleCommand(clipId, options.at);

  if (options.json) {
    printJson({ ok: true, post });
    return;
  }

  console.log(`Scheduled ${post.clipId} for ${post.scheduledFor}.`);
}

async function runClipsDripPause(
  paused: boolean,
  options: { json: boolean },
  clipDripPauseCommand: typeof import("./commands/clips").clipDripPauseCommand,
): Promise<void> {
  const result = await clipDripPauseCommand(paused);

  if (options.json) {
    printJson({ ok: true, paused: result });
    return;
  }

  console.log(result ? "The drip-feed is paused." : "The drip-feed is running.");
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

  const coordinate = mixtape.logId ?? "unminted";
  const status = mixtape.status ?? "distributing";
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
      : `Sent edition #${number}. It's out to the list and in the archive.`,
  );
}

async function runNewsletterDelete(
  id: string | undefined,
  options: { json: boolean; yes: boolean },
  newsletterDeleteCommand: typeof import("./commands/newsletter").newsletterDeleteCommand,
): Promise<void> {
  if (!id) {
    throw new Error("Missing edition id. Usage: fluncle admin newsletter delete <id> --yes");
  }

  if (!options.yes) {
    throw new Error("Pass --yes to confirm. This hard-deletes the edition (draft or sent).");
  }

  const result = await newsletterDeleteCommand(id);

  if (options.json) {
    printJson({ ...result, ok: true });
    return;
  }

  console.log(`Deleted edition ${result.id}. The send window reopens to cover its finds.`);
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

type LogbookWriteCliOptions = {
  body?: string;
  bodyFile?: string;
  json: boolean;
  title?: string;
};

async function runLogbookGaps(
  options: { json: boolean; limit?: string },
  logbookGapsCommand: typeof import("./commands/admin-logbook").logbookGapsCommand,
): Promise<void> {
  const limit = options.limit === undefined ? undefined : Number.parseInt(options.limit, 10);
  const gaps = await logbookGapsCommand(
    limit !== undefined && Number.isFinite(limit) ? limit : undefined,
  );

  if (options.json) {
    printJson({ gaps, ok: true });
    return;
  }

  if (gaps.length === 0) {
    console.log("No gaps — every past sector-day with findings has an entry.");
    return;
  }

  for (const gap of gaps) {
    console.log(`sector ${gap.sector}\t${gap.date.slice(0, 10)}\t${gap.findings.length} findings`);
  }
}

async function runLogbookWrite(
  sector: string | undefined,
  options: LogbookWriteCliOptions,
  writeCommand:
    | typeof import("./commands/admin-logbook").logbookCreateCommand
    | typeof import("./commands/admin-logbook").logbookUpdateCommand,
): Promise<void> {
  if (!sector) {
    throw new Error("Missing sector for the logbook entry");
  }

  const result = await writeCommand(sector, {
    body: options.body,
    bodyFile: options.bodyFile,
    title: options.title,
  });

  if (options.json) {
    printJson(result);
    return;
  }

  const skipped = "skipped" in result && result.skipped;
  console.log(
    skipped
      ? `sector ${result.entry.sector}: an entry already stands — no-op (${result.entry.generatedBy})`
      : `sector ${result.entry.sector}: ${result.entry.title}`,
  );
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

async function runArtists(
  slug: string | undefined,
  options: JsonOptions,
  commands: {
    artistsGetCommand: typeof import("./commands/artists").artistsGetCommand;
    artistsListCommand: typeof import("./commands/artists").artistsListCommand;
  },
): Promise<void> {
  if (slug) {
    const artist = await commands.artistsGetCommand(slug);

    if (options.json) {
      printJson({ artist, ok: true });
      return;
    }

    console.log(`${artist.name}  (${artist.slug})`);
    console.log(`Findings: ${artist.findingCount}`);

    if (artist.spotifyUrl) {
      console.log(`Spotify: ${artist.spotifyUrl}`);
    }

    return;
  }

  const artists = await commands.artistsListCommand();

  if (options.json) {
    printJson({ artists, ok: true });
    return;
  }

  if (artists.length === 0) {
    console.log("No artists in the archive yet.");
    return;
  }

  for (const a of artists) {
    console.log(
      `${a.name.padEnd(40)} ${String(a.findingCount).padStart(3)} finding${a.findingCount === 1 ? "" : "s"}`,
    );
  }
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

// Resolve the tri-state key filter from the two accepted forms: `--no-key`
// (Commander sets `key === false`) or `--has-key true|false`. Absent both ⇒
// undefined (no filter — list everything). `--no-key` wins if both are given.
function resolveHasKey(options: AdminTracksListOptions): boolean | undefined {
  if (options.key === false) {
    return false;
  }

  if (options.hasKey === "false") {
    return false;
  }

  if (options.hasKey === "true") {
    return true;
  }

  return undefined;
}

async function runAdminTracksList(
  options: AdminTracksListOptions,
  listCommand: typeof import("./commands/admin-tracks").listCommand,
): Promise<void> {
  // `--all` fetches the entire catalogue by paging past the per-request 100-row cap
  // (listCommand pages via cursor until the archive is exhausted); otherwise the
  // explicit `--limit` is parsed and clamped to 1-100.
  const limit = options.all ? Number.POSITIVE_INFINITY : parseListLimit(options.limit);
  const order = options.order === "asc" ? "asc" : "desc";
  const hasKey = resolveHasKey(options);
  const tracks = await listCommand({ hasKey, limit, order });

  if (options.json) {
    printJson({ ok: true, tracks });
    return;
  }

  if (tracks.length === 0) {
    const scope = hasKey === false ? " missing a key" : hasKey === true ? " with a key" : "";
    console.log(`No findings${scope}.`);
    return;
  }

  const { trackRows } = await import("./format");
  const scope =
    hasKey === false ? " missing a musical key" : hasKey === true ? " with a musical key" : "";
  const noun = tracks.length === 1 ? "finding" : "findings";
  console.log(`${tracks.length} ${noun}${scope}:`);
  console.log(trackRows(tracks).join("\n"));
}

async function runAdminAttention(
  options: JsonOptions,
  attentionQueueCommand: typeof import("./commands/admin-attention").attentionQueueCommand,
): Promise<void> {
  const queue = await attentionQueueCommand();

  if (options.json) {
    printJson({ attention: queue, ok: true });
    return;
  }

  const { attentionQueueLines } = await import("./commands/admin-attention");
  console.log(attentionQueueLines(queue).join("\n"));
}

async function runAdminQueue(
  options: AdminQueueOptions,
  queueCommand: typeof import("./commands/admin-tracks").queueCommand,
): Promise<void> {
  const limit = parseListLimit(options.limit);
  const tracks = await queueCommand(limit, {
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
  options: AdminListOptions & { retryEmpty?: boolean },
  contextQueueCommand: typeof import("./commands/admin-tracks").contextQueueCommand,
): Promise<void> {
  const limit = parseListLimit(options.limit);
  // `--retry-empty` widens the worklist to also re-pick CONFIRMED-EMPTY finds (the
  // occasional widen-the-net pass); off by default keeps the routine sweep narrow.
  const retryEmpty = options.retryEmpty === true;
  const tracks = await contextQueueCommand(limit, retryEmpty);

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
  const scope = retryEmpty ? " (incl. empty retries)" : "";
  console.log(`${tracks.length} ${noun} missing field notes${scope}, oldest first:`);
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

async function runAdminNoteQueue(
  options: AdminListOptions,
  noteQueueCommand: typeof import("./commands/admin-tracks").noteQueueCommand,
): Promise<void> {
  const limit = parseListLimit(options.limit);
  const tracks = await noteQueueCommand(limit);

  if (options.json) {
    printJson({
      ok: true,
      tracks,
    });
    return;
  }

  if (tracks.length === 0) {
    console.log("Every context'd finding has a note. Nothing waiting on the uncle's words.");
    return;
  }

  const { trackRows } = await import("./format");
  const noun = tracks.length === 1 ? "finding" : "findings";
  console.log(`${tracks.length} ${noun} awaiting a note, oldest first:`);
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

async function runAdminEmbedQueue(
  options: AdminListOptions,
  embedQueueCommand: typeof import("./commands/admin-tracks").embedQueueCommand,
): Promise<void> {
  const limit = parseListLimit(options.limit);
  const tracks = await embedQueueCommand(limit);

  if (options.json) {
    printJson({
      ok: true,
      tracks,
    });
    return;
  }

  if (tracks.length === 0) {
    console.log("Nothing awaiting an embedding. Every finding is embedded.");
    return;
  }

  const { trackRows } = await import("./format");
  const noun = tracks.length === 1 ? "finding" : "findings";
  console.log(`${tracks.length} ${noun} needing an audio embedding, oldest first:`);
  console.log(trackRows(tracks).join("\n"));
}

async function runAdminCaptureQueue(
  options: AdminListOptions,
  captureQueueCommand: typeof import("./commands/admin-tracks").captureQueueCommand,
): Promise<void> {
  const limit = parseListLimit(options.limit);
  const tracks = await captureQueueCommand(limit);

  if (options.json) {
    printJson({
      ok: true,
      tracks,
    });
    return;
  }

  if (tracks.length === 0) {
    console.log("Nothing awaiting a capture. Every finding has its full song.");
    return;
  }

  const { trackRows } = await import("./format");
  const noun = tracks.length === 1 ? "finding" : "findings";
  console.log(`${tracks.length} ${noun} needing a full-song capture, newest first:`);
  console.log(trackRows(tracks).join("\n"));
}

// The whole-archive walk cap. Absent `--limit` drains the entire archive (the repair is
// meant to sweep everything); an explicit `--limit` (any positive integer) bounds a
// pilot/test pass. Distinct from `parseListLimit`'s 1..100 worklist clamp — this walks the
// cursor chain to the end.
const REQUEUE_ANALYSIS_ARCHIVE_CAP = 1_000_000;

function parseRequeueAnalysisLimit(value: string | undefined): number {
  if (value === undefined) {
    return REQUEUE_ANALYSIS_ARCHIVE_CAP;
  }

  const limit = Number.parseInt(value, 10);

  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Limit must be a positive integer");
  }

  return limit;
}

async function runAdminRequeueAnalysis(
  options: AdminRequeueAnalysisOptions,
  requeueAnalysisCommand: typeof import("./commands/admin-tracks").requeueAnalysisCommand,
): Promise<void> {
  const max = parseRequeueAnalysisLimit(options.limit);
  const result = await requeueAnalysisCommand({ apply: options.apply === true, max });

  if (options.json) {
    printJson({ ok: true, ...result });
    return;
  }

  const { coordinate } = await import("./format");
  const staleCount = result.withSourceAudio.length + result.withoutSourceAudio.length;

  if (staleCount === 0) {
    console.log("Nothing to re-queue. Every finding's BPM/key was analyzed from full audio.");
    return;
  }

  const describe = (row: import("./commands/admin-tracks").RequeueAnalysisRow): string => {
    const coord = coordinate({ logId: row.logId });
    const bpm = row.bpm ? `${row.bpm} bpm` : "no bpm";
    const key = row.key ?? "no key";
    const from = row.analyzedFrom ?? "legacy/null";
    return `  ${coord}  ${row.trackId}  ${row.title} — ${bpm}, ${key} (from ${from})`;
  };

  console.log(
    `${staleCount} finding${staleCount === 1 ? "" : "s"} with preview-grade BPM/key (scanned ${result.scanned}):`,
  );

  if (result.withSourceAudio.length > 0) {
    console.log(
      `\nCaptured full song on file — re-derives from full audio (${result.withSourceAudio.length}):`,
    );
    console.log(result.withSourceAudio.map(describe).join("\n"));
  }

  if (result.withoutSourceAudio.length > 0) {
    console.log(
      `\nNo captured full song — re-derives from the 30s preview, still an upgrade with the fixed estimator (${result.withoutSourceAudio.length}):`,
    );
    console.log(result.withoutSourceAudio.map(describe).join("\n"));
  }

  // The gate: the dry-run diff review. Keys previously written by the operator's Rekordbox
  // key-backfill carry NO legacy provenance (they predate these columns → analyzedFrom NULL),
  // so they read as preview-grade here and a re-enrich MAY overwrite them. Eyeball the list.
  console.log(
    "\nCaveat: keys backfilled from Rekordbox are indistinguishable from DSP keys (no legacy" +
      " provenance) and a re-enrichment may overwrite them. This dry-run diff is the gate —" +
      " review it before applying.",
  );

  if (!result.applied) {
    console.log(`\nDry-run — nothing flipped. Re-run with --apply to re-queue all ${staleCount}.`);
    return;
  }

  console.log(`\nApplied — re-queued ${result.requeued.length} of ${staleCount}.`);

  if (result.failed.length > 0) {
    console.log(`${result.failed.length} failed:`);
    console.log(result.failed.map((entry) => `  ${entry.trackId}: ${entry.error}`).join("\n"));
    process.exitCode = 1;
  }
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

async function runStatus(
  options: JsonOptions,
  statusCommand: typeof import("./commands/status").statusCommand,
): Promise<void> {
  const snapshot = await statusCommand();

  if (options.json) {
    printJson({
      ok: true,
      ...snapshot,
    });
    return;
  }

  const { statusLines } = await import("./commands/status");
  console.log(statusLines(snapshot).join("\n"));
}

async function runMe(
  options: JsonOptions,
  meCommand: typeof import("./commands/me").meCommand,
): Promise<void> {
  const me = await meCommand();

  if (options.json) {
    printJson({ ok: true, ...me });
    return;
  }

  console.log(me.name);
  console.log(
    [
      `${me.collectedCount} ${me.collectedCount === 1 ? "finding" : "findings"} collected`,
      `${me.wins} ${me.wins === 1 ? "win" : "wins"}`,
      `${me.deaths} ${me.deaths === 1 ? "death" : "deaths"}`,
    ].join(" · "),
  );
  console.log(`Aboard since ${new Date(me.joinedAt).toLocaleDateString()}`);
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
  "--analyzed-at",
  "--analyzed-from",
  "--bpm",
  "--bpm-confidence",
  "--bpm-source",
  "--composition",
  "--cover",
  "--dir",
  "--duration-ms",
  "--features",
  "--file",
  "--footage",
  "--footage-landscape",
  "--footage-landscape-social",
  "--footage-notext",
  "--footage-social",
  "--from",
  "--intent",
  "--key",
  "--key-confidence",
  "--key-source",
  "--limit",
  "--metrics",
  "--mime",
  "--note",
  "--plate",
  "--plate-background",
  "--platform",
  "--poster",
  "--props",
  "--query",
  "--recorded-at",
  "--render",
  "--scene",
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
  fluncle status [--json]              How Fluncle's services are holding up
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
