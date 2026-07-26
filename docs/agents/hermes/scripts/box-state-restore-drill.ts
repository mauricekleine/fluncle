#!/usr/bin/env bun
// box-state-restore-drill.ts — THE ACCEPTANCE TEST for LEG 2 of the `fluncle-backup` cron.
//
// A backup that has never restored is a hope, not a backup. The database dump has had its
// drill since day one (apps/web/scripts/restore-drill.ts); this is its sibling for the box-state
// archive, and it exists because leg 2 protects the things that are GONE if the box's disk goes:
// the gateway state db, the agent's memories, the cron markers, the hand-placed 0600 env files,
// and the render conductor's `box-id` — whose loss orphans a paid provisioned render box nobody
// can then find or delete.
//
// A restore is only PROVEN when a fresh process, holding nothing but the key, can turn the
// stored bytes back into files. So the drill runs the whole path:
//
//   1. FETCH   the sealed artifact + its plaintext manifest from the backup bucket (latest
//              daily by default; `--key`/`--date` target a specific one, `--file` a local one).
//   2. VERIFY  before trusting: the stored cipher length matches the manifest, the magic is
//              there, and — after decrypting — the plaintext's SHA-256 and size match what the
//              producer recorded. A mismatch is a hard failure, never a warning.
//   3. TAMPER  is PROVEN, not assumed: a byte is flipped in a COPY of the ciphertext and the
//              open must fail. AES-GCM's whole reason for being here is that a corrupted or
//              re-headed artifact refuses to open instead of unpacking garbage over live state.
//   4. UNPACK  into a throwaway dir, then check the restore against the manifest — every listed
//              path present, sizes equal, entry count equal.
//   5. COVER   the load-bearing set: `checkBoxStateCoverage` in box-state-snapshot.ts judges the
//              restored tree against the SAME include list the producer archives from, so this
//              drill can never carry a second, drifting copy of "what a rebuild needs".
//
// READ-ONLY, BY CONSTRUCTION. The only S3 verbs in this file are LIST and GET — there is no PUT
// and no DELETE anywhere in it, so a drill run can never overwrite or prune a backup object. It
// never restores over a live data dir either: it unpacks ONLY into a temp dir it created and
// removes. Its OUTPUT is paths, sizes and counts — never a key, never a decrypted byte. The one
// exception is deliberate and asked for: `--keep <dir>` copies the unpacked tree out for
// inspection, credentials included, into a fresh `0700` directory. Delete it when done.
//
// SELF-CONTAINED by necessity, like every box script — the workspace is not importable here. It
// shares its S3 signing, its bucket config and its keyspace with backup-sweep.ts, and its framing,
// key parsing and include list with box-state-snapshot.ts, rather than re-deriving any of them.
//
// stdout: one JSON report (the house style of the sibling drill). Diagnostics → stderr.
// Exit 0 on a clean, verified restore; non-zero, loudly, on anything else.
//
// Usage:
//   bun docs/agents/hermes/scripts/box-state-restore-drill.ts               # latest daily
//   bun docs/agents/hermes/scripts/box-state-restore-drill.ts --date 2026-07-26
//   bun docs/agents/hermes/scripts/box-state-restore-drill.ts --date 2026-07 --monthly
//   bun docs/agents/hermes/scripts/box-state-restore-drill.ts --key box-state/daily/<date>/<name>
//   bun docs/agents/hermes/scripts/box-state-restore-drill.ts --file ./box-state.tar.gz.enc
//   …plus --keep <dir> to leave the unpacked tree behind for inspection.
//
// Env: FLUNCLE_BOXSTATE_KEY always (the artifact is useless without it). The bucket reads
// (R2_ACCOUNT_ID, FLUNCLE_BACKUP_R2_ACCESS_KEY_ID, FLUNCLE_BACKUP_R2_SECRET_ACCESS_KEY, and
// optionally FLUNCLE_BACKUP_R2_BUCKET) are needed for every mode EXCEPT `--file`.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  BOXSTATE_ARTIFACT_NAME,
  BOXSTATE_DAILY_PREFIX,
  BOXSTATE_MONTHLY_PREFIX,
  MANIFEST_NAME,
  type BackupR2Config,
  backupR2Config,
  encodeKey,
  signedList,
  signS3Request,
} from "./backup-sweep";

import {
  BOX_STATE_MAGIC,
  type BoxStateManifest,
  boxStateEntryBytes,
  boxStateKeyFromEnv,
  checkBoxStateCoverage,
  openBoxState,
} from "./box-state-snapshot";

const log = (message: string) => console.error(`[box-state-restore-drill] ${message}`);

function fail(message: string): never {
  log(message);
  process.exit(1);
}

