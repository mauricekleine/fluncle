import { type AttentionQueue } from "@fluncle/contracts";
import { describe, expect, test } from "bun:test";
import { attentionQueueLines } from "./admin-attention";

// `attentionQueueLines` is the deadpan CLI board render — pure, no network. The
// `admin queue` read itself is a thin `adminApiGet` call proven by the oRPC
// contract/coverage tests; here we pin the human output shape.

const CLEAR: AttentionQueue = {
  brief: "All clear. Quiet sector.",
  counts: [],
  renderQueueDepth: 0,
  rows: [],
  total: 0,
};

describe("attentionQueueLines", () => {
  test("a clear board is just the dispatch line", () => {
    expect(attentionQueueLines(CLEAR)).toEqual(["All clear. Quiet sector."]);
  });

  test("leads with the dispatch, then one tagged row per waiting item", () => {
    const queue: AttentionQueue = {
      brief: "Two TikTok drafts to finish, a mixtape waiting on Mixcloud.",
      counts: [
        { count: 2, source: "tiktok-draft" },
        { count: 1, source: "distribute" },
      ],
      renderQueueDepth: 0,
      rows: [
        { path: "/admin", source: "tiktok-draft", title: "IYRE — Glowing Embers" },
        { path: "/admin", source: "tiktok-draft", title: "Nu:Tone — Verano" },
        { path: "/admin/studio/r1", source: "distribute", title: "Mixtape 12" },
      ],
      total: 3,
    };

    const lines = attentionQueueLines(queue);

    expect(lines[0]).toBe("Two TikTok drafts to finish, a mixtape waiting on Mixcloud.");
    expect(lines[1]).toBe("");
    // The source tags are padded to a shared width (parseable columns).
    expect(lines[2]).toBe("  tiktok draft  IYRE — Glowing Embers");
    expect(lines[4]).toBe("  distribute    Mixtape 12");
  });

  test("prints the render-queue depth last when the box has work", () => {
    const queue: AttentionQueue = { ...CLEAR, renderQueueDepth: 3 };
    const lines = attentionQueueLines(queue);

    expect(lines.at(-1)).toBe("3 findings in the render queue.");
  });
});
