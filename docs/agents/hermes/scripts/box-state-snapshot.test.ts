// Unit tests for LEG 2 of the backup cron — the box-state snapshot (box-state-snapshot.ts).
//
// Three things have to hold or this leg is worse than not having it:
//   1. The include list stays SMALL. The agent data dir is ~5.4 GB, of which ~5.3 GB is the
//      audit/triage git checkouts — restorable with `git clone`. The exclusion rule is
//      enforced in code, so a future edit to the include list can't quietly turn a few-MB
//      nightly into a 5 GB one.
//   2. The artifact is ENCRYPTED. It carries the 0600 credential-bearing env files, and the
//      standing rule for the agent home is "an encrypted copy only — never a plaintext
//      off-box tarball". With no key there must be NO artifact.
//   3. What comes back out is what went in — including file modes, since `0600` on a
//      restored secrets file is not cosmetic.
//
//   bun test docs/agents/hermes/scripts/box-state-snapshot.test.ts

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BOX_STATE_MAGIC,
  boxStateCandidates,
  boxStateKeyFromEnv,
  buildBoxStateArchive,
  isBoxStateExcluded,
  openBoxState,
  sealBoxState,
  selectBoxStatePaths,
} from "./box-state-snapshot";

const KEY = new Uint8Array(32).fill(9);

/** The message a rejected promise carries — `expect().rejects` is not type-aware-lint clean. */
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;

    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** A miniature data root shaped like the box's: `<root>` with a `home` inside it. */
function fakeDataRoot(): { home: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "fluncle-boxstate-"));
  const home = join(root, "home");

  mkdirSync(join(root, "memories"), { recursive: true });
  mkdirSync(join(root, "cron", "output", "fluncle-backup"), { recursive: true });
  mkdirSync(join(home, ".render-conductor"), { recursive: true });
  mkdirSync(join(home, "audit-workspace", "fluncle"), { recursive: true });

  writeFileSync(join(root, "state.db"), "gateway-state");
  writeFileSync(join(root, "memories", "crew.md"), "the crew");
  writeFileSync(join(root, "cron", "output", "fluncle-backup", "run.md"), "# Cron Job\n");
  writeFileSync(join(home, ".render-conductor", "box-id"), "provisioned-box");
  writeFileSync(join(home, ".fluncle-secrets.env"), "TOKEN=redacted\n", { mode: 0o600 });
  writeFileSync(join(home, "audit-workspace", "fluncle", "huge.bin"), "x".repeat(4096));

  return { home, root };
}

describe("the include / exclude rule", () => {
  test("the default candidates name the load-bearing state and nothing else", () => {
    const candidates = boxStateCandidates({ HOME: "/opt/data/home" } as NodeJS.ProcessEnv);

    for (const expected of [
      "/opt/data/state.db",
      "/opt/data/config.yaml",
      "/opt/data/memories",
      "/opt/data/cron/output",
      "/opt/data/home/.render-conductor",
      "/opt/data/home/.healthcheck",
    ]) {
      expect(candidates).toContain(expected);
    }

    // The two multi-GB git checkouts are never even candidates.
    expect(candidates.some((path) => path.includes("audit-workspace"))).toBe(false);
    expect(candidates.some((path) => path.includes("sentry-triage-workspace"))).toBe(false);
  });

  test("the audit + triage checkouts are refused even if someone adds them back", () => {
    const root = "/opt/data";

    expect(isBoxStateExcluded("/opt/data/home/audit-workspace/fluncle", root)).toBe(true);
    expect(isBoxStateExcluded("/opt/data/home/sentry-triage-workspace/fluncle", root)).toBe(true);
    expect(isBoxStateExcluded("/opt/data/skills", root)).toBe(true);
    expect(isBoxStateExcluded("/opt/data/logs", root)).toBe(true);
    expect(isBoxStateExcluded("/opt/data/home/.bun/install/cache", root)).toBe(true);
    // …and a path outside the archive root, which the archive could not address anyway.
    expect(isBoxStateExcluded("/etc/shadow", root)).toBe(true);

    expect(isBoxStateExcluded("/opt/data/state.db", root)).toBe(false);
    expect(isBoxStateExcluded("/opt/data/home/.render-conductor", root)).toBe(false);
  });

  test("selection drops what does not exist and what is excluded", () => {
    const { home, root } = fakeDataRoot();

    const selected = selectBoxStatePaths(
      [
        join(root, "state.db"),
        join(root, "memories"),
        join(root, "does-not-exist"),
        join(home, "audit-workspace", "fluncle"),
      ],
      { root },
    );

    expect(selected).toEqual([join(root, "state.db"), join(root, "memories")]);
  });
});