// ── The read-only half of the bucket ─────────────────────────────────────────

/** One signed GET. The drill's ONLY write-shaped verb is the absence of one. */
export async function signedGet(
  url: string,
  options: { accessKeyId: string; expectBytes?: number; secretAccessKey: string },
): Promise<Uint8Array> {
  const headers = await signS3Request({
    accessKeyId: options.accessKeyId,
    method: "GET",
    now: new Date(),
    region: "auto",
    secretAccessKey: options.secretAccessKey,
    service: "s3",
    url,
  });
  const res = await fetch(url, { headers, method: "GET" });

  if (!res.ok) {
    throw new Error(`GET ${url} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  // Refuse an unexpectedly large object BEFORE buffering it: the drill holds the artifact in
  // memory (AES-GCM is one-shot), and the manifest already says how big it should be.
  const declared = Number(res.headers.get("content-length") ?? "NaN");

  if (
    options.expectBytes !== undefined &&
    Number.isFinite(declared) &&
    declared !== options.expectBytes
  ) {
    throw new Error(
      `stored object is ${declared} bytes, the manifest says ${options.expectBytes} — refusing to read it`,
    );
  }

  return new Uint8Array(await res.arrayBuffer());
}

/**
 * The newest daily folder that actually holds an artifact. Folders are `YYYY-MM-DD`, so the
 * lexical maximum IS the chronological one — the same assumption the sweep prunes by.
 */
export function latestArtifactKey(keys: readonly string[], prefix: string): string | null {
  const artifacts = keys
    .filter((key) => key.startsWith(prefix) && key.endsWith(`/${BOXSTATE_ARTIFACT_NAME}`))
    .sort();

  return artifacts.at(-1) ?? null;
}

/** The manifest that sits beside an artifact key — the sweep always writes them as siblings. */
export function manifestKeyFor(artifactKey: string): string {
  const cut = artifactKey.lastIndexOf("/");

  return cut < 0 ? MANIFEST_NAME : `${artifactKey.slice(0, cut + 1)}${MANIFEST_NAME}`;
}

// ── Verify → decrypt → prove tamper-detection ────────────────────────────────

export type VerifyOutcome = { checks: string[]; plaintext: Uint8Array };

/**
 * Everything that must hold before a single byte is written to disk, in the order that keeps a
 * bad artifact from ever being trusted: length, magic, authenticated decryption, then the
 * plaintext's recorded size and SHA-256. Any failure throws with the number that disagreed.
 */
export async function verifySealedArtifact(options: {
  cipher: Uint8Array;
  key: Uint8Array;
  manifest: BoxStateManifest;
}): Promise<VerifyOutcome> {
  const checks: string[] = [];
  const { cipher, manifest } = options;

  if (cipher.byteLength !== manifest.cipherBytes) {
    throw new Error(
      `cipher length ${cipher.byteLength} != the manifest's ${manifest.cipherBytes} — the stored artifact is truncated or was replaced`,
    );
  }

  checks.push(`cipher length ${cipher.byteLength} matches the manifest`);

  const magic = new TextEncoder().encode(BOX_STATE_MAGIC);

  if (magic.some((byte, index) => cipher[index] !== byte)) {
    throw new Error(`not a Fluncle box-state artifact (bad magic; expected ${BOX_STATE_MAGIC})`);
  }

  checks.push(`${BOX_STATE_MAGIC} magic present`);

  let plaintext: Uint8Array;

  try {
    plaintext = await openBoxState(cipher, options.key);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(
      `decryption failed (wrong FLUNCLE_BOXSTATE_KEY, or the artifact was altered): ${message}`,
    );
  }

  checks.push("AES-256-GCM opened with FLUNCLE_BOXSTATE_KEY");

  if (plaintext.byteLength !== manifest.archiveBytes) {
    throw new Error(
      `decrypted archive is ${plaintext.byteLength} bytes, the manifest says ${manifest.archiveBytes}`,
    );
  }

  const sha256 = Buffer.from(
    await crypto.subtle.digest("SHA-256", plaintext as unknown as ArrayBuffer),
  ).toString("hex");

  if (sha256 !== manifest.sha256) {
    throw new Error(`archive SHA-256 ${sha256} != the manifest's ${manifest.sha256}`);
  }

  checks.push(`archive SHA-256 matches the manifest (${manifest.archiveBytes} bytes)`);

  return { checks, plaintext };
}

/**
 * PROVE the tamper-detection rather than believing the algorithm's reputation: flip one byte in
 * a COPY of the ciphertext and require the open to fail. If it ever succeeds, the AAD/tag
 * binding is not doing its job and a corrupted artifact could be unpacked over live state — so
 * that outcome is a drill failure, not a curiosity. The stored object is never touched.
 */
