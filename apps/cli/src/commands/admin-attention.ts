import {
  type AttentionQueue,
  type AttentionResponse,
  type AttentionSource,
} from "@fluncle/contracts";
import { adminApiGet } from "../api";

export async function attentionQueueCommand(): Promise<AttentionQueue> {
  const response = await adminApiGet<AttentionResponse>("/api/v1/admin/attention");

  return response.attention;
}

const SOURCE_LABELS: Record<AttentionSource, string> = {
  "anchor-review": "version check",
  "artist-review": "artist links",
  "attach-cues": "cues",
  "bio-review": "bio gate",
  "capture-suspect": "capture check",
  distribute: "distribute",
  "drip-empty": "clip drip",
  "label-review": "label",
  newsletter: "newsletter",
  "note-rejected": "held note",
  "observation-rejected": "held observation",
  "post-tiktok": "tiktok",
  "post-youtube": "youtube",
  submission: "submission",
  "tiktok-draft": "tiktok draft",
};

export function attentionQueueLines(queue: AttentionQueue): string[] {
  const lines = [queue.brief];

  if (queue.rows.length > 0) {
    const width = queue.rows.reduce(
      (max, row) => Math.max(max, SOURCE_LABELS[row.source].length),
      0,
    );

    lines.push("");
    for (const row of queue.rows) {
      lines.push(`  ${SOURCE_LABELS[row.source].padEnd(width)}  ${row.title}`);
    }
  }

  if (queue.renderQueueDepth > 0) {
    const noun = queue.renderQueueDepth === 1 ? "finding" : "findings";
    lines.push("", `${queue.renderQueueDepth} ${noun} in the render queue.`);
  }

  return lines;
}
