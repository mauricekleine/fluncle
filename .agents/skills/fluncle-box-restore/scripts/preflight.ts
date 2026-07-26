#!/usr/bin/env bun
// preflight.ts — "could we restore rave-02 RIGHT NOW?", answered before the box is on fire.
//
// A restore path you have never exercised is a belief, not a capability. The expensive way to
// discover a missing encryption key, a nightly that stopped landing three weeks ago, or an
// `op://` ref that no longer resolves is the morning the disk is gone — at which point every
// one of those is unfixable. So this asks the same questions on a quiet Tuesday, cheaply.
//
// READ-ONLY BY CONSTRUCTION. The only S3 verbs in this file are LIST, HEAD and a GET of the
// small plaintext manifest: there is no PUT, no DELETE, no prune, and nothing is written
// anywhere outside a temp dir. `op inject` output goes to /dev/null. Running it on a whim, at
// any hour, on a live box or a laptop, changes nothing.
//
// IT NEVER FAKES A PASS. A check that cannot run — no bucket credentials, no `op`, no private
// companion checkout — reports `unknown` ("could not verify") and says what it would need.
// `unknown` is deliberately NOT success: the run exits 2 so an agent cannot read a half-blind
// sweep as a clean bill of health.
//
// Usage (from the repo checkout):
//   bun packages/skills/fluncle-box-restore/scripts/preflight.ts
//   bun packages/skills/fluncle-box-restore/scripts/preflight.ts --json
//   bun packages/skills/fluncle-box-restore/scripts/preflight.ts --max-age-days 7
//   bun packages/skills/fluncle-box-restore/scripts/preflight.ts --labs <path-to-companion>
//   bun packages/skills/fluncle-box-restore/scripts/preflight.ts --drill   # + the real restore drill
//
// Exit: 0 every check passed · 1 something FAILED · 2 nothing failed but something was unverifiable.
//
// Env it reads (never prints): FLUNCLE_BOXSTATE_KEY, R2_ACCOUNT_ID,
// FLUNCLE_BACKUP_R2_ACCESS_KEY_ID, FLUNCLE_BACKUP_R2_SECRET_ACCESS_KEY, FLUNCLE_BACKUP_R2_BUCKET,
// FLUNCLE_LABS_DIR.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// ── the result shape ────────────────────────────────────────────────────────────────────

export type CheckStatus = "fail" | "pass" | "unknown";

export type CheckResult = {
  /** What was observed. Never a secret value — key NAMES, counts, dates, sizes only. */
  detail: string;
  id: string;
  /** What to do about it. Present whenever the status is not `pass`. */
  remedy?: string;
  status: CheckStatus;
  title: string;
};

/**
 * The repo files the rebuild runbook actually drives. If one of these is gone, the runbook has
 * a hole in it and the time to learn that is now — this is the cheapest check here and the only
 * one that needs no credentials at all.
 */
export const REQUIRED_REPO_ASSETS: readonly string[] = [
  "docs/agents/hermes-agent.md",
  "docs/agents/hermes/Dockerfile",
  "docs/agents/hermes/backup-timer/README.md",
  "docs/agents/hermes/install-host-timers.sh",
  "docs/agents/hermes/pin-watch/rebuild-hermes.sh",
  "docs/agents/hermes/scripts/backup-sweep.ts",
  "docs/agents/hermes/scripts/box-state-restore-drill.ts",
  "docs/agents/hermes/scripts/box-state-snapshot.ts",
  "docs/agents/hermes/secrets/fluncle-secrets-sync.sh",
  "packages/skills/hetzner-devbox/scripts/apply-firewall.sh",
  "packages/skills/hetzner-devbox/scripts/bootstrap-hardening.sh",
  "packages/skills/hetzner-devbox/scripts/bootstrap-private-vps.sh",
  "packages/skills/hetzner-devbox/scripts/check-prereqs.sh",
  "packages/skills/hetzner-devbox/scripts/create-server.sh",
  "packages/skills/hetzner-devbox/scripts/install-toolchain.sh",
];

/** The `op inject` templates the companion repo holds — the box's whole secret map. */
export const SECRET_TEMPLATE_NAMES: readonly string[] = [
  "hermes.env.tpl",
  "fluncle-secrets.env.tpl",
];

/** Where those templates live inside the companion checkout. */
export const LABS_BOX_DOC_DIR = join("docs", "rave-02");

