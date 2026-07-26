// box-state-snapshot.ts — LEG 2 of the `fluncle-backup` cron: the backup of the BOX's own
// accumulated state, which until 2026-07-26 did not exist.
//
// WHY (read this before trimming anything). Four docs claimed the accumulated agent state —
// sessions, memories, kanban, cron-output history — "restores from the daily fluncle-backup
// → R2 backup". It did not: that sweep dumps the PRODUCTION DATABASE and never reads the
// agent data dir at all. The server has no attached volumes (state sits on the root disk)
// and no provider-level snapshots, so a disk loss permanently destroyed every load-bearing
// thing the box had accumulated — including the render conductor's `box-id`, whose loss
// ORPHANS a paid provisioned render box nobody can then find or delete.
//
// WHAT IS IN (small, unrecoverable, load-bearing):
//   - the gateway state db (`state.db` + its `-wal`/`-shm`) — sessions, memories index,
//     kanban, and the Discord channel binding
//   - `config.yaml` — the gateway's expanded config, the other half of the Discord binding
//   - `memories/` — the agent's own memory files
//   - `cron/output/` — the run markers `/status` judges every cron by
//   - `<home>/.render-conductor/` — the `box-id` and the poison ledger
//   - `<home>/.healthcheck/` — the prober's transition memory (tiny; keeps /status from
//     re-baselining every service as a fresh transition after a restore)
//   - the hand-placed 0600 `*.env` files in the data dir + the cron user's home
//
// WHAT IS DELIBERATELY OUT (and why the nightly is a few MB instead of ~5.4 GB):
//   - `audit-workspace/` + `sentry-triage-workspace/` — the audit/triage git checkouts,
//     ~5.3 GB of the 5.4 GB total. `git clone` restores them exactly.
//   - `skills/`, `scripts/` — baked into the image; the repo is canonical.
//   - `bin/`, `.bun/`, `.ascii/`, model + package caches — re-downloadable.
//   - `logs/` — diagnostics, not state.
// The exclusion is enforced, not just documented: `selectBoxStatePaths` DROPS any candidate
// that walks through an excluded segment, so a future edit to the include list can't quietly
// turn the nightly into a 5 GB upload.
//
// ENCRYPTION IS NOT OPTIONAL. The archive carries 0600 credential-bearing env files, and the
// standing rule for the agent home is "an encrypted/snapshot copy only — never a plaintext
// off-box tarball". So the artifact is AES-256-GCM sealed with an operator key BEFORE it
// leaves the process, and with NO key there is NO artifact — the leg skips rather than
// shipping plaintext. WebCrypto does the sealing: `age`/`gpg` are not in the image (adding a
// binary means an image rebake the operator must sequence), and R2 SSE would leave the
// plaintext-at-rest boundary with the same provider that holds the bucket, which is the
// opposite of what an owned off-site backup is for.
//
// THE KEY: `FLUNCLE_BOXSTATE_KEY`, 32 bytes as 64 hex chars or base64. The operator mints it
// (`openssl rand -hex 32`), stores it in 1Password, and adds it to the box's `op inject`
// template — see ../backup-timer/README.md § Leg 2. This file NEVER invents a default.
//
// Memory: bounded by `FLUNCLE_BOXSTATE_MAX_BYTES` (default 64 MiB). The selected paths are
// measured BEFORE `tar` runs and the archive is re-checked after, so an accidental fat
// include fails loudly instead of OOM-killing the sweep — the exact failure this whole
// change exists to end.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

/** The magic prefix of the sealed artifact. Also the AES-GCM additional-authenticated-data. */
export const BOX_STATE_MAGIC = "FLNCBOX1";

/** 96-bit nonce, the AES-GCM standard. */
const IV_BYTES = 12;

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Path segments that can never appear in the archive. A candidate whose relative path walks
 * through any of these is dropped by `selectBoxStatePaths`, whatever the include list says.
 */
export const BOX_STATE_EXCLUDED_SEGMENTS: readonly string[] = [
  ".ascii",
  ".bun",
  ".cache",
  ".git",
  ".npm",
  ".venv",
  "audit-workspace",
  "bin",
  "logs",
  "models",
  "muq-cache",
  "node_modules",
  "scripts",
  "sentry-triage-workspace",
  "skills",
];

/** One archived entry as the manifest records it: its path relative to the archive root. */
export type BoxStateEntry = { bytes: number; path: string };

