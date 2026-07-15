import { adminApiGet, adminApiPost } from "../api";
import {
  buildBioBody,
  type EntityBioDraft,
  type EntityBioResult,
  type EntityBioWorkItem,
} from "./admin-artists";

// ── The voiced bio: the entity-bio engine (thin HTTP client) ──────────────────
// The label sibling of `admin artists describe`: author the label's bio through the
// agent-tier `describe_label` route. Fills an empty bio only; an operator bio is never
// clobbered. Shares the body builder + result types with the artist command.

// Author + store one label's bio (the voice-gated, fill-empty-only write). `--dry-run`
// runs the voice gate and reports the verdict without storing anything.
export async function describeLabelCommand(
  slug: string,
  options: { bio: string; dryRun?: boolean; promptVersion?: number },
): Promise<EntityBioResult> {
  return adminApiPost<EntityBioResult>(
    `/api/admin/labels/${encodeURIComponent(slug)}/bio`,
    buildBioBody(options),
  );
}

// Trigger the Worker's bio-draft grounding for one label: the Firecrawl gather + finding
// titles + the assembled `describe_label` prompt, returned ready-to-author. The box's bio
// sweep calls this per queued entity, then runs `claude -p` on the returned prompt.
export async function draftLabelBioCommand(slug: string): Promise<EntityBioDraft> {
  return adminApiGet<EntityBioDraft>(`/api/admin/labels/${encodeURIComponent(slug)}/bio-draft`);
}

// The BIO queue: labels with findings but no bio yet, oldest first — the worklist the
// `describe_label` cron drains (each row is a `admin labels describe <slug>`).
export async function labelsBioQueueCommand(limit: number): Promise<EntityBioWorkItem[]> {
  const response = await adminApiGet<{ labels: EntityBioWorkItem[]; ok: boolean }>(
    `/api/admin/labels/bio-queue?limit=${limit}`,
  );

  return response.labels;
}

export type LabelImagesBackfillResult = {
  dryRun: boolean;
  failed: Array<{ error: string; slug: string }>;
  failedCount: number;
  // The slug cursor to resume from on the next pass, or null when the worklist is drained (or a
  // vendor throttle stopped the pass). Each pass handles a bounded batch, so the CLI loops until
  // null.
  nextCursor: string | null;
  // Labels with no own image anywhere (Discogs + Wikidata both empty) — floored to the cover.
  none: string[];
  noneCount: number;
  ok: boolean;
  rateLimited: boolean;
  resolved: string[];
  resolvedCount: number;
};

// One bounded pass of the label-image resolve sweep via the admin API — the Worker walks each
// label's MusicBrainz identity, reads its curated Discogs/Wikidata url-rels, and downloads its
// logo once into our own R2. Idempotent + self-draining (a resolved/none label leaves the
// worklist). `--dry-run` reports the eligible worklist without any vendor call or write. Pass the
// prior pass's `nextCursor` to resume; the CLI loops until it comes back null.
export async function backfillLabelImagesCommand(
  limit: number,
  dryRun: boolean,
  cursor?: string,
): Promise<LabelImagesBackfillResult> {
  const params = new URLSearchParams({ dryRun: String(dryRun), limit: String(limit) });

  if (cursor) {
    params.set("cursor", cursor);
  }

  return adminApiPost<LabelImagesBackfillResult>(
    `/api/admin/backfill/label-images?${params.toString()}`,
  );
}