/** One missed night is tolerable; three is a stopped backup nobody noticed. */
export const DEFAULT_MAX_AGE_DAYS = 3;

// ── pure helpers (the tested surface) ───────────────────────────────────────────────────

/**
 * Walk up from `startDir` until a directory looks like the Fluncle repo. Anchored on a file the
 * restore path itself needs rather than on `.git`, so a worktree, a shallow clone, or a copy
 * without git metadata all resolve — and a directory that is NOT this repo never does.
 */
export function resolveRepoRoot(startDir: string): string | undefined {
  const marker = join("docs", "agents", "hermes", "scripts", "backup-sweep.ts");
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, marker))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * The newest `YYYY-MM-DD` (or `YYYY-MM`) folder under a backup prefix. Both legs write
 * `<prefix><date>/<file>`, and the dates sort lexicographically, so "newest" is a max over the
 * parsed segment — no listing order is assumed.
 */
export function latestDatedFolder(keys: readonly string[], prefix: string): string | undefined {
  let best: string | undefined;
  for (const key of keys) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    const segment = key.slice(prefix.length).split("/")[0];
    if (!segment || !/^\d{4}-\d{2}(-\d{2})?$/.test(segment)) {
      continue;
    }
    if (best === undefined || segment > best) {
      best = segment;
    }
  }
  return best;
}

/** Whole days between a `YYYY-MM-DD` folder name and `now`, UTC. Negative is clamped to 0. */
export function ageInDays(date: string, now: Date): number {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed)) {
    return Number.POSITIVE_INFINITY;
  }
  const days = Math.floor((now.getTime() - parsed) / 86_400_000);
  return days < 0 ? 0 : days;
}

/**
 * `FLUNCLE_BOXSTATE_KEY` must decode to exactly 32 bytes (64 hex chars or base64) — the same
 * rule `boxStateKeyFromEnv` enforces on the box. Re-checked here rather than imported because
 * the point is to fail on a key that is absent or malformed, which that function throws on.
 */
export function validateBoxStateKey(raw: string | undefined): {
  bytes: number;
  ok: boolean;
  reason?: string;
} {
  const value = (raw ?? "").trim();
  if (value === "") {
    return { bytes: 0, ok: false, reason: "not set" };
  }
  let bytes = 0;
  if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
    bytes = value.length / 2;
  } else {
    try {
      bytes = Buffer.from(value, "base64").length;
    } catch {
      return { bytes: 0, ok: false, reason: "not hex or base64" };
    }
  }
  if (bytes !== 32) {
    return { bytes, ok: false, reason: `decodes to ${bytes} bytes, not 32` };
  }
  return { bytes, ok: true };
}

export type ManifestVerdict = {
  cipherBytes?: number;
  entryCount?: number;
  ok: boolean;
  problems: string[];
};

/**
 * Does the stored box-state manifest still describe a restorable artifact? The manifest is the
 * one part of the backup that is deliberately unencrypted, precisely so an inventory pass like
 * this one can judge the artifact without holding the key.
 */
export function validateBoxStateManifest(text: string): ManifestVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      problems: [`manifest is not JSON (${error instanceof Error ? error.message : "unknown"})`],
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, problems: ["manifest is not an object"] };
  }
  const manifest = parsed as Record<string, unknown>;
  const problems: string[] = [];
  for (const field of ["archiveBytes", "cipherBytes", "entryCount"] as const) {
    if (typeof manifest[field] !== "number" || (manifest[field] as number) <= 0) {
      problems.push(`${field} is missing or not a positive number`);
    }
  }
  if (typeof manifest.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.sha256)) {
    problems.push("sha256 is missing or not a 64-char hex digest");
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    problems.push("entries is missing or empty");
  } else if (manifest.entries.length !== manifest.entryCount) {
    problems.push(`entryCount (${String(manifest.entryCount)}) disagrees with entries.length`);
  }
  return {
    cipherBytes: typeof manifest.cipherBytes === "number" ? manifest.cipherBytes : undefined,
    entryCount: typeof manifest.entryCount === "number" ? manifest.entryCount : undefined,
    ok: problems.length === 0,
    problems,
  };
}

export type TemplateScan = {
  /** Variable NAMES whose value is not an `op://` reference — i.e. a literal in a git repo. */
  literalKeys: string[];
  /** Variable NAMES mapped to an `op://` reference. */
  refKeys: string[];
};

