import { adminApiGet, adminApiPost } from "../api";
import {
  buildBioBody,
  type EntityBioDraft,
  type EntityBioResult,
  type EntityBioWorkItem,
} from "./admin-artists";

// ── The voiced bio: the entity-bio engine (thin HTTP client) ──────────────────
// The album sibling of `admin artists describe` / `admin labels describe`: author the album's
// bio through the agent-tier `describe_album` route. Fills an empty bio only; an operator bio
// is never clobbered. Shares the body builder + result types with the artist command.

// Author + store one album's bio (the voice-gated, fill-empty-only write). `--dry-run`
// runs the voice gate and reports the verdict without storing anything.
export async function describeAlbumCommand(
  slug: string,
  options: { bio: string; dryRun?: boolean; promptVersion?: number },
): Promise<EntityBioResult> {
  return adminApiPost<EntityBioResult>(
    `/api/admin/albums/${encodeURIComponent(slug)}/bio`,
    buildBioBody(options),
  );
}

// Trigger the Worker's bio-draft grounding for one album: the Firecrawl gather + finding
// titles + the assembled `describe_album` prompt, returned ready-to-author. The box's bio
// sweep calls this per queued entity, then runs `claude -p` on the returned prompt.
export async function draftAlbumBioCommand(slug: string): Promise<EntityBioDraft> {
  return adminApiGet<EntityBioDraft>(`/api/admin/albums/${encodeURIComponent(slug)}/bio-draft`);
}

// The BIO queue: albums with findings but no bio yet, oldest first — the worklist the
// `describe_album` cron drains (each row is a `admin albums describe <slug>`).
export async function albumsBioQueueCommand(limit: number): Promise<EntityBioWorkItem[]> {
  const response = await adminApiGet<{ albums: EntityBioWorkItem[]; ok: boolean }>(
    `/api/admin/albums/bio-queue?limit=${limit}`,
  );

  return response.albums;
}
