// Unit tests for the box-state RESTORE DRILL (box-state-restore-drill.ts) — the acceptance test
// that turns leg 2 of the backup cron from a hypothesis into a tested path.
//
// The drill only means something if it FAILS on a bad artifact, so every case here is driven
// through the REAL producer (`buildBoxStateArchive` from box-state-snapshot.ts) rather than a
// hand-rolled fake: the round trip proves producer and drill agree, and each corruption case
// proves the drill refuses what a restore must never accept.
//
//   1. Happy path — produce → verify → decrypt → unpack → the load-bearing set is there.
//   2. Corrupted ciphertext, a wrong key, a truncated artifact, a manifest that disagrees on the
//      SHA-256 or the length: every one is a hard failure with a message naming the mismatch.
//   3. The key is read the way the producer reads it — 64 hex chars OR base64.
//   4. Coverage is judged from the producer's own include list: drop the render conductor's
//      `box-id` (or the env file, or the memories) and the drill says so.
//   5. The bucket half — latest-daily resolution and a signed GET — against a loopback fixture.
//
//   bun test docs/agents/hermes/scripts/box-state-restore-drill.test.ts

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BOXSTATE_DAILY_PREFIX, signS3Request } from "./backup-sweep";

import {
  type BoxStateManifest,
  boxStateKeyFromEnv,
  buildBoxStateArchive,
  checkBoxStateCoverage,
  selectBoxStatePaths,
} from "./box-state-snapshot";

import {
  checkRestoredTree,
  latestArtifactKey,
  manifestKeyFor,
  proveTamperDetection,
  signedGet,
  unpackArchive,
  verifySealedArtifact,
} from "./box-state-restore-drill";

const KEY = new Uint8Array(32).fill(9);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

/** The message a rejected promise carries — `expect().rejects` is not type-aware-lint clean. */
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;

    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

type Produced = { cipher: Uint8Array; manifest: BoxStateManifest; root: string };

/**
 * A miniature data root shaped like the box's, run through the REAL producer. `omit` names path
 * TAILS to leave out, so a test can ask what the drill does about a hole in the archive.
 */
