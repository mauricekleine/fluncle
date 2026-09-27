import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { takeLockDir, truncateCheckpoint } from "./device-mirror";

const scratch: string[] = [];

function scratchDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "device-mirror-lock-"));
  scratch.push(directory);

  return directory;
}

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const STALE_MS = 15 * 60_000;

function ageBy(path: string, ms: number): void {
  const old = new Date(Date.now() - ms);
  utimesSync(path, old, old);
}

describe("the device mirror's lock", () => {
  test("takes a free lock", async () => {
    const lockDir = join(scratchDir(), ".device-mirror.lock");

    expect(await takeLockDir(lockDir, { staleMs: STALE_MS })).toBe(true);
    expect(existsSync(lockDir)).toBe(true);
  });

  test("reports a live holder at once instead of waiting", async () => {
    const lockDir = join(scratchDir(), ".device-mirror.lock");
    mkdirSync(lockDir);
    const started = performance.now();

    expect(await takeLockDir(lockDir, { staleMs: STALE_MS })).toBe(false);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("takes over a lock left by a dead tick", async () => {
    const lockDir = join(scratchDir(), ".device-mirror.lock");
    mkdirSync(lockDir);
    ageBy(lockDir, 60 * 60_000);

    expect(await takeLockDir(lockDir, { staleMs: STALE_MS })).toBe(true);
    expect(existsSync(lockDir)).toBe(true);
  });

  test("fails fast when a stale lock directory cannot be removed", async () => {
    const lockDir = join(scratchDir(), ".device-mirror.lock");
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "stray"), "x");
    ageBy(lockDir, 60 * 60_000);
    const started = performance.now();

    const outcome = await takeLockDir(lockDir, { staleMs: STALE_MS }).then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(outcome).toContain("could not be removed");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("fails fast when a stale regular file sits at the lock path", async () => {
    const lockDir = join(scratchDir(), ".device-mirror.lock");
    writeFileSync(lockDir, "not a directory");
    ageBy(lockDir, 60 * 60_000);

    const outcome = await takeLockDir(lockDir, { staleMs: STALE_MS }).then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(outcome).toContain("could not be removed");
  });

  test("a stale holder that vanishes before its removal is retried once, not forever", async () => {
    const lockDir = join(scratchDir(), ".device-mirror.lock");
    mkdirSync(lockDir);
    ageBy(lockDir, 60 * 60_000);
    let looks = 0;

    const taken = await takeLockDir(lockDir, {
      now: () => {
        looks += 1;
        if (existsSync(lockDir)) {
          rmdirSync(lockDir);
        }
        return Date.now();
      },
      staleMs: STALE_MS,
    });

    expect(taken).toBe(true);
    expect(looks).toBeLessThanOrEqual(2);
  });
});

describe("the replica checkpoint", () => {
  function walDatabase(): { path: string; writer: Database } {
    const path = join(scratchDir(), "source-replica.db");
    const writer = new Database(path, { create: true, strict: true });
    writer.run("PRAGMA journal_mode = WAL");
    writer.run("create table tracks (track_id text primary key)");
    writer.run("insert into tracks values ('a')");

    return { path, writer };
  }

  test("fails loudly while a reader keeps the WAL from truncating", () => {
    const { path, writer } = walDatabase();
    const reader = new Database(path, { readonly: true, strict: true });
    reader.run("BEGIN");
    reader.query("select count(*) from tracks").get();
    writer.run("insert into tracks values ('b')");

    expect(() => truncateCheckpoint(writer, { attempts: 3, sleep: () => {} })).toThrow(
      "checkpoint stayed busy",
    );

    reader.run("COMMIT");
    reader.close();
    writer.close();
  });

  test("retries until the reader lets go, then completes", () => {
    const { path, writer } = walDatabase();
    const reader = new Database(path, { readonly: true, strict: true });
    reader.run("BEGIN");
    reader.query("select count(*) from tracks").get();
    writer.run("insert into tracks values ('b')");
    let waits = 0;

    truncateCheckpoint(writer, {
      attempts: 5,
      sleep: () => {
        waits += 1;
        if (reader.inTransaction) {
          reader.run("COMMIT");
        }
      },
    });

    expect(waits).toBe(1);
    reader.close();
    writer.close();
  });
});