export async function proveTamperDetection(
  cipher: Uint8Array,
  key: Uint8Array,
): Promise<{ detail: string; ok: boolean }> {
  if (cipher.byteLength === 0) {
    return { detail: "nothing to tamper with", ok: false };
  }

  const tampered = new Uint8Array(cipher);
  const index = tampered.length - 1;

  tampered[index] = (tampered[index] ?? 0) ^ 0xff;

  try {
    await openBoxState(tampered, key);
  } catch {
    return { detail: "a flipped ciphertext byte is refused by the GCM tag", ok: true };
  }

  return {
    detail: "a flipped ciphertext byte still DECRYPTED — the GCM binding is broken",
    ok: false,
  };
}

// ── Unpack → check the restored tree ─────────────────────────────────────────

/** Untar the decrypted archive into `dir`. `tar` preserves the 0600 modes; the drill relies on it. */
export function unpackArchive(plaintext: Uint8Array, dir: string, tarBin = "tar"): void {
  const tarPath = join(dir, "box-state.tar.gz");

  mkdirSync(dir, { recursive: true });
  // Synchronous on purpose: `tar` reads this file on the next line.
  writeFileSync(tarPath, plaintext, { mode: 0o600 });

  const restored = join(dir, "restored");

  mkdirSync(restored, { recursive: true });

  const tar = spawnSync(tarBin, ["-xzf", tarPath, "-C", restored], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });

  rmSync(tarPath, { force: true });

  if (tar.error) {
    throw new Error(`tar unavailable: ${tar.error.message}`);
  }

  if (tar.status !== 0) {
    throw new Error(`tar exited ${tar.status}: ${(tar.stderr ?? "").trim().slice(0, 300)}`);
  }
}

export type RestoreCheck = { checks: string[]; problems: string[]; restoredBytes: number };

/**
 * Compare an unpacked tree with the manifest that describes it — presence, size, and count —
 * then ask the producer's own include list whether the load-bearing set survived.
 */
export function checkRestoredTree(options: {
  manifest: BoxStateManifest;
  root: string;
}): RestoreCheck {
  const problems: string[] = [];
  const checks: string[] = [];
  const present: string[] = [];
  let restoredBytes = 0;

  for (const entry of options.manifest.entries) {
    const path = join(options.root, entry.path);

    if (!existsSync(path)) {
      problems.push(`missing from the restore: ${entry.path}`);
      continue;
    }

    present.push(entry.path);

    const bytes = boxStateEntryBytes(path);

    restoredBytes += bytes;

    if (bytes !== entry.bytes) {
      problems.push(`size mismatch for ${entry.path}: restored ${bytes}, manifest ${entry.bytes}`);
    }
  }

  if (options.manifest.entries.length !== options.manifest.entryCount) {
    problems.push(
      `the manifest disagrees with itself: ${options.manifest.entries.length} entries, entryCount ${options.manifest.entryCount}`,
    );
  }

  checks.push(`${options.manifest.entryCount} archived entries present at the recorded sizes`);

  // Coverage is judged from what is ON DISK, not from what the manifest claims — a manifest
  // that lists `memories` the archive never carried must fail here, not read as covered.
  const shortfalls = checkBoxStateCoverage({
    entries: present,
    exists: (relativePath) => existsSync(join(options.root, relativePath)),
  });

  for (const shortfall of shortfalls) {
    problems.push(`load-bearing state missing — ${shortfall.what}: ${shortfall.detail}`);
  }

  if (shortfalls.length === 0) {
    checks.push(
      "the load-bearing set is present (gateway state db, memories, cron markers, the render conductor's box-id, a 0600 env file)",
    );
  }

  return { checks, problems, restoredBytes };
}

// ── The drill ────────────────────────────────────────────────────────────────

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);

  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

type Source = { cipher: Uint8Array; manifest: BoxStateManifest; object: string };

/** Read the artifact + manifest off the local disk — the `--file` mode, no credentials needed. */
function localSource(filePath: string, manifestArg: string | undefined): Source {
  const manifestPath = manifestArg ?? join(dirname(filePath), MANIFEST_NAME);

  if (!existsSync(filePath)) {
    fail(`artifact not found: ${filePath}`);
  }

  if (!existsSync(manifestPath)) {
    fail(`manifest not found (looked at ${manifestPath}); pass it with --manifest`);
  }

  return {
    cipher: new Uint8Array(readFileSync(filePath)),
    manifest: JSON.parse(readFileSync(manifestPath, "utf8")) as BoxStateManifest,
    object: filePath,
  };
}