export type BoxStateManifest = {
  /** Size of the PLAINTEXT tar.gz — what a restore expects after decrypting. */
  archiveBytes: number;
  /** Size of the uploaded, sealed artifact. */
  cipherBytes: number;
  encryption: string;
  entries: BoxStateEntry[];
  entryCount: number;
  generatedAt: string;
  /** The directory the archive's relative paths are rooted at (tar's `-C`). */
  root: string;
  /** SHA-256 of the PLAINTEXT tar.gz, so a restore can verify what it decrypted. */
  sha256: string;
};

/** The cron user's home, mirroring every other sweep's default. */
export function boxStateHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME ?? homedir();
}

/**
 * The include list, as ABSOLUTE paths. The data root is the parent of the cron user's home
 * (HOME=/opt/data/home → /opt/data), the same derivation the healthcheck prober uses to find
 * the cron output dir. Missing entries are fine — `selectBoxStatePaths` filters them.
 */
export function boxStateCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = boxStateHome(env);
  const dataRoot = dirname(home);

  const fromDataRoot = [
    "state.db",
    "state.db-wal",
    "state.db-shm",
    "config.yaml",
    ".env",
    "memories",
    join("cron", "output"),
  ].map((entry) => join(dataRoot, entry));

  const fromHome = [".render-conductor", ".healthcheck"].map((entry) => join(home, entry));

  // The hand-placed 0600 env files (`.fluncle-secrets.env` and any sibling) — discovered
  // rather than named, so a new one is covered the night it appears.
  const envFiles = [dataRoot, home].flatMap((dir) => {
    try {
      return readdirSync(dir)
        .filter((entry) => entry.endsWith(".env"))
        .map((entry) => join(dir, entry));
    } catch {
      return [];
    }
  });

  return [...new Set([...fromDataRoot, ...fromHome, ...envFiles])];
}

/** The archive root every entry is stored relative to: the data root. */
export function boxStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return dirname(boxStateHome(env));
}

/** True when `path`, relative to `root`, walks through an excluded segment. */
export function isBoxStateExcluded(path: string, root: string): boolean {
  const rel = relative(root, path);

  // Anything outside the root (`..`) is refused too — the archive is rooted, so an entry it
  // could not address is a bug, not a file to chase.
  if (rel === "" || rel.startsWith("..")) {
    return true;
  }

  return rel.split(sep).some((segment) => BOX_STATE_EXCLUDED_SEGMENTS.includes(segment));
}

/** Keep the candidates that exist, are inside the root, and clear the exclusion rule. */
export function selectBoxStatePaths(
  candidates: readonly string[],
  options: { exists?: (path: string) => boolean; root?: string } = {},
): string[] {
  const root = options.root ?? boxStateRoot();
  const exists = options.exists ?? existsSync;

  return candidates.filter((path) => !isBoxStateExcluded(path, root) && exists(path));
}

/** Recursive byte size of a file or directory. Bounded — these are the SMALL paths. */
function sizeOf(path: string): number {
  let stat;

  try {
    stat = statSync(path);
  } catch {
    return 0;
  }

  if (!stat.isDirectory()) {
    return stat.size;
  }

  let total = 0;

  try {
    for (const entry of readdirSync(path)) {
      total += sizeOf(join(path, entry));
    }
  } catch {
    /* unreadable subtree — counted as 0, tar will report it too */
  }

  return total;
}

/** Read the operator key: 64 hex chars or base64, decoding to exactly 32 bytes. */
export function boxStateKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Uint8Array | null {
  const raw = (env.FLUNCLE_BOXSTATE_KEY ?? "").trim();

  if (raw === "") {
    return null;
  }

  const bytes = /^[0-9a-fA-F]{64}$/.test(raw)
    ? new Uint8Array(Buffer.from(raw, "hex"))
    : new Uint8Array(Buffer.from(raw, "base64"));

  if (bytes.byteLength !== 32) {
    throw new Error("FLUNCLE_BOXSTATE_KEY must decode to 32 bytes (64 hex chars or base64)");
  }

  return bytes;
}

/**
 * Seal `plaintext` as `<magic><iv><ciphertext||tag>`. The magic doubles as the AAD, so a
 * truncated or re-headed artifact fails authentication rather than decrypting to garbage.
 */
