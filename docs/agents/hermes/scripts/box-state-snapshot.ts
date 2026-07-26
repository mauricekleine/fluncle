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
// THE ACCEPTANCE TEST: box-state-restore-drill.ts, the sibling of the database dump's
// apps/web/scripts/restore-drill.ts. It fetches a stored artifact, verifies it against the
// manifest, decrypts it, proves the GCM tamper-detection actually bites, unpacks it into a
// throwaway dir, and checks the load-bearing set came back — reading `BOX_STATE_INCLUDES`
// below, so its expectation cannot drift from what this file archives.
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

/**
 * One line of the include list.
 *
 * The list is DATA rather than a literal inside `boxStateCandidates` because two callers need
 * it: the producer (which turns it into absolute candidate paths) and the restore drill (which
 * asks "did the load-bearing set actually come back?"). A drill carrying its own copy of that
 * expectation drifts the first time this list is edited, so it reads this one instead.
 */
export type BoxStateInclude = {
  /** Which anchor `path` hangs off: the data root, or the cron user's home inside it. */
  base: "dataRoot" | "home";
  /** Paths inside this entry a RESTORE must find — the `box-id` case. Relative to the entry. */
  contains?: readonly string[];
  /** The path, relative to `base`. */
  path: string;
  /**
   * True when a restore that lacks this entry is not a restore. False for the entries that are
   * transient (the SQLite sidecars exist only while the db is open) or re-derivable from the
   * repo/image (`config.yaml` is deployed, `.healthcheck` re-baselines itself).
   */
  required: boolean;
  /** What it is, in words, so a drill's failure names the thing rather than the path. */
  what: string;
};

/** Every archived path, declared once. `boxStateCandidates` and the restore drill both read it. */
export const BOX_STATE_INCLUDES: readonly BoxStateInclude[] = [
  { base: "dataRoot", path: "state.db", required: true, what: "the gateway state db" },
  { base: "dataRoot", path: "state.db-wal", required: false, what: "the state db's WAL" },
  { base: "dataRoot", path: "state.db-shm", required: false, what: "the state db's shared memory" },
  { base: "dataRoot", path: "config.yaml", required: false, what: "the gateway's expanded config" },
  { base: "dataRoot", path: ".env", required: false, what: "the data root's env file" },
  { base: "dataRoot", path: "memories", required: true, what: "the agent's memories" },
  { base: "dataRoot", path: join("cron", "output"), required: true, what: "the cron run markers" },
  {
    base: "home",
    contains: ["box-id"],
    path: ".render-conductor",
    required: true,
    what: "the render conductor's box-id + poison ledger",
  },
  {
    base: "home",
    path: ".healthcheck",
    required: false,
    what: "the prober's transition memory",
  },
];

/**
 * The suffix that makes a file one of the hand-placed `0600` env files. Those are DISCOVERED
 * rather than named (so a new one is covered the night it appears), which means the restore
 * expectation is a shape — "at least one" — rather than a path.
 */
export const BOX_STATE_ENV_SUFFIX = ".env";

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

  const declared = BOX_STATE_INCLUDES.map((include) =>
    join(include.base === "home" ? home : dataRoot, include.path),
  );

  // The hand-placed 0600 env files (`.fluncle-secrets.env` and any sibling) — discovered
  // rather than named, so a new one is covered the night it appears.
  const envFiles = [dataRoot, home].flatMap((dir) => {
    try {
      return readdirSync(dir)
        .filter((entry) => entry.endsWith(BOX_STATE_ENV_SUFFIX))
        .map((entry) => join(dir, entry));
    } catch {
      return [];
    }
  });

  return [...new Set([...declared, ...envFiles])];
}

/** One load-bearing thing a restore did not bring back. */
export type BoxStateShortfall = { detail: string; what: string };

/**
 * Judge a RESTORED tree against the include list: is everything a rebuild needs actually here?
 *
 * `entries` are archive-relative paths (the manifest's, or a real unpacked tree's) and `exists`
 * probes that tree for a nested path. Both are injected so the drill can run this against an
 * unpacked archive and the tests against a fixture, with no filesystem assumption in here.
 *
 * The archive is rooted at the DATA ROOT, so a `home`-based include reads as `<home>/<path>` —
 * and the cron user's home directory NAME is deployment detail this file does not hardcode.
 * Hence the tail match: the entry either IS the path or ends with it.
 */
export function checkBoxStateCoverage(options: {
  entries: readonly string[];
  exists: (relativePath: string) => boolean;
}): BoxStateShortfall[] {
  const normalise = (path: string) => path.split(sep).join("/").replace(/^\.\//, "");
  const entries = options.entries.map(normalise);
  const shortfalls: BoxStateShortfall[] = [];

  for (const include of BOX_STATE_INCLUDES) {
    if (!include.required) {
      continue;
    }

    const wanted = normalise(include.path);
    const matched = entries.find((entry) => entry === wanted || entry.endsWith(`/${wanted}`));

    if (matched === undefined) {
      shortfalls.push({ detail: `no archived entry for ${wanted}`, what: include.what });
      continue;
    }

    for (const nested of include.contains ?? []) {
      if (!options.exists(`${matched}/${nested}`)) {
        shortfalls.push({ detail: `${matched} is missing ${nested}`, what: include.what });
      }
    }
  }

  // The env files are discovered, not declared — so the requirement is that at least one came
  // back. Zero means the credential-bearing half of the snapshot silently went missing.
  if (!entries.some((entry) => entry.endsWith(BOX_STATE_ENV_SUFFIX))) {
    shortfalls.push({
      detail: `no archived entry ending in ${BOX_STATE_ENV_SUFFIX}`,
      what: "the hand-placed 0600 env files",
    });
  }

  return shortfalls;
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

/**
 * Recursive byte size of a file or directory. Bounded — these are the SMALL paths.
 *
 * Exported because the restore drill re-measures a RESTORED entry and compares it with the
 * manifest: two different size definitions (does a directory's own inode count?) would make
 * every directory look corrupt, so both sides call this one.
 */
export function boxStateEntryBytes(path: string): number {
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
      total += boxStateEntryBytes(join(path, entry));
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
    bytes: boxStateEntryBytes(path),
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