/** Resolve which stored object this run is drilling, then GET it and its manifest. */
async function bucketSource(config: BackupR2Config): Promise<Source> {
  if (!config.accountId || !config.accessKeyId || !config.secretAccessKey) {
    fail(
      "missing bucket credentials — set R2_ACCOUNT_ID, FLUNCLE_BACKUP_R2_ACCESS_KEY_ID and FLUNCLE_BACKUP_R2_SECRET_ACCESS_KEY (or drill a local artifact with --file)",
    );
  }

  const explicitKey = argValue("--key");
  const date = argValue("--date");
  const prefix = hasFlag("--monthly") ? BOXSTATE_MONTHLY_PREFIX : BOXSTATE_DAILY_PREFIX;

  let artifactKey: string | null = explicitKey ?? null;

  if (artifactKey === null && date !== undefined) {
    artifactKey = `${prefix}${date}/${BOXSTATE_ARTIFACT_NAME}`;
  }

  if (artifactKey === null) {
    const keys = await signedList({
      accessKeyId: config.accessKeyId,
      bucketUrl: config.bucketUrl,
      prefix,
      secretAccessKey: config.secretAccessKey,
    });

    artifactKey = latestArtifactKey(keys, prefix);

    if (artifactKey === null) {
      fail(
        `no box-state artifact stored under ${prefix} — leg 2 is dormant until FLUNCLE_BOXSTATE_KEY is provisioned on the box`,
      );
    }
  }

  const credentials = {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  };

  log(`drilling ${artifactKey}`);

  const manifestBytes = await signedGet(
    `${config.bucketUrl}/${encodeKey(manifestKeyFor(artifactKey))}`,
    credentials,
  );
  const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8")) as BoxStateManifest;
  const cipher = await signedGet(`${config.bucketUrl}/${encodeKey(artifactKey)}`, {
    ...credentials,
    expectBytes: manifest.cipherBytes,
  });

  return { cipher, manifest, object: artifactKey };
}

async function main(): Promise<void> {
  const started = Date.now();
  const key = boxStateKeyFromEnv(process.env);

  if (!key) {
    fail("FLUNCLE_BOXSTATE_KEY is not set — the sealed artifact cannot be opened without it");
  }

  const filePath = argValue("--file");
  const source =
    filePath === undefined
      ? await bucketSource(backupR2Config())
      : localSource(filePath, argValue("--manifest"));

  const verified = await verifySealedArtifact({
    cipher: source.cipher,
    key,
    manifest: source.manifest,
  });

  const tamper = await proveTamperDetection(source.cipher, key);

  // A throwaway dir the drill created, and the ONLY place it writes. Never the live data dir.
  const scratch = mkdtempSync(join(tmpdir(), "fluncle-box-state-drill-"));
  const keepDir = argValue("--keep");

  try {
    unpackArchive(verified.plaintext, scratch);

    const restored = checkRestoredTree({
      manifest: source.manifest,
      root: join(scratch, "restored"),
    });
    const problems = [...restored.problems];

    if (!tamper.ok) {
      problems.push(`tamper-detection proof failed: ${tamper.detail}`);
    }

    if (keepDir !== undefined) {
      // The escape hatch still refuses to write over anything: a non-empty target could be the
      // live data dir, and this drill never restores over live state.
      if (existsSync(keepDir) && readdirSync(keepDir).length > 0) {
        fail(`--keep ${keepDir} is not empty — point it at a fresh directory`);
      }

      // 0700, like the temp dir it copies from: the tree carries the box's credential files.
      mkdirSync(keepDir, { mode: 0o700, recursive: true });
      cpSync(join(scratch, "restored"), keepDir, { recursive: true });
    }

    const ok = problems.length === 0;

    console.log(
      JSON.stringify(
        {
          artifactBytes: source.cipher.byteLength,
          checks: [...verified.checks, tamper.detail, ...restored.checks],
          elapsedMs: Date.now() - started,
          entryCount: source.manifest.entryCount,
          generatedAt: source.manifest.generatedAt,
          keptAt: keepDir ?? null,
          object: source.object,
          ok,
          plaintextBytes: verified.plaintext.byteLength,
          problems,
          restoredBytes: restored.restoredBytes,
          tamperDetected: tamper.ok,
        },
        null,
        2,
      ),
    );

    if (!ok) {
      fail(`RESTORE VERIFICATION FAILED (${problems.length} problem(s)) — see above`);
    }

    log(
      `OK — ${source.manifest.entryCount} entries, ${restored.restoredBytes} bytes restored + verified against the manifest in ${Date.now() - started}ms.`,
    );
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);

    console.log(JSON.stringify({ ok: false, problems: [message] }, null, 2));
    fail(`RESTORE DRILL FAILED — ${message}`);
  });
}
