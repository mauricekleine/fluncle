#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REGISTRY = "https://registry.npmjs.org";
const DIST_TAG = "canary";
const REUSE_MS = 6 * 60 * 60 * 1000;
const VERSION = /^\d+\.\d+\.\d+-canary\.\d+\.\d+$/u;

type Dist = { readonly integrity: string; readonly tarball: string };
type Packument = {
  readonly "dist-tags": Readonly<Record<string, string>>;
  readonly versions: Readonly<Record<string, { readonly dist: Dist }>>;
};

function packageName(): string {
  const system = new Map([
    ["darwin", "darwin"],
    ["linux", "linux"],
  ]).get(process.platform);
  const cpu = new Map([
    ["arm64", "aarch64"],
    ["x64", "x64"],
  ]).get(process.arch);
  if (!system || !cpu) {
    throw new Error(`No Bun canary build for ${process.platform}/${process.arch}`);
  }
  return `@oven/bun-${system}-${cpu}`;
}

function installDirectory(): string {
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return process.env.BUN_CANARY_DIR || join(cache, "fluncle", "bun-canary");
}

function fresh(binary: string): boolean {
  return existsSync(binary) && Date.now() - statSync(binary).mtimeMs < REUSE_MS;
}

async function release(): Promise<{ dist: Dist; version: string }> {
  const name = packageName();
  const response = await fetch(`${REGISTRY}/${name.replace("/", "%2f")}`);
  if (!response.ok) {
    throw new Error(`npm registry answered ${response.status} for ${name}`);
  }
  const packument = (await response.json()) as Packument;
  const version = packument["dist-tags"][DIST_TAG];
  const dist = version ? packument.versions[version]?.dist : undefined;
  if (!version || !VERSION.test(version) || !dist) {
    throw new Error(`Unexpected ${name}@${DIST_TAG}: ${version ?? "missing"}`);
  }
  return { dist, version };
}

async function install(directory: string): Promise<string> {
  const binary = join(directory, "bun-canary");
  const { dist, version } = await release();
  const marker = join(directory, `${version}.installed`);
  if (existsSync(binary) && existsSync(marker)) {
    const now = new Date();
    utimesSync(binary, now, now);
    return binary;
  }

  const response = await fetch(dist.tarball);
  if (!response.ok) {
    throw new Error(`Downloading ${dist.tarball} failed with ${response.status}`);
  }
  const tarball = new Uint8Array(await response.arrayBuffer());
  const [algorithm, digest] = dist.integrity.split("-", 2);
  if (algorithm !== "sha512" || createHash("sha512").update(tarball).digest("base64") !== digest) {
    throw new Error(`Bun canary ${version} does not match its npm integrity`);
  }

  mkdirSync(directory, { recursive: true });
  const staging = mkdtempSync(join(directory, ".staging-"));
  try {
    const archive = join(staging, "package.tgz");
    await Bun.write(archive, tarball);
    const extract = Bun.spawnSync(["tar", "-xzf", archive, "-C", staging, "package/bin/bun"]);
    if (extract.exitCode !== 0) {
      throw new Error(`Extracting Bun canary ${version} failed: ${extract.stderr.toString()}`);
    }
    const extracted = join(staging, "package", "bin", "bun");
    chmodSync(extracted, 0o755);
    const probe = Bun.spawnSync([extracted, "--revision"]);
    if (probe.exitCode !== 0 || !probe.stdout.toString().includes("-canary.")) {
      throw new Error(`Bun canary ${version} does not run on this machine`);
    }
    renameSync(extracted, binary);
    const now = new Date();
    utimesSync(binary, now, now);
    for (const stale of new Bun.Glob("*.installed").scanSync(directory)) {
      rmSync(join(directory, stale), { force: true });
    }
    await Bun.write(marker, `${version}\n`);
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
  return binary;
}

async function resolveBinary(): Promise<string> {
  const onPath = Bun.which("bun-canary");
  if (onPath) {
    return onPath;
  }
  const directory = installDirectory();
  const cached = join(directory, "bun-canary");
  return fresh(cached) ? cached : install(directory);
}

const binary = await resolveBinary();
const child = Bun.spawn([binary, ...process.argv.slice(2)], {
  stderr: "inherit",
  stdin: "inherit",
  stdout: "inherit",
});
process.exit(await child.exited);
