import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

export const BOX_STATE_MAGIC = "FLNCBOX1";

const IV_BYTES = 12;

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

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

export type BoxStateEntry = { bytes: number; path: string };

export type BoxStateInclude = {
  base: "dataRoot" | "home";

  contains?: readonly string[];

  path: string;

  required: boolean;

  what: string;
};

export const BOX_STATE_INCLUDES: readonly BoxStateInclude[] = [
  { base: "dataRoot", path: ".env", required: false, what: "the data root's env file" },
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
  {
    base: "home",
    path: ".entity-bio-sweep",
    required: false,
    what: "the entity-bio sweep's per-entity attempt budgets",
  },
];

export const BOX_STATE_ENV_SUFFIX = ".env";

export type BoxStateManifest = {
  archiveBytes: number;

  cipherBytes: number;
  encryption: string;
  entries: BoxStateEntry[];
  entryCount: number;
  generatedAt: string;

  root: string;

  sha256: string;
};

export function boxStateHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME ?? homedir();
}

export function boxStateCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = boxStateHome(env);
  const dataRoot = dirname(home);

  const declared = BOX_STATE_INCLUDES.map((include) =>
    join(include.base === "home" ? home : dataRoot, include.path),
  );

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

export type BoxStateShortfall = { detail: string; what: string };

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

  if (!entries.some((entry) => entry.endsWith(BOX_STATE_ENV_SUFFIX))) {
    shortfalls.push({
      detail: `no archived entry ending in ${BOX_STATE_ENV_SUFFIX}`,
      what: "the hand-placed 0600 env files",
    });
  }

  return shortfalls;
}

export function boxStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return dirname(boxStateHome(env));
}

export function isBoxStateExcluded(path: string, root: string): boolean {
  const rel = relative(root, path);

  if (rel === "" || rel.startsWith("..")) {
    return true;
  }

  return rel.split(sep).some((segment) => BOX_STATE_EXCLUDED_SEGMENTS.includes(segment));
}

export function selectBoxStatePaths(
  candidates: readonly string[],
  options: { exists?: (path: string) => boolean; root?: string } = {},
): string[] {
  const root = options.root ?? boxStateRoot();
  const exists = options.exists ?? existsSync;

  return candidates.filter((path) => !isBoxStateExcluded(path, root) && exists(path));
}

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
  } catch {}

  return total;
}

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

function webCryptoBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

export async function sealBoxState(plaintext: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  const magic = webCryptoBytes(new TextEncoder().encode(BOX_STATE_MAGIC));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cryptoKey = await crypto.subtle.importKey("raw", webCryptoBytes(key), "AES-GCM", false, [
    "encrypt",
  ]);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        additionalData: magic,
        iv,
        name: "AES-GCM",
      },
      cryptoKey,
      webCryptoBytes(plaintext),
    ),
  );

  const out = new Uint8Array(magic.byteLength + iv.byteLength + sealed.byteLength);
  out.set(magic, 0);
  out.set(iv, magic.byteLength);
  out.set(sealed, magic.byteLength + iv.byteLength);

  return out;
}

export async function openBoxState(sealed: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  const magic = webCryptoBytes(new TextEncoder().encode(BOX_STATE_MAGIC));
  const header = sealed.subarray(0, magic.byteLength);

  if (magic.some((byte, index) => header[index] !== byte)) {
    throw new Error("not a Fluncle box-state artifact (bad magic)");
  }

  const iv = sealed.subarray(magic.byteLength, magic.byteLength + IV_BYTES);
  const body = sealed.subarray(magic.byteLength + IV_BYTES);
  const cryptoKey = await crypto.subtle.importKey("raw", webCryptoBytes(key), "AES-GCM", false, [
    "decrypt",
  ]);

  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        additionalData: magic,
        iv: webCryptoBytes(iv),
        name: "AES-GCM",
      },
      cryptoKey,
      webCryptoBytes(body),
    ),
  );
}

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

    const sha256 = new Uint8Array(await crypto.subtle.digest("SHA-256", webCryptoBytes(plaintext)));
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