/**
 * A value that is a POINTER rather than a secret. Both spellings count: `op inject` resolves the
 * moustache form (`{{ op://… }}`) and the bare form alike — verified against the CLI rather than
 * assumed, because assuming otherwise would have condemned every real template line.
 *
 * Matched loosely after the scheme because a vault or item name may contain SPACES. A strict
 * `\S+` here reclassified every real reference as a leaked literal — a false alarm on the one
 * check whose whole job is to be believed.
 */
const OP_REFERENCE = /^(?:\{\{\s*op:\/\/[^{}]+\}\}|op:\/\/.+)$/;

/**
 * Read a secret TEMPLATE and prove it is still only a MAP. The companion repo is private, but
 * private is not the same as safe: the whole reason those files can be version-controlled at all
 * is that every value is an `op://` pointer. A hand-edit that pastes a real token turns the map
 * into a secret store, so this looks for exactly that.
 *
 * Returns NAMES and counts only — never a value, so a leak this finds is not a leak it repeats.
 */
export function scanSecretTemplate(text: string): TemplateScan {
  const literalKeys: string[] = [];
  const refKeys: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match?.[1]) {
      continue;
    }
    const key = match[1];
    const value = (match[2] ?? "").trim().replace(/^["']|["']$/g, "");
    if (value === "") {
      continue;
    }
    if (OP_REFERENCE.test(value)) {
      refKeys.push(key);
    } else {
      literalKeys.push(key);
    }
  }
  return { literalKeys, refKeys };
}

/**
 * Scrub the TOPOLOGY out of a child process's diagnostics before this report repeats it.
 *
 * The two children whose stderr is surfaced both name the map in their failure text: `op` quotes
 * the reference that would not resolve, and the restore drill quotes the bucket URL it could not
 * read. Both cases fire exactly when something is wrong — which is exactly when the output gets
 * pasted into a PR, an issue, or a chat. This report is agent-facing, so it must stay safe to
 * paste. What is diagnostically useful (which template, which verb, what the error said) all
 * survives; only the vault path and the endpoint go.
 */
