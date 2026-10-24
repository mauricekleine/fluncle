import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertRailArmed } from "@fluncle/test-support/no-network";

assertRailArmed("apps/cli");

import { gatherLabelEvidenceBatch } from "./commands/admin-label-evidence-batch";
import { createEvidenceHttp, SOURCE_POLICIES } from "./evidence-http";

test("batch collection reports blocked external evidence as a failed terminal label", async () => {
  const dir = mkdtempSync(join(tmpdir(), "label-batch-no-network-"));
  try {
    const result = await gatherLabelEvidenceBatch(
      ["11111111-1111-1111-1111-111111111111"],
      { census: false, censusPages: 1, out: dir, refresh: false, sources: ["musicbrainz"] },
      {
        http: createEvidenceHttp({
          cacheDir: join(dir, "cache"),
          policies: {
            ...SOURCE_POLICIES,
            musicbrainz: { ...SOURCE_POLICIES.musicbrainz, attempts: 1, intervalMs: 0 },
          },
        }),
        resolveLabel: async () => {
          throw new Error("MBID requires no admin lookup");
        },
        scraper: null,
      },
    );
    expect(result.ok).toBe(false);
    const evidence = JSON.parse(readFileSync(join(dir, "0.json"), "utf8"));
    expect(evidence.sources.musicbrainz.status).toBe("error");
    expect(evidence.errors[0].message).toContain("Blocked outbound request");
    const events = readFileSync(join(dir, "manifest.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.at(-2)).toMatchObject({ sources: { musicbrainz: "error" }, state: "failed" });
    expect(events.at(-1)).toMatchObject({ ok: false, state: "completed" });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
