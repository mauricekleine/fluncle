import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LOCAL_DB_CONCURRENCY } from "../../src/lib/database-concurrency";
import { auditFixtureCardinality, writeFixture } from "./fixture";
import {
  MATERIALIZED_FIXTURE_DATABASE_FILE,
  MATERIALIZED_FIXTURE_MANIFEST_FILE,
  expectedFixtureIdentity,
  materializeFixture,
  parseMaterializeArguments,
  verifyFixtureIdentity,
} from "./materialize";
import { type FixtureCounts } from "./manifest";

const SMALL_COUNTS: FixtureCounts = {
  albums: 9,
  artists: 11,
  crawlFrontier: 41,
  enabledLabelTracks: 37,
  findings: 3,
  fullAnalysisBacklog: 0,
  labels: 7,
  musicbrainzIsrcBacklog: 17,
  pendingFrontier: 23,
  trackArtists: 53,
  trackEmbeddings: 19,
  tracks: 41,
  youtubeProvenanceBacklog: 13,
};

const cleanupRoots: string[] = [];

async function newOutput(): Promise<{ outputDir: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "fluncle-fixture-materialize-"));
  cleanupRoots.push(root);
  return { outputDir: join(root, "output"), root };
}

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("database performance fixture materializer", () => {
  it("writes a reopenable proven file, identity, hash manifest, and no WAL residue", async () => {
    const { outputDir } = await newOutput();
    const manifest = await materializeFixture({ counts: SMALL_COUNTS, outputDir, profile: "1x" });
    const databasePath = join(outputDir, MATERIALIZED_FIXTURE_DATABASE_FILE);
    const bytes = await readFile(databasePath);

    expect(manifest.identity).toEqual(expectedFixtureIdentity("1x", SMALL_COUNTS));
    expect(manifest.database.bytes).toBe(bytes.byteLength);
    expect(manifest.database.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(manifest.quickCheck).toBe("ok");
    expect(
      JSON.parse(await readFile(join(outputDir, MATERIALIZED_FIXTURE_MANIFEST_FILE), "utf8")),
    ).toEqual(manifest);
    await expect(stat(`${databasePath}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(`${databasePath}-shm`)).rejects.toMatchObject({ code: "ENOENT" });

    const reopened = createClient({
      concurrency: LOCAL_DB_CONCURRENCY,
      url: `file:${databasePath}`,
    });
    try {
      expect(await verifyFixtureIdentity(reopened, "1x", SMALL_COUNTS)).toEqual(manifest.identity);
      expect((await auditFixtureCardinality(reopened, SMALL_COUNTS)).passed).toBe(true);
      const quickCheck = await reopened.execute("pragma quick_check");
      expect(Object.values(quickCheck.rows[0] ?? {})[0]).toBe("ok");
    } finally {
      reopened.close();
    }
  });

  it("refuses overwrite without changing the existing output", async () => {
    const { outputDir } = await newOutput();
    await materializeFixture({ counts: SMALL_COUNTS, outputDir, profile: "1x" });
    const sentinel = join(outputDir, "sentinel.txt");
    await writeFile(sentinel, "keep");

    await expect(
      materializeFixture({ counts: SMALL_COUNTS, outputDir, profile: "1x" }),
    ).rejects.toThrow("refusing to overwrite");
    expect(await readFile(sentinel, "utf8")).toBe("keep");
  });

  it("preserves a safe TimeoutError for fixture identity reads", async () => {
    const client = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });
    const timeout = new Error("secret SQL, credentials, and topology");
    timeout.name = "TimeoutError";
    vi.spyOn(client, "execute").mockRejectedValue(timeout);

    try {
      await expect(verifyFixtureIdentity(client, "1x", SMALL_COUNTS)).rejects.toMatchObject({
        message: "preseeded fixture identity request timed out",
        name: "TimeoutError",
      });
    } finally {
      client.close();
    }
  });

  it("materializes byte-identical artifacts for the same fixture", async () => {
    const first = await newOutput();
    const second = await newOutput();

    const firstManifest = await materializeFixture({
      counts: SMALL_COUNTS,
      outputDir: first.outputDir,
      profile: "1x",
    });
    const secondManifest = await materializeFixture({
      counts: SMALL_COUNTS,
      outputDir: second.outputDir,
      profile: "1x",
    });

    expect(secondManifest).toEqual(firstManifest);
    expect(await readFile(join(second.outputDir, MATERIALIZED_FIXTURE_DATABASE_FILE))).toEqual(
      await readFile(join(first.outputDir, MATERIALIZED_FIXTURE_DATABASE_FILE)),
    );
  });

  it("cleans its newly created output when materialization fails", async () => {
    const { outputDir } = await newOutput();

    await expect(
      materializeFixture(
        { counts: SMALL_COUNTS, outputDir, profile: "1x" },
        {
          write: async (sink, profile, options) => {
            await writeFixture(sink, profile, options);
            throw new Error("injected materializer failure");
          },
        },
      ),
    ).rejects.toThrow("injected materializer failure");
    await expect(stat(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires a new absolute outside-repository destination and exact CLI flags", async () => {
    expect(
      parseMaterializeArguments(["--profile", "2x", "--output-dir", "/tmp/new-fixture"]),
    ).toEqual({ outputDir: "/tmp/new-fixture", profile: "2x" });
    expect(() => parseMaterializeArguments([])).toThrow("requires --profile and --output-dir");
    await expect(
      materializeFixture({ counts: SMALL_COUNTS, outputDir: "relative-output", profile: "1x" }),
    ).rejects.toThrow("must be absolute");
    await expect(
      materializeFixture({
        counts: SMALL_COUNTS,
        outputDir: join(process.cwd(), "forbidden-output"),
        profile: "1x",
        repoRoot: process.cwd(),
      }),
    ).rejects.toThrow("outside the repository");

    const { root: symlinkRoot } = await newOutput();
    const repoAlias = join(symlinkRoot, "repo-alias");
    await symlink(process.cwd(), repoAlias);
    await expect(
      materializeFixture({
        counts: SMALL_COUNTS,
        outputDir: join(repoAlias, "forbidden-output"),
        profile: "1x",
        repoRoot: process.cwd(),
      }),
    ).rejects.toThrow("outside the repository");
  });
});
