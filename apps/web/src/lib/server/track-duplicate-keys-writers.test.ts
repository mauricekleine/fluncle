import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER = fileURLToPath(new URL("./", import.meta.url));

function serverSources(dir = SERVER, prefix = ""): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      out.push(...serverSources(join(dir, entry.name), rel));
    } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
      out.push(rel);
    }
  }

  return out;
}

function source(file: string): string {
  return readFileSync(join(SERVER, file), "utf8");
}

describe("track_duplicate_keys writer coverage", () => {
  it("materializes every production tracks insert in the same write batch", () => {
    const inserts: string[] = [];

    for (const file of serverSources()) {
      if (file === "integration-db.ts" || file === "track-duplicate-keys.ts") {
        continue;
      }

      const contents = source(file);

      for (const _match of contents.matchAll(/insert\s+into\s+tracks\b/g)) {
        inserts.push(file);
      }
    }

    expect(inserts.sort()).toEqual(["crawl.ts", "label-releases.ts", "publish.ts"]);

    expect(
      inserts
        .filter((file) => {
          const contents = source(file);

          return (
            !contents.includes("insertTrackDuplicateKeyStatement") ||
            (!contents.includes("db.batch(") && !contents.includes("batchDueWorkSourceMutation("))
          );
        })
        .map((file) => file),
    ).toEqual([]);
  });

  it("pairs every ISRC repair with an atomic duplicate-key update", () => {
    const isrcWriterFiles = serverSources()
      .filter((file) => file !== "isrc.ts")
      .filter((file) => {
        const contents = source(file);

        return (
          /(?<![\w])isrc\s*=\s*(\?|coalesce)/.test(contents) ||
          contents.includes("${FILL_ISRC_SQL}")
        );
      })
      .sort();

    expect(isrcWriterFiles).toEqual(["anchor.ts", "recording-mbids.ts", "track-update.ts"]);

    expect(
      isrcWriterFiles.filter((file) => {
        const contents = source(file);

        return !contents.includes("TrackDuplicate") || !contents.includes("db.batch(");
      }),
    ).toEqual([]);
  });

  it("requires any future title or artist mutation to carry an atomic full re-key", () => {
    const unpaired: string[] = [];

    for (const file of serverSources()) {
      const contents = source(file);

      for (const match of contents.matchAll(/update\s+tracks\s+set[\s\S]{0,2_000}?`/g)) {
        if (
          /(?<![\w])(title|artists_json)\s*=\s*(\?|coalesce)/.test(match[0]) &&
          (!contents.includes("upsertTrackDuplicateKeyStatement") ||
            !contents.includes("db.batch("))
        ) {
          unpaired.push(file);
        }
      }
    }

    expect(unpaired).toEqual([]);
  });

  it("reads every canonical-priority field live from tracks instead of mirroring mutable state", () => {
    const catalogue = source("catalogue.ts");
    const start = catalogue.indexOf("async function readCatalogueIdentity");
    const end = catalogue.indexOf("type CatalogueCandidateIdentity", start);
    const lookup = catalogue.slice(start, end);

    expect(lookup).toContain("join tracks on tracks.track_id = duplicate_keys.track_id");
    expect(lookup).toContain("order by tracks.has_embedding desc");
    expect(lookup).not.toContain("tracks.embedding_blob");
    expect(lookup).toContain("tracks.source_audio_key is not null");
    expect(lookup).toContain("tracks.capture_status");
    expect(lookup).toContain("tracks.dismissed_at is null");
  });
});