describe("the key", () => {
  test("absent ⇒ null, so the leg can skip instead of shipping plaintext", () => {
    expect(boxStateKeyFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(boxStateKeyFromEnv({ FLUNCLE_BOXSTATE_KEY: "  " } as NodeJS.ProcessEnv)).toBeNull();
  });

  test("reads 64 hex chars or base64, and refuses anything that isn't 32 bytes", () => {
    const hex = "a".repeat(64);

    expect(boxStateKeyFromEnv({ FLUNCLE_BOXSTATE_KEY: hex } as NodeJS.ProcessEnv)?.byteLength).toBe(
      32,
    );
    expect(
      boxStateKeyFromEnv({
        FLUNCLE_BOXSTATE_KEY: Buffer.alloc(32, 3).toString("base64"),
      } as NodeJS.ProcessEnv)?.byteLength,
    ).toBe(32);
    expect(() =>
      boxStateKeyFromEnv({ FLUNCLE_BOXSTATE_KEY: "too-short" } as NodeJS.ProcessEnv),
    ).toThrow("32 bytes");
  });
});

describe("the seal", () => {
  test("round-trips, and the artifact is not the plaintext", async () => {
    const plaintext = new TextEncoder().encode("TOKEN=redacted\n");
    const sealed = await sealBoxState(plaintext, KEY);

    expect(Buffer.from(sealed.subarray(0, 8)).toString("utf8")).toBe(BOX_STATE_MAGIC);
    expect(Buffer.from(sealed).includes("TOKEN=redacted")).toBe(false);
    expect(Buffer.from(await openBoxState(sealed, KEY)).toString("utf8")).toBe("TOKEN=redacted\n");
  });

  test("a tampered byte, a wrong key, or a re-headed artifact all fail loudly", async () => {
    const sealed = await sealBoxState(new TextEncoder().encode("secret"), KEY);

    const tampered = new Uint8Array(sealed);
    tampered.set([(tampered.at(-1) ?? 0) ^ 0xff], tampered.length - 1);
    expect(await rejectionMessage(openBoxState(tampered, KEY))).not.toBe("");

    expect(await rejectionMessage(openBoxState(sealed, new Uint8Array(32).fill(1)))).not.toBe("");

    const reheaded = new Uint8Array(sealed);
    reheaded[0] = 0x00;
    expect(await rejectionMessage(openBoxState(reheaded, KEY))).toContain("bad magic");
  });
});

describe("buildBoxStateArchive", () => {
  test("seals an archive that restores byte-for-byte, modes included", async () => {
    const { home, root } = fakeDataRoot();
    const out = mkdtempSync(join(tmpdir(), "fluncle-boxstate-out-"));
    const outPath = join(out, "box-state.tar.gz.enc");

    const paths = selectBoxStatePaths(
      [
        join(root, "state.db"),
        join(root, "memories"),
        join(root, "cron", "output"),
        join(home, ".render-conductor"),
        join(home, ".fluncle-secrets.env"),
        join(home, "audit-workspace", "fluncle"), // must be dropped
      ],
      { root },
    );

    const { file, manifest } = await buildBoxStateArchive({
      generatedAt: new Date("2026-07-26T02:00:00.000Z"),
      key: KEY,
      outPath,
      paths,
      root,
      tempDir: out,
    });

    expect(manifest.encryption).toBe("AES-256-GCM");
    expect(manifest.entryCount).toBe(5);
    expect(manifest.entries.map((entry) => entry.path)).toContain("home/.fluncle-secrets.env");
    expect(manifest.entries.some((entry) => entry.path.includes("audit-workspace"))).toBe(false);
    expect(manifest.generatedAt).toBe("2026-07-26T02:00:00.000Z");
    expect(file.bytes).toBe(statSync(outPath).size);
    // The artifact on disk is operator-only too.
    expect(statSync(outPath).mode & 0o777).toBe(0o600);

    // The restore path: decrypt, verify the recorded hash, untar.
    const plaintext = await openBoxState(new Uint8Array(readFileSync(outPath)), KEY);

    expect(plaintext.byteLength).toBe(manifest.archiveBytes);
    expect(
      Buffer.from(
        await crypto.subtle.digest("SHA-256", plaintext as unknown as ArrayBuffer),
      ).toString("hex"),
    ).toBe(manifest.sha256);

    const restored = mkdtempSync(join(tmpdir(), "fluncle-boxstate-restore-"));
    const tarPath = join(out, "restored.tar.gz");

    writeFileSync(tarPath, plaintext);
    expect(spawnSync("tar", ["-xzf", tarPath, "-C", restored]).status).toBe(0);

    expect(readFileSync(join(restored, "state.db"), "utf8")).toBe("gateway-state");
    expect(readFileSync(join(restored, "memories", "crew.md"), "utf8")).toBe("the crew");
    expect(readFileSync(join(restored, "home", ".render-conductor", "box-id"), "utf8")).toBe(
      "provisioned-box",
    );
    expect(readFileSync(join(restored, "cron", "output", "fluncle-backup", "run.md"), "utf8")).toBe(
      "# Cron Job\n",
    );
    // The 0600 on a credential-bearing file survives the round trip.
    expect(statSync(join(restored, "home", ".fluncle-secrets.env")).mode & 0o777).toBe(0o600);
  });

  test("an over-cap selection fails BEFORE spending memory on it", async () => {
    const { root } = fakeDataRoot();
    const out = mkdtempSync(join(tmpdir(), "fluncle-boxstate-cap-"));

    expect(
      await rejectionMessage(
        buildBoxStateArchive({
          generatedAt: new Date(),
          key: KEY,
          maxBytes: 4,
          outPath: join(out, "box-state.tar.gz.enc"),
          paths: [join(root, "memories")],
          root,
          tempDir: out,
        }),
      ),
    ).toContain("over the 4-byte cap");
  });

  test("an empty selection is an error, not a silently empty backup", async () => {
    const out = mkdtempSync(join(tmpdir(), "fluncle-boxstate-empty-"));

    expect(
      await rejectionMessage(
        buildBoxStateArchive({
          generatedAt: new Date(),
          key: KEY,
          outPath: join(out, "box-state.tar.gz.enc"),
          paths: [],
          root: out,
          tempDir: out,
        }),
      ),
    ).toContain("nothing to archive");
  });
});
