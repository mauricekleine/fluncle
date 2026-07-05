// set-lifecycle server routes — the post-set ritual's control plane. The reads
// (the shelf, the scan-roots scan) and the mutations (attach cues, promote) go
// through the daemon's in-process admin client; the heavy, local-direct actions
// (upload a take, derive cues, export a plan, distribute) spawn child processes
// via the run registry and stream to the drawer. The multi-GB rule is satisfied
// by construction: the upload + distribute children are the operator's own
// process class, spawned straight off the daemon, never proxied.
//
// Every operator-supplied path that reaches a spawn is FENCED (fence.ts): it
// must realpath-resolve inside the scan roots (~/Movies + FLUNCLE_HELM_MEDIA_DIRS)
// or the request is refused before any argv exists.

import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { type RunStartedResponse } from "../../contract";
import { json } from "../../server/features";
import { type RunStreamedOptions } from "../../server/runs";
import { type HelmApp } from "../types";
import { parseDeriveCuesOutput } from "./cues";
import { fenceMediaPath, mediaRoots } from "./fence";
import {
  isMasterAudioFile,
  isSetVideoFile,
  type MovieEntry,
  parseFfprobeDurationMs,
  sortMoviesNewestFirst,
} from "./scan";

// The repo root, five levels up from this file (…/apps/helm/src/features/set-lifecycle).
// The CLI entry + the Rekordbox scripts are resolved from it so a spawn survives
// launchd's minimal cwd (the daemon may be started windowless at login).
const REPO_ROOT = resolve(import.meta.dir, "../../../../..");
const CLI_ENTRY = resolve(REPO_ROOT, "apps/cli/src/cli.ts");
const DERIVE_CUES_SCRIPT = resolve(
  REPO_ROOT,
  "packages/skills/fluncle-mixtapes/scripts/rekordbox-derive-cues.py",
);
const PLAN_EXPORT_SCRIPT = resolve(
  REPO_ROOT,
  "packages/skills/fluncle-mixtapes/scripts/rekordbox-plan-export.py",
);

const MOVIES_SCAN_LIMIT = 16;

// The hardened run registry (feat/helm-shell) spawns children with a least-
// privilege env and honours `adminToken: true` for the legs that genuinely need
// the CLI credentials. All four spawn legs here qualify, deliberately: upload +
// distribute ARE the `fluncle` CLI, and the Rekordbox derive/plan scripts shell
// out to the `fluncle` CLI themselves. Typed as an intersection so this unit
// also stands alone on the pre-hardening shell, where the flag is simply inert.
type StreamedOptions = RunStreamedOptions & { adminToken?: boolean };

/** The deadpan 400 for a path the fence refused. */
function pathRefused(): Response {
  return json(
    {
      code: "path_outside_roots",
      message: "That file is outside the scan roots. The helm ships only what the scan can see.",
    },
    400,
  );
}

// Absolute tool paths survive launchd's minimal PATH; fall back to the bare name
// (a login shell resolves it) when Homebrew isn't where we expect.
function firstExisting(candidates: string[], fallback: string): string {
  return candidates.find((candidate) => existsSync(candidate)) ?? fallback;
}

const uvBin = (): string => firstExisting(["/opt/homebrew/bin/uv", "/usr/local/bin/uv"], "uv");
const ffprobeBin = (): string =>
  firstExisting(["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"], "ffprobe");
const fluncleBin = (): string =>
  firstExisting(["/opt/homebrew/bin/fluncle", "/usr/local/bin/fluncle"], "fluncle");

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await req.json();

    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function requireString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];

  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Run an admin-client call, turning a thrown CliError into a JSON failure. */
async function guarded(run: () => Promise<unknown>): Promise<Response> {
  try {
    return json(await run());
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : "admin_error";
    const message = error instanceof Error ? error.message : "The admin API refused it.";

    return json({ code, message }, 502);
  }
}

/** Duration (ms) off an ffprobe header read; absent on any failure. */
async function probeDurationMs(path: string): Promise<number | undefined> {
  try {
    const proc = Bun.spawn(
      [ffprobeBin(), "-v", "quiet", "-print_format", "json", "-show_format", path],
      { stderr: "ignore", stdin: "ignore", stdout: "pipe" },
    );
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    return parseFfprobeDurationMs(output);
  } catch {
    return undefined;
  }
}