export function redactTopology(text: string): string {
  return (
    text
      // A vault or item name may contain SPACES, so a `\S+` here leaves the tail of the path
      // behind — the very part that identifies the item. `op` puts the reference at the end of
      // its message, so redacting to end-of-line loses nothing that matters and cannot under-cut.
      .replace(/op:\/\/.*/g, "op://<redacted>")
      // A URL cannot contain a space, so `\S+` is exact here. The negative lookahead keeps this
      // from re-redacting the `op://<redacted>` marker the previous pass just wrote.
      .replace(/\b(?!op:)[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<redacted-url>")
  );
}

/** 0 clean · 1 something failed · 2 nothing failed but something could not be verified. */
export function exitCodeFor(results: readonly CheckResult[]): number {
  if (results.some((result) => result.status === "fail")) {
    return 1;
  }
  if (results.some((result) => result.status === "unknown")) {
    return 2;
  }
  return 0;
}

// ── the checks ──────────────────────────────────────────────────────────────────────────

type BackupSweepModule = {
  BOXSTATE_ARTIFACT_NAME: string;
  BOXSTATE_DAILY_PREFIX: string;
  MANIFEST_NAME: string;
  backupR2Config: (env?: NodeJS.ProcessEnv) => {
    accessKeyId: string;
    bucketUrl: string;
    secretAccessKey: string;
  };
  encodeKey: (key: string) => string;
  signS3Request: (options: {
    accessKeyId: string;
    method: string;
    now: Date;
    region: string;
    secretAccessKey: string;
    service: string;
    url: string;
  }) => Promise<Record<string, string>>;
  signedList: (options: {
    accessKeyId: string;
    bucketUrl: string;
    prefix: string;
    secretAccessKey: string;
  }) => Promise<string[]>;
};

const DB_DUMP_DAILY_PREFIX = "db-backups/daily/";

function checkRepoAssets(repoRoot: string): CheckResult {
  const missing = REQUIRED_REPO_ASSETS.filter((path) => !existsSync(join(repoRoot, path)));
  if (missing.length > 0) {
    return {
      detail: `${missing.length} of ${REQUIRED_REPO_ASSETS.length} runbook assets missing: ${missing.join(", ")}`,
      id: "repo-assets",
      remedy:
        "The rebuild runbook links a file this checkout does not have. Re-read SKILL.md against the repo and fix the reference (or restore the asset) before trusting the runbook.",
      status: "fail",
      title: "Rebuild assets present in the repo",
    };
  }
  return {
    detail: `all ${REQUIRED_REPO_ASSETS.length} provisioning / secrets / backup assets present`,
    id: "repo-assets",
    status: "pass",
    title: "Rebuild assets present in the repo",
  };
}

function checkSchedulePlan(repoRoot: string): CheckResult {
  const script = join(repoRoot, "docs/agents/hermes/install-host-timers.sh");
  const run = spawnSync("bash", [script, "--dry-run"], { encoding: "utf8" });
  if (run.status !== 0) {
    return {
      detail: `install-host-timers.sh --dry-run exited ${String(run.status)}: ${(run.stderr ?? "").trim().slice(0, 300)}`,
      id: "schedule-plan",
      remedy:
        "The schedule half of the restore cannot be laid down. Its pre-flight refuses on an unresolved ExecStart — put the host script beside its unit, or point the unit at a path the installer lays down.",
      status: "fail",
      title: "The schedule restores (install-host-timers.sh --dry-run)",
    };
  }
  const plan = run.stdout ?? "";
  const timers = [...plan.matchAll(/^plan: timer (.+)$/gm)].map((match) => match[1]);
  const hasSecretsSync = timers.some((name) => name === "fluncle-secrets-sync.timer");
  if (!hasSecretsSync) {
    return {
      detail: `the plan enables ${timers.length} timers but not fluncle-secrets-sync.timer`,
      id: "schedule-plan",
      remedy:
        "Without the secrets timer in the plan a restored box enables every sweep and runs them credential-less — the exact silent failure the installer's derived unit-dir rule exists to prevent. Check docs/agents/hermes/secrets/ still holds its unit files.",
      status: "fail",
      title: "The schedule restores (install-host-timers.sh --dry-run)",
    };
  }
  return {
    detail: `${timers.length} timers planned, secrets sync ordered first`,
    id: "schedule-plan",
    status: "pass",
    title: "The schedule restores (install-host-timers.sh --dry-run)",
  };
}

function checkEncryptionKey(): CheckResult {
  const verdict = validateBoxStateKey(process.env.FLUNCLE_BOXSTATE_KEY);
  if (!verdict.ok) {
    return {
      detail: `FLUNCLE_BOXSTATE_KEY ${verdict.reason ?? "invalid"}`,
      id: "encryption-key",
      remedy:
        "With no valid key there is no box-state artifact at all — leg 2 skips and uploads nothing, and any artifact already stored cannot be opened. Mint one (`openssl rand -hex 32`), store it OFF the box, and add it to the sweep secrets template. See docs/agents/hermes/backup-timer/README.md § Leg 2.",
      status: "fail",
      title: "Box-state encryption key present and well-formed",
    };
  }
  return {
    detail: "FLUNCLE_BOXSTATE_KEY decodes to 32 bytes",
    id: "encryption-key",
    status: "pass",
    title: "Box-state encryption key present and well-formed",
  };
}

async function loadBackupSweep(repoRoot: string): Promise<BackupSweepModule | undefined> {
  const path = join(repoRoot, "docs/agents/hermes/scripts/backup-sweep.ts");
  if (!existsSync(path)) {
    return undefined;
  }
  return (await import(path)) as BackupSweepModule;
}

function bucketCredentialsPresent(module: BackupSweepModule): boolean {
  const config = module.backupR2Config();
  return config.accessKeyId !== "" && config.secretAccessKey !== "" && config.bucketUrl !== "";
}

const unverifiableStorage = (id: string, title: string, why: string): CheckResult => ({
  detail: why,
  id,
  remedy:
    "Provide R2_ACCOUNT_ID, FLUNCLE_BACKUP_R2_ACCESS_KEY_ID and FLUNCLE_BACKUP_R2_SECRET_ACCESS_KEY (the same names the sweep and the restore drill read) and run again. Until then this is unverified, not healthy.",
  status: "unknown",
  title,
});

async function checkBoxStateArtifact(
  module: BackupSweepModule,
  maxAgeDays: number,
  now: Date,
): Promise<CheckResult> {
  const id = "box-state-artifact";
  const title = "A recent box-state artifact is in storage and its manifest parses";
  const config = module.backupR2Config();
  let keys: string[];
  try {
    keys = await module.signedList({
      accessKeyId: config.accessKeyId,
      bucketUrl: config.bucketUrl,
      prefix: module.BOXSTATE_DAILY_PREFIX,
      secretAccessKey: config.secretAccessKey,
    });
  } catch (error) {
    return unverifiableStorage(
      id,
      title,
      `LIST failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }

  const date = latestDatedFolder(keys, module.BOXSTATE_DAILY_PREFIX);
  if (!date) {
    return {
      detail: "no box-state artifact has ever been stored",
      id,
      remedy:
        "Leg 2 has never produced an artifact. Most often the encryption key is unset, in which case the leg reports `{skipped:true,reason:'no_encryption_key'}` and uploads nothing — provision the key, then dry-run it (`backup-sweep.ts --box-state-out <dir>`) before trusting the nightly.",
      status: "fail",
      title,
    };
  }

  const age = ageInDays(date, now);
  const folder = `${module.BOXSTATE_DAILY_PREFIX}${date}/`;
  const manifestKey = `${folder}${module.MANIFEST_NAME}`;
  const artifactKey = `${folder}${module.BOXSTATE_ARTIFACT_NAME}`;

  let manifestText: string;
  try {
    manifestText = await signedGetText(module, config, manifestKey);
  } catch (error) {
    return {
      detail: `newest artifact is ${date} (${age}d old) but its manifest could not be read: ${error instanceof Error ? error.message : "unknown error"}`,
      id,
      remedy:
        "An artifact with no readable manifest cannot be verified on restore — the drill checks the decrypted size and digest against it. Re-run the nightly and confirm both objects land.",
      status: "fail",
      title,
    };
  }

  const verdict = validateBoxStateManifest(manifestText);
  if (!verdict.ok) {
    return {
      detail: `newest artifact ${date}: manifest problems — ${verdict.problems.join("; ")}`,
      id,
      remedy:
        "The manifest is the only thing that can judge a decrypted archive. Re-run the backup sweep and inspect its JSON summary line.",
      status: "fail",
      title,
    };
  }

  const cipherBytes = await signedHeadLength(module, config, artifactKey);
  if (cipherBytes === undefined) {
    return {
      detail: `manifest for ${date} is valid but the sealed artifact object is missing or unreadable`,
      id,
      remedy:
        "A manifest without its artifact restores nothing. Re-run the nightly and confirm both objects land in the same daily folder.",
      status: "fail",
      title,
    };
  }
  if (verdict.cipherBytes !== undefined && cipherBytes !== verdict.cipherBytes) {
    return {
      detail: `stored artifact is ${cipherBytes} bytes, manifest records ${verdict.cipherBytes}`,
      id,
      remedy:
        "A size disagreement means a truncated or overwritten upload. Run the restore drill against this key to see whether it still opens, then re-run the nightly.",
      status: "fail",
      title,
    };
  }
  if (age > maxAgeDays) {
    return {
      detail: `newest artifact is ${date}, ${age} days old (limit ${maxAgeDays})`,
      id,
      remedy:
        "The nightly has stopped landing. Check the fluncle-backup timer and its `/status` row — a marker with no JSON summary means the sweep was killed before it could speak (the OOM signature), not that it is fine.",
      status: "fail",
      title,
    };
  }
  return {
    detail: `${date} (${age}d old), ${String(verdict.entryCount)} entries, ${cipherBytes} sealed bytes, manifest verified`,
    id,
    status: "pass",
    title,
  };
}

async function checkDbDump(
  module: BackupSweepModule,
  maxAgeDays: number,
  now: Date,
): Promise<CheckResult> {
  const id = "db-dump";
  const title = "A recent production database dump is in storage";
  const config = module.backupR2Config();
  let keys: string[];
  try {
    keys = await module.signedList({
      accessKeyId: config.accessKeyId,
      bucketUrl: config.bucketUrl,
      prefix: DB_DUMP_DAILY_PREFIX,
      secretAccessKey: config.secretAccessKey,
    });
  } catch (error) {
    return unverifiableStorage(
      id,
      title,
      `LIST failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  const date = latestDatedFolder(keys, DB_DUMP_DAILY_PREFIX);
  if (!date) {
    return {
      detail: "no database dump found under the daily prefix",
      id,
      remedy:
        "Leg 1 is the belt to Turso's managed point-in-time braces. Check the fluncle-backup timer and run its acceptance test (apps/web/scripts/restore-drill.ts).",
      status: "fail",
      title,
    };
  }
  const age = ageInDays(date, now);
  if (age > maxAgeDays) {
    return {
      detail: `newest dump is ${date}, ${age} days old (limit ${maxAgeDays})`,
      id,
      remedy:
        "The dump has stopped landing. The known killer is memory: the sweep must stream (never join, Buffer, or read back the artifact) or it is OOM-killed as the archive grows.",
      status: "fail",
      title,
    };
  }
  return { detail: `${date} (${age}d old)`, id, status: "pass", title };
}

async function signedGetText(
  module: BackupSweepModule,
  config: { accessKeyId: string; bucketUrl: string; secretAccessKey: string },
  key: string,
): Promise<string> {
  const url = `${config.bucketUrl}/${module.encodeKey(key)}`;
  const headers = await module.signS3Request({
    accessKeyId: config.accessKeyId,
    method: "GET",
    now: new Date(),
    region: "auto",
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    url,
  });
  const response = await fetch(url, { headers, method: "GET" });
  if (!response.ok) {
    throw new Error(`GET ${key} → ${response.status}`);
  }
  return response.text();
}

/** HEAD, so the sealed artifact's size is confirmed without pulling a byte of it. */
async function signedHeadLength(
  module: BackupSweepModule,
  config: { accessKeyId: string; bucketUrl: string; secretAccessKey: string },
  key: string,
): Promise<number | undefined> {
  const url = `${config.bucketUrl}/${module.encodeKey(key)}`;
  try {
    const headers = await module.signS3Request({
      accessKeyId: config.accessKeyId,
      method: "HEAD",
      now: new Date(),
      region: "auto",
      secretAccessKey: config.secretAccessKey,
      service: "s3",
      url,
    });
    const response = await fetch(url, { headers, method: "HEAD" });
    if (!response.ok) {
      return undefined;
    }
    const length = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    return Number.isFinite(length) ? length : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Find the private companion checkout. Explicit flag wins, then the env var, then a sibling of
 * this repo. Never guessed beyond that — a wrong guess would report "missing" for a checkout
 * that exists elsewhere, which is worse than saying so.
 */
export function resolveLabsDir(
  repoRoot: string,
  override: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string | undefined {
  const candidates = [
    override,
    env.FLUNCLE_LABS_DIR,
    join(dirname(repoRoot), "fluncle-labs"),
    join(home, "Projects", "fluncle-labs"),
  ].filter((value): value is string => typeof value === "string" && value !== "");
  return candidates.find((candidate) => existsSync(join(candidate, LABS_BOX_DOC_DIR)));
}

function checkSecretTemplates(labsDir: string | undefined): CheckResult[] {
  const id = "secret-templates";
  const title = "The box's secret templates are present and hold only references";
  if (!labsDir) {
    return [
      {
        detail: "no private companion checkout found",
        id,
        remedy:
          "The two `op inject` templates ARE the box's secret map, and they live only in the private companion repo. Without them a rebuilt box boots, goes green, and silently cannot run its sweeps. Point --labs (or FLUNCLE_LABS_DIR) at the checkout, or ask the operator.",
        status: "unknown",
        title,
      },
      {
        detail: "skipped — the templates could not be located",
        id: "op-refs",
        remedy: "Resolve the companion checkout first, then re-run.",
        status: "unknown",
        title: "Every `op://` reference in those templates resolves",
      },
    ];
  }

  const results: CheckResult[] = [];
  const found: { path: string; scan: TemplateScan }[] = [];
  const missing: string[] = [];
  for (const name of SECRET_TEMPLATE_NAMES) {
    const path = join(labsDir, LABS_BOX_DOC_DIR, name);
    if (!existsSync(path)) {
      missing.push(name);
      continue;
    }
    found.push({ path, scan: scanSecretTemplate(readFileSync(path, "utf8")) });
  }

  if (missing.length > 0) {
    results.push({
      detail: `missing template(s): ${missing.join(", ")}`,
      id,
      remedy:
        "A template that exists only on the box dies with the box: you would still reach every secret in the vault and have no idea which variable wanted which one. Commit the missing template to the companion repo.",
      status: "fail",
      title,
    });
  } else {
    const literals = found.flatMap((entry) => entry.scan.literalKeys);
    const refCounts = found
      .map((entry) => `${entry.path.split("/").at(-1) ?? "?"}=${entry.scan.refKeys.length}`)
      .join(", ");
    results.push(
      literals.length > 0
        ? {
            detail: `these variables hold a literal value rather than an op:// reference: ${literals.join(", ")}`,
            id,
            remedy:
              "A template is safe to version-control only because every value is a pointer. Move the value into the vault and replace it with its `op://` reference.",
            status: "fail",
            title,
          }
        : {
            detail: `both templates present, every value an op:// reference (${refCounts})`,
            id,
            status: "pass",
            title,
          },
    );
  }

  results.push(checkOpRefs(found.map((entry) => entry.path)));
  return results;
}

/**
 * Ask 1Password to resolve every reference without ever materialising a value. `op inject` with
 * no `-o` renders to STDOUT, which is discarded here (`stdio: ignore`) — deliberately not
 * `-o /dev/null`, which makes `op` try to delete the device node and fail on a reference problem
 * it never actually looked for. Nothing touches disk; only the exit status is read.
 *
 * This is the check that catches a renamed vault item — a rename that stays invisible right up
 * until the night the box needs it.
 */
function checkOpRefs(templatePaths: readonly string[]): CheckResult {
  const id = "op-refs";
  const title = "Every `op://` reference in those templates resolves";
  if (templatePaths.length === 0) {
    return {
      detail: "no templates to resolve",
      id,
      remedy: "Resolve the companion checkout first, then re-run.",
      status: "unknown",
      title,
    };
  }
  const opPath = spawnSync("command", ["-v", "op"], { encoding: "utf8", shell: true });
  if (opPath.status !== 0) {
    return {
      detail: "the 1Password CLI (`op`) is not on PATH",
      id,
      remedy:
        "Install `op` and sign in, then re-run. Note that `op` is also a hard prerequisite ON the box: the secret layer's first action is `op inject`, so a box without it renders no env file and every sweep runs credential-less with nothing to warn you.",
      status: "unknown",
      title,
    };
  }
  const unresolved: string[] = [];
  for (const path of templatePaths) {
    const run = spawnSync("op", ["inject", "-i", path], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (run.status !== 0) {
      const reason = redactTopology(
        (run.stderr ?? "").trim().split("\n").at(-1) ?? "unknown error",
      );
      unresolved.push(`${path.split("/").at(-1) ?? path}: ${reason.slice(0, 160)}`);
    }
  }
  if (unresolved.length > 0) {
    const authLike = unresolved.some((line) =>
      /authenticat|sign in|session|not signed/i.test(line),
    );
    return {
      detail: unresolved.join(" · "),
      id,
      remedy: authLike
        ? "This reads as an auth failure rather than a broken reference — `op` needs an interactive session. Sign in and re-run before concluding anything about the refs."
        : "A reference that does not resolve is a secret the box will silently fail to render. Fix the vault item (or the template) so both render cleanly.",
      status: authLike ? "unknown" : "fail",
      title,
    };
  }
  return {
    detail: `all references in ${templatePaths.length} template(s) resolved`,
    id,
    status: "pass",
    title,
  };
}

function runRestoreDrill(repoRoot: string): CheckResult {
  const id = "restore-drill";
  const title = "The stored artifact actually restores (full drill)";
  const script = join(repoRoot, "docs/agents/hermes/scripts/box-state-restore-drill.ts");
  const run = spawnSync("bun", [script], { encoding: "utf8" });
  if (run.status !== 0) {
    return {
      detail: redactTopology(
        `drill exited ${String(run.status)}: ${(run.stderr ?? "").trim().split("\n").at(-1) ?? ""}`,
      ).slice(0, 400),
      id,
      remedy:
        "The drill is the acceptance test: fetch, verify, decrypt, prove tamper-detection bites, unpack, and confirm the load-bearing set came back. A red drill means the backup is not a backup yet — read its output and fix the leg before anything else here matters.",
      status: "fail",
      title,
    };
  }
  return { detail: summariseDrillReport(run.stdout ?? ""), id, status: "pass", title };
}

/**
 * The drill prints one pretty-printed JSON report, so the summary is parsed rather than tailed —
 * the last LINE of that report is a closing brace, which read as a passing detail of "}".
 */
export function summariseDrillReport(stdout: string): string {
  try {
    const report = JSON.parse(stdout) as Record<string, unknown>;
    const parts = ["object", "generatedAt", "entryCount", "restoredBytes", "tamperDetected"]
      .filter((field) => report[field] !== undefined)
      .map((field) => `${field}=${String(report[field])}`);
    return parts.length > 0 ? parts.join(" ") : "verified, decrypted and unpacked";
  } catch {
    return "verified, decrypted and unpacked";
  }
}

// ── the run ─────────────────────────────────────────────────────────────────────────────

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const STATUS_MARK: Record<CheckStatus, string> = { fail: "FAIL", pass: "PASS", unknown: "????" };

export async function runPreflight(options: {
  drill: boolean;
  labs?: string;
  maxAgeDays: number;
  now: Date;
  repoRoot: string;
}): Promise<CheckResult[]> {
  const results: CheckResult[] = [
    checkRepoAssets(options.repoRoot),
    checkSchedulePlan(options.repoRoot),
    checkEncryptionKey(),
  ];

  const module = await loadBackupSweep(options.repoRoot);
  const storageTitles: [string, string][] = [
    ["box-state-artifact", "A recent box-state artifact is in storage and its manifest parses"],
    ["db-dump", "A recent production database dump is in storage"],
  ];
  if (!module) {
    for (const [id, title] of storageTitles) {
      results.push(unverifiableStorage(id, title, "the backup sweep module could not be loaded"));
    }
  } else if (!bucketCredentialsPresent(module)) {
    for (const [id, title] of storageTitles) {
      results.push(
        unverifiableStorage(id, title, "no backup-bucket credentials in the environment"),
      );
    }
  } else {
    results.push(await checkBoxStateArtifact(module, options.maxAgeDays, options.now));
    results.push(await checkDbDump(module, options.maxAgeDays, options.now));
  }

  results.push(...checkSecretTemplates(resolveLabsDir(options.repoRoot, options.labs)));

  if (options.drill) {
    results.push(runRestoreDrill(options.repoRoot));
  }

  return results;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      [
        "preflight.ts — could we restore rave-02 right now? (read-only)",
        "",
        "  --json                machine-readable report",
        "  --max-age-days <n>    freshness limit for the stored backups (default 3)",
        "  --labs <dir>          the private companion checkout holding the secret templates",
        "  --drill               also run the full box-state restore drill (slower, still read-only)",
        "",
        "Exit: 0 clean · 1 a check FAILED · 2 nothing failed but something could not be verified.",
      ].join("\n"),
    );
    return;
  }

  const repoRoot = resolveRepoRoot(import.meta.dir) ?? resolveRepoRoot(process.cwd());
  if (!repoRoot) {
    console.error(
      "preflight: could not locate the Fluncle repo from this script or the working directory. Run it from a repo checkout.",
    );
    process.exit(2);
  }

  const parsedMaxAge = Number.parseInt(argValue("--max-age-days") ?? "", 10);
  const results = await runPreflight({
    drill: process.argv.includes("--drill"),
    labs: argValue("--labs"),
    maxAgeDays:
      Number.isFinite(parsedMaxAge) && parsedMaxAge > 0 ? parsedMaxAge : DEFAULT_MAX_AGE_DAYS,
    now: new Date(),
    repoRoot,
  });

  const code = exitCodeFor(results);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ checks: results, exitCode: code, ok: code === 0 }, null, 2));
  } else {
    console.log("Could we restore rave-02 right now?\n");
    for (const result of results) {
      console.log(`  [${STATUS_MARK[result.status]}] ${result.title}`);
      console.log(`         ${result.detail}`);
      if (result.remedy) {
        console.log(`         → ${result.remedy}`);
      }
      console.log("");
    }
    const counts = { fail: 0, pass: 0, unknown: 0 };
    for (const result of results) {
      counts[result.status] += 1;
    }
    console.log(
      `${counts.pass} passed · ${counts.fail} failed · ${counts.unknown} could not be verified`,
    );
    if (code === 2) {
      console.log("Unverified is not healthy — treat this run as incomplete.");
    }
  }

  process.exit(code);
}

if (import.meta.main) {
  await main();
}
