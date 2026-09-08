import { describe, expect, it } from "vitest";

import {
  ARTIFACT_CHANGE_MAX_READ_LIMIT,
  ARTIFACT_SNAPSHOT_MAX_LIMIT,
} from "../../src/lib/server/artifact-changes";
import {
  formatArtifactTransactionMarkdown,
  runArtifactTransactionProfile,
} from "./artifact-transactions";
import { createCiFixtureCounts } from "./manifest";

describe("artifact transaction measurement", () => {
  it("drives both real write transactions over a compact multi-page source", async () => {
    // Enough embedded tracks for three snapshot pages, so the report carries a first page with no
    // stored cursor and later pages that decode one.
    const counts = createCiFixtureCounts("1x", 1_500);
    const report = await runArtifactTransactionProfile("1x", { acknowledgements: 2, counts });
    const expectedPages = Math.ceil(counts.trackEmbeddings / ARTIFACT_SNAPSHOT_MAX_LIMIT);

    expect(report.schemaVersion).toBe(1);
    expect(report.exactProfileCardinality).toBe(false);
    expect(report.census).toEqual({
      artifactChangesBelowFence: expect.any(Number),
      trackEmbeddings: counts.trackEmbeddings,
      tracks: counts.tracks,
    });
    expect(expectedPages).toBeGreaterThanOrEqual(3);

    const checkpoints = report.rebuildCheckpoint.samples;
    expect(checkpoints).toHaveLength(expectedPages);
    expect(checkpoints.reduce((total, sample) => total + sample.itemCount, 0)).toBe(
      counts.trackEmbeddings,
    );
    for (const sample of checkpoints) {
      expect(sample.statements).toBe(4);
      expect(sample.vectorBase64Calls).toBe(0);
      // The stored page-tail cursor is the one encode inside the transaction.
      expect(sample.base64Calls).toBe(1);
      // One SHA-256 per source row plus the page digest and the running source digest.
      expect(sample.digestCalls).toBe(sample.itemCount + 2);
      // The first page has no stored cursor; every later page decodes its stored cursor once to
      // build the keyset read. No payload JSON is ever decoded.
      expect(sample.jsonParseCalls).toBe(sample.sequence === 1 ? 0 : 1);
    }
    expect(report.rebuildCheckpoint.summary).toMatchObject({
      base64Calls: [1],
      digestCallsPerItemPlus: [2],
      jsonParseCalls: [0, 1],
      sampleCount: expectedPages,
      statements: [4],
      vectorBase64Calls: [0],
    });

    const acknowledgements = report.acknowledgement.samples;
    expect(acknowledgements).toHaveLength(2);
    for (const sample of acknowledgements) {
      expect(sample.itemCount).toBe(ARTIFACT_CHANGE_MAX_READ_LIMIT);
      expect(sample.statements).toBe(4);
      expect(sample.base64Calls).toBe(0);
      expect(sample.jsonParseCalls).toBe(0);
      // One SHA-256 per stored row plus the ordered batch digest.
      expect(sample.digestCalls).toBe(ARTIFACT_CHANGE_MAX_READ_LIMIT + 1);
    }
    expect(report.acknowledgement.summary).toMatchObject({
      base64Calls: [0],
      digestCallsPerItemPlus: [1],
      jsonParseCalls: [0],
      sampleCount: 2,
      statements: [4],
      vectorBase64Calls: [0],
    });

    const markdown = formatArtifactTransactionMarkdown(report);
    expect(markdown.split("\n")).toHaveLength(4);
    expect(markdown).toContain("| acknowledgement (500-event pages) | 2 | 4 | 0 (0 vector) | 0 |");
    expect(markdown).toContain(
      `| rebuild checkpoint (200-item pages) | ${expectedPages} | 4 | 1 (0 vector) | 0/1 |`,
    );
  }, 60_000);
});