async function produce(omit: readonly string[] = []): Promise<Produced> {
  const root = mkdtempSync(join(tmpdir(), "fluncle-drill-src-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");

  mkdirSync(join(root, "memories"), { recursive: true });
  mkdirSync(join(root, "cron", "output", "fluncle-backup"), { recursive: true });
  mkdirSync(join(home, ".render-conductor"), { recursive: true });

  writeFileSync(join(root, "state.db"), "gateway-state");
  writeFileSync(join(root, "memories", "crew.md"), "the crew");
  writeFileSync(join(root, "cron", "output", "fluncle-backup", "run.md"), "# Cron Job\n");
  writeFileSync(join(home, ".render-conductor", "box-id"), "provisioned-box");
  writeFileSync(join(home, ".render-conductor", "poison"), "");
  writeFileSync(join(home, ".fluncle-secrets.env"), "TOKEN=redacted\n", { mode: 0o600 });

  const candidates = [
    join(root, "state.db"),
    join(root, "memories"),
    join(root, "cron", "output"),
    join(home, ".render-conductor"),
    join(home, ".fluncle-secrets.env"),
  ].filter((path) => !omit.some((tail) => path.endsWith(tail)));

  const out = mkdtempSync(join(tmpdir(), "fluncle-drill-out-"));
  temporaryDirectories.push(out);
  const outPath = join(out, "box-state.tar.gz.enc");

  const { manifest } = await buildBoxStateArchive({
    generatedAt: new Date("2026-07-26T02:00:00.000Z"),
    key: KEY,
    outPath,
    paths: selectBoxStatePaths(candidates, { root }),
    root,
    tempDir: out,
  });

  return { cipher: new Uint8Array(readFileSync(outPath)), manifest, root };
}

/** The drill's own steps, run end to end the way `main()` runs them. */
async function drill(
  produced: Produced,
  key: Uint8Array = KEY,
): Promise<{ problems: string[]; scratch: string }> {
  const { plaintext } = await verifySealedArtifact({
    cipher: produced.cipher,
    key,
    manifest: produced.manifest,
  });
  const scratch = mkdtempSync(join(tmpdir(), "fluncle-drill-unpack-"));
  temporaryDirectories.push(scratch);

  unpackArchive(plaintext, scratch);

  const restored = checkRestoredTree({
    manifest: produced.manifest,
    root: join(scratch, "restored"),
  });

  return { problems: restored.problems, scratch };
}

describe("the happy path — a produced artifact restores and verifies", () => {
  test("verify → decrypt → unpack → the load-bearing set is all there", async () => {
    const produced = await produce();
    const { problems, scratch } = await drill(produced);

    try {
      expect(problems).toEqual([]);

      const restored = join(scratch, "restored");

      // Not merely "some files": the things a rebuild needs, with their contents intact.
      expect(readFileSync(join(restored, "state.db"), "utf8")).toBe("gateway-state");
      expect(readFileSync(join(restored, "memories", "crew.md"), "utf8")).toBe("the crew");
      expect(readFileSync(join(restored, "home", ".render-conductor", "box-id"), "utf8")).toBe(
        "provisioned-box",
      );
      expect(
        readFileSync(join(restored, "cron", "output", "fluncle-backup", "run.md"), "utf8"),
      ).toBe("# Cron Job\n");
      expect(readFileSync(join(restored, "home", ".fluncle-secrets.env"), "utf8")).toBe(
        "TOKEN=redacted\n",
      );
    } finally {
      rmSync(scratch, { force: true, recursive: true });
    }
  });

  test("the checks it reports name what was actually proven", async () => {
    const produced = await produce();
    const { checks } = await verifySealedArtifact({
      cipher: produced.cipher,
      key: KEY,
      manifest: produced.manifest,
    });

    expect(checks.join(" | ")).toContain("FLNCBOX1");
    expect(checks.join(" | ")).toContain("SHA-256 matches the manifest");
  });

  test("a hex key and a base64 key are both accepted, exactly as the producer reads them", async () => {
    const hex = Buffer.from(KEY).toString("hex");
    const base64 = Buffer.from(KEY).toString("base64");
    const produced = await produce();

    for (const raw of [hex, base64]) {
      const key = boxStateKeyFromEnv({ FLUNCLE_BOXSTATE_KEY: raw } as NodeJS.ProcessEnv);

      expect(key).not.toBeNull();

      const { plaintext } = await verifySealedArtifact({
        cipher: produced.cipher,
        key: key ?? new Uint8Array(),
        manifest: produced.manifest,
      });

      expect(plaintext.byteLength).toBe(produced.manifest.archiveBytes);
    }
  });
});

describe("tamper-detection is PROVEN, not assumed", () => {
  test("a flipped ciphertext byte is refused by the GCM tag", async () => {
    const produced = await produce();

    expect(await proveTamperDetection(produced.cipher, KEY)).toEqual({
      detail: "a flipped ciphertext byte is refused by the GCM tag",
      ok: true,
    });
  });

  test("the proof leaves the artifact it was given untouched", async () => {
    const produced = await produce();
    const before = Buffer.from(produced.cipher).toString("base64");

    await proveTamperDetection(produced.cipher, KEY);

    expect(Buffer.from(produced.cipher).toString("base64")).toBe(before);
  });
});

describe("everything a restore must refuse", () => {
  test("corrupted ciphertext ⇒ decryption fails, loudly", async () => {
    const produced = await produce();
    const cipher = new Uint8Array(produced.cipher);
    const index = cipher.length - 20;

    cipher[index] = (cipher[index] ?? 0) ^ 0xff;

    expect(
      await rejectionMessage(
        verifySealedArtifact({ cipher, key: KEY, manifest: produced.manifest }),
      ),
    ).toContain("decryption failed");
  });

  test("a wrong key ⇒ decryption fails (it does not return garbage)", async () => {
    const produced = await produce();

    expect(
      await rejectionMessage(
        verifySealedArtifact({
          cipher: produced.cipher,
          key: new Uint8Array(32).fill(1),
          manifest: produced.manifest,
        }),
      ),
    ).toContain("decryption failed");
  });

  test("a truncated artifact ⇒ the length check catches it before decryption", async () => {
    const produced = await produce();
    const cipher = produced.cipher.subarray(0, produced.cipher.length - 64);

    expect(
      await rejectionMessage(
        verifySealedArtifact({ cipher, key: KEY, manifest: produced.manifest }),
      ),
    ).toContain("truncated or was replaced");
  });

  test("a truncated artifact whose manifest agrees ⇒ still fails, on the tag", async () => {
    // The nastier case: someone re-recorded the length after the truncation. GCM is the backstop.
    const produced = await produce();
    const cipher = produced.cipher.subarray(0, produced.cipher.length - 64);

    expect(
      await rejectionMessage(
        verifySealedArtifact({
          cipher,
          key: KEY,
          manifest: { ...produced.manifest, cipherBytes: cipher.byteLength },
        }),
      ),
    ).toContain("decryption failed");
  });

  test("a manifest SHA-256 that disagrees ⇒ hard failure naming the hash", async () => {
    const produced = await produce();

    expect(
      await rejectionMessage(
        verifySealedArtifact({
          cipher: produced.cipher,
          key: KEY,
          manifest: { ...produced.manifest, sha256: "0".repeat(64) },
        }),
      ),
    ).toContain("SHA-256");
  });

  test("a manifest archive size that disagrees ⇒ hard failure", async () => {
    const produced = await produce();

    expect(
      await rejectionMessage(
        verifySealedArtifact({
          cipher: produced.cipher,
          key: KEY,
          manifest: { ...produced.manifest, archiveBytes: produced.manifest.archiveBytes + 1 },
        }),
      ),
    ).toContain("decrypted archive is");
  });

  test("an artifact that is not one of ours ⇒ bad magic, before any key work", async () => {
    const cipher = new Uint8Array(64).fill(3);

    expect(
      await rejectionMessage(
        verifySealedArtifact({
          cipher,
          key: KEY,
          manifest: { cipherBytes: 64 } as BoxStateManifest,
        }),
      ),
    ).toContain("bad magic");
  });

  test("a manifest entry that did not come back ⇒ the restore check says which", async () => {
    const produced = await produce();
    const { plaintext } = await verifySealedArtifact({
      cipher: produced.cipher,
      key: KEY,
      manifest: produced.manifest,
    });
    const scratch = mkdtempSync(join(tmpdir(), "fluncle-drill-unpack-"));
    temporaryDirectories.push(scratch);

    try {
      unpackArchive(plaintext, scratch);

      const restored = checkRestoredTree({
        manifest: {
          ...produced.manifest,
          entries: [...produced.manifest.entries, { bytes: 12, path: "never-archived" }],
        },
        root: join(scratch, "restored"),
      });

      expect(restored.problems.join(" | ")).toContain("missing from the restore: never-archived");
    } finally {
      rmSync(scratch, { force: true, recursive: true });
    }
  });

  test("a size that drifted from the manifest ⇒ named as a mismatch", async () => {
    const produced = await produce();
    const { plaintext } = await verifySealedArtifact({
      cipher: produced.cipher,
      key: KEY,
      manifest: produced.manifest,
    });
    const scratch = mkdtempSync(join(tmpdir(), "fluncle-drill-unpack-"));
    temporaryDirectories.push(scratch);

    try {
      unpackArchive(plaintext, scratch);

      const entries = produced.manifest.entries.map((entry) =>
        entry.path === "state.db" ? { ...entry, bytes: entry.bytes + 5 } : entry,
      );
      const restored = checkRestoredTree({
        manifest: { ...produced.manifest, entries },
        root: join(scratch, "restored"),
      });

      expect(restored.problems.join(" | ")).toContain("size mismatch for state.db");
    } finally {
      rmSync(scratch, { force: true, recursive: true });
    }
  });
});

describe("the load-bearing set — derived from the producer's include list", () => {
  test("an archive without the render conductor fails the drill", async () => {
    const produced = await produce([".render-conductor"]);
    const { problems, scratch } = await drill(produced);

    try {
      expect(problems.join(" | ")).toContain("the render conductor's box-id");
    } finally {
      rmSync(scratch, { force: true, recursive: true });
    }
  });

  test("a .render-conductor archived WITHOUT its box-id fails too", () => {
    // The nested requirement: the directory is there, the one file that matters is not.
    const shortfalls = checkBoxStateCoverage({
      entries: ["state.db", "memories", "cron/output", "home/.render-conductor", "home/x.env"],
      exists: (path) => path !== "home/.render-conductor/box-id",
    });

    expect(shortfalls.map((shortfall) => shortfall.detail)).toEqual([
      "home/.render-conductor is missing box-id",
    ]);
  });

  test("no env file at all ⇒ the credential-bearing half went missing", () => {
    const shortfalls = checkBoxStateCoverage({
      entries: ["state.db", "memories", "cron/output", "home/.render-conductor"],
      exists: () => true,
    });

    expect(shortfalls.map((shortfall) => shortfall.what)).toEqual([
      "the hand-placed 0600 env files",
    ]);
  });

  test("the memories and the cron markers are required, the optional entries are not", () => {
    expect(
      checkBoxStateCoverage({
        entries: ["state.db", "home/.render-conductor", "home/x.env"],
        exists: () => true,
      }).map((shortfall) => shortfall.what),
    ).toEqual(["the agent's memories", "the cron run markers"]);

    // config.yaml / .healthcheck / the SQLite sidecars are re-derivable — never a drill failure.
    expect(
      checkBoxStateCoverage({
        entries: ["state.db", "memories", "cron/output", "home/.render-conductor", "home/x.env"],
        exists: () => true,
      }),
    ).toEqual([]);
  });

  test("a full archive passes coverage whatever the cron user's home is called", () => {
    for (const home of ["home", "hermes", "opt-data-home"]) {
      expect(
        checkBoxStateCoverage({
          entries: [
            "state.db",
            "memories",
            "cron/output",
            `${home}/.render-conductor`,
            `${home}/.fluncle-secrets.env`,
          ],
          exists: () => true,
        }),
      ).toEqual([]);
    }
  });
});

describe("the bucket half — read-only", () => {
  test("the latest daily artifact is the newest dated folder", () => {
    const keys = [
      `${BOXSTATE_DAILY_PREFIX}2026-07-24/box-state.tar.gz.enc`,
      `${BOXSTATE_DAILY_PREFIX}2026-07-24/manifest.json`,
      `${BOXSTATE_DAILY_PREFIX}2026-07-26/box-state.tar.gz.enc`,
      `${BOXSTATE_DAILY_PREFIX}2026-07-25/box-state.tar.gz.enc`,
      "db-backups/daily/2026-07-27/fluncle.sql.gz",
    ];

    expect(latestArtifactKey(keys, BOXSTATE_DAILY_PREFIX)).toBe(
      `${BOXSTATE_DAILY_PREFIX}2026-07-26/box-state.tar.gz.enc`,
    );
    expect(latestArtifactKey([], BOXSTATE_DAILY_PREFIX)).toBeNull();
  });

  test("the manifest is the artifact's sibling", () => {
    expect(manifestKeyFor(`${BOXSTATE_DAILY_PREFIX}2026-07-26/box-state.tar.gz.enc`)).toBe(
      `${BOXSTATE_DAILY_PREFIX}2026-07-26/manifest.json`,
    );
  });

  test("a signed GET fetches the object and refuses one whose length disagrees", async () => {
    const payload = Buffer.from("sealed-bytes");
    let seenHeaders: Record<string, string> = {};

    const server = Bun.serve({
      fetch: (request) => {
        seenHeaders = Object.fromEntries(request.headers.entries());

        return new Response(payload, { status: 200 });
      },
      hostname: "127.0.0.1",
      port: 0,
    });

    try {
      const bytes = await signedGet(`${server.url.origin}/fluncle-backups/box-state/x.enc`, {
        accessKeyId: "test-access-key",
        expectBytes: payload.byteLength,
        secretAccessKey: "test-secret-key",
      });

      expect(Buffer.from(bytes).toString("utf8")).toBe("sealed-bytes");
      expect(seenHeaders.authorization).toContain("Credential=test-access-key/");

      expect(
        await rejectionMessage(
          signedGet(`${server.url.origin}/fluncle-backups/box-state/x.enc`, {
            accessKeyId: "test-access-key",
            expectBytes: payload.byteLength + 1,
            secretAccessKey: "test-secret-key",
          }),
        ),
      ).toContain("refusing to read it");
    } finally {
      await server.stop(true);
    }
  });

  test("a 404 or a denial is a failure, never an empty 'restore'", async () => {
    const server = Bun.serve({
      fetch: () => new Response("NoSuchKey", { status: 404 }),
      hostname: "127.0.0.1",
      port: 0,
    });

    try {
      expect(
        await rejectionMessage(
          signedGet(`${server.url.origin}/fluncle-backups/box-state/missing.enc`, {
            accessKeyId: "k",
            secretAccessKey: "s",
          }),
        ),
      ).toContain("failed (404)");
    } finally {
      await server.stop(true);
    }
  });

  test("the drill signs its reads with the same signer the sweep writes with", async () => {
    // Not a second signing implementation: the same exported `signS3Request`, GET-side.
    const headers = await signS3Request({
      accessKeyId: "test-access-key",
      method: "GET",
      now: new Date("2026-07-26T02:00:00.000Z"),
      region: "auto",
      secretAccessKey: "test-secret-key",
      service: "s3",
      url: "https://example.invalid/bucket/key",
    });

    expect(headers.authorization).toContain("Credential=test-access-key/20260726/auto/s3");
  });
});
