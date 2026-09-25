#!/usr/bin/env bun

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

export function latestArtifactKey(keys: readonly string[], prefix: string): string | null {
  const artifacts = keys
    .filter((key) => key.startsWith(prefix) && key.endsWith(`/${BOXSTATE_ARTIFACT_NAME}`))
    .sort();

  return artifacts.at(-1) ?? null;
}

export function manifestKeyFor(artifactKey: string): string {
  const cut = artifactKey.lastIndexOf("/");

  return cut < 0 ? MANIFEST_NAME : `${artifactKey.slice(0, cut + 1)}${MANIFEST_NAME}`;
}

export type VerifyOutcome = { checks: string[]; plaintext: Uint8Array };

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
    await crypto.subtle.digest("SHA-256", new Uint8Array(plaintext)),
  ).toString("hex");

  if (sha256 !== manifest.sha256) {
    throw new Error(`archive SHA-256 ${sha256} != the manifest's ${manifest.sha256}`);
  }

  checks.push(`archive SHA-256 matches the manifest (${manifest.archiveBytes} bytes)`);

  return { checks, plaintext };
}

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

export function unpackArchive(plaintext: Uint8Array, dir: string, tarBin = "tar"): void {
  const tarPath = join(dir, "box-state.tar.gz");

  mkdirSync(dir, { recursive: true });

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

  const shortfalls = checkBoxStateCoverage({
    entries: present,
    exists: (relativePath) => existsSync(join(options.root, relativePath)),
  });

  for (const shortfall of shortfalls) {
    problems.push(`load-bearing state missing — ${shortfall.what}: ${shortfall.detail}`);
  }

  if (shortfalls.length === 0) {
    checks.push(
      "the load-bearing set is present (cron markers, the render conductor's box-id, a 0600 env file)",
    );
  }

  return { checks, problems, restoredBytes };
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);

  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

type Source = { cipher: Uint8Array; manifest: BoxStateManifest; object: string };

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
      if (existsSync(keepDir) && readdirSync(keepDir).length > 0) {
        fail(`--keep ${keepDir} is not empty — point it at a fresh directory`);
      }

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
