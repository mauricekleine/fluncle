import {
  type AddArtistRuleInput,
  type ArtistRule,
  type ArtistRuleAddResponse,
  type ArtistRulesResponse,
} from "@fluncle/contracts";
import { adminApiDelete, adminApiGet, adminApiPost } from "../api";

const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function artistRuleInput(
  artistMbid: string,
  verdict: string,
  artistName?: string,
): AddArtistRuleInput {
  const cleanMbid = artistMbid.trim();
  if (!MBID_PATTERN.test(cleanMbid)) {
    throw new Error("Artist MBID must be a MusicBrainz artist MBID");
  }

  if (verdict !== "allow" && verdict !== "block" && verdict !== "unlisted") {
    throw new Error("Pass --verdict allow|block|unlisted");
  }

  const cleanName = artistName?.trim();
  if (artistName !== undefined && !cleanName) {
    throw new Error("--name must be a non-empty artist name");
  }

  return {
    artistMbid: cleanMbid.toLowerCase(),
    ...(cleanName ? { artistName: cleanName } : {}),
    verdict,
  };
}

export async function listArtistRulesCommand(): Promise<ArtistRule[]> {
  const response = await adminApiGet<ArtistRulesResponse>("/api/v1/admin/artist-rules");
  return response.rules;
}

export async function addArtistRuleCommand(input: AddArtistRuleInput): Promise<ArtistRule> {
  const response = await adminApiPost<ArtistRuleAddResponse>("/api/v1/admin/artist-rules", input);
  return response.rule;
}

export async function removeArtistRuleCommand(id: string): Promise<{ ok: true }> {
  return adminApiDelete<{ ok: true }>(`/api/v1/admin/artist-rules/${encodeURIComponent(id)}`);
}

export type EntityBioWorkItem = { id: string; name: string; slug: string };

export type EntityBioDraft = {
  findingCount: number;
  found: boolean;
  hasFacts: boolean;
  name: string;
  prompt: string;
  promptVersion: number;
};

export type EntityBioResult = {
  bio: string;

  dryRun?: boolean;

  gateBypassed?: boolean;
  ok: boolean;

  skipped?: boolean;
  slug: string;

  voiceViolations?: string[];
};

type BioBody = { bio: string; dryRun?: boolean; finalAttempt?: boolean; promptVersion?: number };

export function buildBioBody(options: {
  bio: string;
  dryRun?: boolean;
  finalAttempt?: boolean;
  promptVersion?: number;
}): BioBody {
  const body: BioBody = { bio: options.bio };

  if (options.dryRun) {
    body.dryRun = true;
  }

  if (options.finalAttempt) {
    body.finalAttempt = true;
  }

  if (typeof options.promptVersion === "number") {
    body.promptVersion = options.promptVersion;
  }

  return body;
}

export async function describeArtistCommand(
  slug: string,
  options: { bio: string; dryRun?: boolean; finalAttempt?: boolean; promptVersion?: number },
): Promise<EntityBioResult> {
  return adminApiPost<EntityBioResult>(
    `/api/v1/admin/artists/${encodeURIComponent(slug)}/bio`,
    buildBioBody(options),
  );
}

export async function draftArtistBioCommand(slug: string): Promise<EntityBioDraft> {
  return adminApiGet<EntityBioDraft>(`/api/v1/admin/artists/${encodeURIComponent(slug)}/bio-draft`);
}

export async function artistsBioQueueCommand(limit: number): Promise<EntityBioWorkItem[]> {
  const response = await adminApiGet<{ artists: EntityBioWorkItem[]; ok: boolean }>(
    `/api/v1/admin/artists/bio-queue?limit=${limit}`,
  );

  return response.artists;
}

export type UnresolvedArtist = {
  id: string;
  name: string;
};

export type ArtistsResolveQueueResult = {
  artists: UnresolvedArtist[];
  nextCursor: string | null;
  ok: boolean;
};

export type ResolvedArtistSocial = {
  platform: string;
  source: string;
  url: string;
};

export type ArtistResolveResult = {
  artistId: string;

  mbid: string | null;
  ok: boolean;

  rateLimited: boolean;
  socials: ResolvedArtistSocial[];
  socialsCount: number;
  wikidataQid: string | null;
};

export async function listArtistsCommand(
  limit: number,
  cursor?: string,
): Promise<ArtistsResolveQueueResult> {
  const params = new URLSearchParams({ limit: String(limit) });

  if (cursor) {
    params.set("cursor", cursor);
  }

  return adminApiGet<ArtistsResolveQueueResult>(`/api/v1/admin/artists?${params.toString()}`);
}

export async function resolveArtistCommand(artistId: string): Promise<ArtistResolveResult> {
  return adminApiPost<ArtistResolveResult>(
    `/api/v1/admin/artists/${encodeURIComponent(artistId)}/resolve`,
  );
}

export type RankArtistsSummary = {
  centroidsComputed: number;
  centroidsRemoved: number;
  edgesWritten: number;
  logicVersion: string;
  remaining: number;
};

export async function rankArtistsCommand(options: {
  countRemaining?: boolean;
  limit?: string;
}): Promise<{ summary: RankArtistsSummary }> {
  const limit = options.limit ? Number.parseInt(options.limit, 10) : undefined;

  const response = await adminApiPost<{ ok: true; summary: RankArtistsSummary }>(
    "/api/v1/admin/artists/rank",
    {
      ...(limit ? { limit } : {}),
      ...(options.countRemaining ? { countRemaining: true } : {}),
    },
  );

  return { summary: response.summary };
}

export type ArtistsBackfillResult = {
  dryRun: boolean;
  failed: Array<{ error: string; logId: string }>;
  failedCount: number;

  nextCursor: string | null;
  ok: boolean;
  skipped: string[];
  skippedCount: number;
  upserted: string[];
  upsertedCount: number;
};

export type ArtistImagesBackfillResult = {
  budgetLimited: boolean;
  checkedCount: number;
  dryRun: boolean;
  failed: Array<{ artistId: string; error: string }>;
  failedCount: number;
  filled: string[];
  filledCount: number;

  nextCursor: string | null;
  ok: boolean;

  queueDepth: number;
  rateLimited: boolean;

  skipped: string[];
  skippedCount: number;
};

export async function backfillArtistImagesCommand(
  limit: number,
  dryRun: boolean,
  cursor?: string,
): Promise<ArtistImagesBackfillResult> {
  const params = new URLSearchParams({ dryRun: String(dryRun), limit: String(limit) });

  if (cursor) {
    params.set("cursor", cursor);
  }

  return adminApiPost<ArtistImagesBackfillResult>(
    `/api/v1/admin/backfill/artist-images?${params.toString()}`,
  );
}

export async function backfillArtistsCommand(
  limit: number,
  dryRun: boolean,
  cursor?: string,
): Promise<ArtistsBackfillResult> {
  const params = new URLSearchParams({ dryRun: String(dryRun), limit: String(limit) });

  if (cursor) {
    params.set("cursor", cursor);
  }

  return adminApiPost<ArtistsBackfillResult>(`/api/v1/admin/backfill/artists?${params.toString()}`);
}
