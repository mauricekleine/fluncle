// `admin queue` — the operator's attention queue, off the Worker. A thin HTTP
// client over the admin-tier `get_attention` read: the same snapshot the `/admin`
// dashboard renders, folded into a portable digest (the day's dispatch, the
// per-source waiting rows, the render-queue pulse). The Raycast menu-bar command
// reads the very same `--json` output.

import {
  type AttentionQueue,
  type AttentionResponse,
  type AttentionSource,
} from "@fluncle/contracts";
import { adminApiGet } from "../api";

/** Read the attention-queue digest — the non-printing getter Raycast + the runner share. */
export async function attentionQueueCommand(): Promise<AttentionQueue> {
  const response = await adminApiGet<AttentionResponse>("/api/admin/attention");

  return response.attention;
}

/** The terse, deadpan source labels the CLI board tags each row with (CLI register). */
const SOURCE_LABELS: Record<AttentionSource, string> = {
  "artist-review": "artist links",
  "attach-cues": "cues",
  "capture-suspect": "capture check",
  distribute: "distribute",
  "drip-empty": "clip drip",
  "label-review": "label",
  newsletter: "newsletter",
  "note-rejected": "held note",
  "post-tiktok": "tiktok",
  "post-youtube": "youtube",
  submission: "submission",
  "tiktok-draft": "tiktok draft",
};

/**
 * Render the digest as a deadpan board (the CLI register): the day's dispatch on top,
 * then one aligned row per waiting item — a source tag and the object line — and the
 * render-queue depth last. Clean and parseable; `--json` stays the tooling contract.
 */
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