export async function sealBoxState(plaintext: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  const magic = new TextEncoder().encode(BOX_STATE_MAGIC);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as unknown as ArrayBuffer,
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        additionalData: magic as unknown as ArrayBuffer,
        iv: iv as unknown as ArrayBuffer,
        name: "AES-GCM",
      },
      cryptoKey,
      plaintext as unknown as ArrayBuffer,
    ),
  );

  const out = new Uint8Array(magic.byteLength + iv.byteLength + sealed.byteLength);
  out.set(magic, 0);
  out.set(iv, magic.byteLength);
  out.set(sealed, magic.byteLength + iv.byteLength);

  return out;
}

/** The inverse of `sealBoxState` — the restore side, and what the tests round-trip through. */
export async function openBoxState(sealed: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  const magic = new TextEncoder().encode(BOX_STATE_MAGIC);
  const header = sealed.subarray(0, magic.byteLength);

  if (magic.some((byte, index) => header[index] !== byte)) {
    throw new Error("not a Fluncle box-state artifact (bad magic)");
  }

  const iv = sealed.subarray(magic.byteLength, magic.byteLength + IV_BYTES);
  const body = sealed.subarray(magic.byteLength + IV_BYTES);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as unknown as ArrayBuffer,
    "AES-GCM",
    false,
    ["decrypt"],
  );

  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        additionalData: magic as unknown as ArrayBuffer,
        iv: iv as unknown as ArrayBuffer,
        name: "AES-GCM",
      },
      cryptoKey,
      body as unknown as ArrayBuffer,
    ),
  );
}

/**
 * Build the sealed archive at `outPath` and return it with its manifest.
 *
 * Order: measure → tar → re-check → seal → write. The measure step is the memory rail: it
 * refuses an over-cap include list BEFORE spending disk or RAM on it.
 */
export async function buildBoxStateArchive(options: {
  generatedAt: Date;
  key: Uint8Array;
  maxBytes?: number;
  outPath: string;
  paths: readonly string[];
  root?: string;
  tarBin?: string;
  tempDir: string;
}): Promise<{ file: { bytes: number; path: string }; manifest: BoxStateManifest }> {
  const root = options.root ?? boxStateRoot();
  const maxBytes =
    options.maxBytes ?? Number(process.env.FLUNCLE_BOXSTATE_MAX_BYTES ?? DEFAULT_MAX_BYTES);

  if (options.paths.length === 0) {
    throw new Error("box-state snapshot has nothing to archive (no include path exists)");
  }

  const entries: BoxStateEntry[] = options.paths.map((path) => ({
    bytes: sizeOf(path),
    path: relative(root, path),
  }));
  const selectedBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);

  if (selectedBytes > maxBytes) {
    throw new Error(
      `box-state selection is ${selectedBytes} bytes, over the ${maxBytes}-byte cap — ` +
        "check the include list before raising FLUNCLE_BOXSTATE_MAX_BYTES",
    );
  }

  const tarPath = join(options.tempDir, `box-state-${process.pid}.tar.gz`);

  try {
    const tar = spawnSync(
      options.tarBin ?? "tar",
      ["-czf", tarPath, "-C", root, ...entries.map((entry) => entry.path)],
      { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] },
    );

    if (tar.error) {
      throw new Error(`tar unavailable: ${tar.error.message}`);
    }

    if (tar.status !== 0) {
      throw new Error(`tar exited ${tar.status}: ${(tar.stderr ?? "").trim().slice(0, 300)}`);
    }

    const plaintext = new Uint8Array(readFileSync(tarPath));

    if (plaintext.byteLength > maxBytes) {
      throw new Error(
        `box-state archive is ${plaintext.byteLength} bytes, over the ${maxBytes}-byte cap`,
      );
    }

    const sha256 = new Uint8Array(
      await crypto.subtle.digest("SHA-256", plaintext as unknown as ArrayBuffer),
    );
    const sealed = await sealBoxState(plaintext, options.key);

    writeFileSync(options.outPath, sealed, { mode: 0o600 });

    return {
      file: { bytes: sealed.byteLength, path: options.outPath },
      manifest: {
        archiveBytes: plaintext.byteLength,
        cipherBytes: sealed.byteLength,
        encryption: "AES-256-GCM",
        entries,
        entryCount: entries.length,
        generatedAt: options.generatedAt.toISOString(),
        root,
        sha256: Buffer.from(sha256).toString("hex"),
      },
    };
  } finally {
    await rm(tarPath, { force: true });
  }
}