/** Stat each scan root's files, keeping only those a predicate admits. */
async function scanMasters(predicate: (name: string) => boolean): Promise<MovieEntry[]> {
  const entries: MovieEntry[] = [];

  for (const dir of mediaRoots()) {
    let names: string[];

    try {
      names = await readdir(dir);
    } catch {
      continue;
    }

    const stated = await Promise.all(
      names.filter(predicate).map(async (name): Promise<MovieEntry | undefined> => {
        const path = join(dir, name);

        try {
          const info = await stat(path);

          return { modifiedMs: info.mtimeMs, name, path, sizeBytes: info.size };
        } catch {
          return undefined;
        }
      }),
    );

    entries.push(...stated.filter((entry): entry is MovieEntry => entry !== undefined));
  }

  return sortMoviesNewestFirst(entries).slice(0, MOVIES_SCAN_LIMIT);
}

export function registerRoutes(app: HelmApp): void {
  // The shelf — every recording, newest first, mapped to the lifecycle board panel-side.
  app.get("/api/set-lifecycle/recordings", () =>
    guarded(() => app.context.admin.get("/api/admin/recordings")),
  );

  // The scan-roots scan (~/Movies + FLUNCLE_HELM_MEDIA_DIRS) — recent captures
  // (with duration) + audio masters (for distribute).
  app.get("/api/set-lifecycle/masters", async () => {
    const [videos, audios] = await Promise.all([
      scanMasters(isSetVideoFile),
      scanMasters(isMasterAudioFile),
    ]);
    const videosWithDuration = await Promise.all(
      videos.map(async (video) => ({ ...video, durationMs: await probeDurationMs(video.path) })),
    );

    return json({ audios, videos: videosWithDuration });
  });

  // Upload a take (M5) — spawn the CLI create, local-direct, streamed to the drawer.
  // The path is fenced: only a file the scan roots can see ever reaches the argv.
  app.post("/api/set-lifecycle/upload", async (req) => {
    const body = await readJsonBody(req);
    const path = requireString(body, "path");
    const title = requireString(body, "title");
    const recordedAt = requireString(body, "recordedAt");

    if (!path || !title) {
      return json(
        { code: "missing_fields", message: "A take needs a file path and a title." },
        400,
      );
    }

    const fenced = fenceMediaPath(path);

    if (!fenced.ok) {
      return pathRefused();
    }

    const argv = [
      process.execPath,
      CLI_ENTRY,
      "admin",
      "recordings",
      "create",
      "--video",
      fenced.path,
      "--title",
      title,
      ...(recordedAt ? ["--recorded-at", recordedAt] : []),
      "--json",
    ];
    const opts: StreamedOptions = {
      adminToken: true,
      cwd: REPO_ROOT,
      feature: "set-lifecycle",
      title: `upload: ${title}`,
    };
    const { runId } = app.context.runs.runStreamed(argv, opts);
    const started: RunStartedResponse = { runId };

    return json(started);
  });

  // Derive cues from Rekordbox (M2) — dry-run --json, streamed; the parsed cues are
  // read back off the completed run and attached separately (below).
  app.post("/api/set-lifecycle/derive-cues", async (req) => {
    const body = await readJsonBody(req);
    const session = requireString(body, "session");

    const argv = [
      uvBin(),
      "run",
      DERIVE_CUES_SCRIPT,
      "--json",
      "--fluncle-bin",
      fluncleBin(),
      ...(session ? ["--session", session] : []),
    ];
    const opts: StreamedOptions = {
      adminToken: true,
      cwd: REPO_ROOT,
      feature: "set-lifecycle",
      title: session ? `derive cues: ${session}` : "derive cues",
    };
    const { runId } = app.context.runs.runStreamed(argv, opts);
    const started: RunStartedResponse = { runId };

    return json(started);
  });

  // Read a completed derive-cues run's stdout and return the parsed cue set. 409
  // while it is still reading Rekordbox; 422 if it printed no cues (a failed run).
  app.get("/api/set-lifecycle/runs/:runId/cues", (_req, params) => {
    const run = app.context.runs.get("set-lifecycle", params.runId ?? "");

    if (!run) {
      return json({ code: "not_found", message: "No such derivation run on this station." }, 404);
    }

    if (run.status === "running") {
      return json(
        { code: "still_running", message: "The derivation is still reading Rekordbox." },
        409,
      );
    }

    const stdout = run.lines
      .filter((line) => line.stream === "stdout")
      .map((line) => line.text)
      .join("\n");

    try {
      return json({ ok: true, ...parseDeriveCuesOutput(stdout) });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unparseable";

      return json(
        {
          code: "unparseable",
          message: `The derivation printed no cues (${detail}). Read the run log.`,
        },
        422,
      );
    }
  });

  // Attach the derived cues to a selected take (replace_recording_cues, operator tier).
  app.post("/api/set-lifecycle/recordings/:recordingId/cues", async (req, params) => {
    const recordingId = params.recordingId ?? "";
    const body = await readJsonBody(req);
    const cues = body.cues;

    if (!Array.isArray(cues) || cues.length === 0) {
      return json({ code: "no_cues", message: "Nothing to attach — the cue set is empty." }, 400);
    }

    return guarded(() =>
      app.context.admin.put(`/api/admin/recordings/${encodeURIComponent(recordingId)}/cues`, {
        cues,
      }),
    );
  });

  // Promote a take → a minted mixtape (promote_recording, operator tier, idempotent).
  app.post("/api/set-lifecycle/recordings/:recordingId/promote", (_req, params) =>
    guarded(() =>
      app.context.admin.post(
        `/api/admin/recordings/${encodeURIComponent(params.recordingId ?? "")}/promote`,
      ),
    ),
  );

  // Export a plan to Rekordbox + Beatport + m3u8 (M2) — writes master.db, streamed.
  app.post("/api/set-lifecycle/plan-export", async (req) => {
    const body = await readJsonBody(req);
    const planId = requireString(body, "planId");

    if (!planId) {
      return json({ code: "missing_plan", message: "A plan id is required to export." }, 400);
    }

    const argv = [
      uvBin(),
      "run",
      PLAN_EXPORT_SCRIPT,
      planId,
      "--fluncle-bin",
      fluncleBin(),
      "--yes",
      "--json",
    ];
    const opts: StreamedOptions = {
      adminToken: true,
      cwd: REPO_ROOT,
      feature: "set-lifecycle",
      title: `export plan: ${planId}`,
    };
    const { runId } = app.context.runs.runStreamed(argv, opts);
    const started: RunStartedResponse = { runId };

    return json(started);
  });

  // Distribute a promoted mixtape (M5) — spawn the multi-GB push, local-direct, streamed.
  app.post("/api/set-lifecycle/distribute", async (req) => {
    const body = await readJsonBody(req);
    const logId = requireString(body, "logId");
    const video = requireString(body, "video");
    const audio = requireString(body, "audio");

    if (!logId) {
      return json(
        { code: "missing_log_id", message: "A promoted mixtape's Log ID is required." },
        400,
      );
    }

    if (!video && !audio) {
      return json(
        {
          code: "missing_master",
          message: "Pick a video (YouTube) and/or an audio master (Mixcloud).",
        },
        400,
      );
    }

    // Both masters are fenced before either reaches the argv.
    const fencedVideo = video ? fenceMediaPath(video) : undefined;
    const fencedAudio = audio ? fenceMediaPath(audio) : undefined;

    if ((fencedVideo && !fencedVideo.ok) || (fencedAudio && !fencedAudio.ok)) {
      return pathRefused();
    }

    const argv = [
      process.execPath,
      CLI_ENTRY,
      "admin",
      "mixtapes",
      "distribute",
      logId,
      ...(fencedVideo?.ok ? ["--video", fencedVideo.path] : []),
      ...(fencedAudio?.ok ? ["--audio", fencedAudio.path] : []),
      "--json",
    ];
    const opts: StreamedOptions = {
      adminToken: true,
      cwd: REPO_ROOT,
      feature: "set-lifecycle",
      title: `distribute: ${logId}`,
    };
    const { runId } = app.context.runs.runStreamed(argv, opts);
    const started: RunStartedResponse = { runId };

    return json(started);
  });
}
