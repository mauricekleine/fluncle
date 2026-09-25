import {
  type ArtistRule,
  type ArtistRuleInput,
  type ArtistRulesResponse,
  type LabelAdminItem,
  type LabelSeedState,
  type LabelTakeOverResult,
  type MergeLabelResult,
  type MintLabelOutcome,
} from "@fluncle/contracts";
import { adminApiGet, adminApiPatch, adminApiPost, adminApiPut } from "../api";
import {
  buildBioBody,
  type EntityBioDraft,
  type EntityBioResult,
  type EntityBioWorkItem,
} from "./admin-artists";

const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireArtistMbid(value: unknown, at: string): string {
  if (typeof value !== "string" || !MBID_PATTERN.test(value.trim())) {
    throw new Error(`${at}.artistMbid must be a MusicBrainz artist MBID`);
  }

  return value.trim().toLowerCase();
}

function requireArtistName(value: unknown, at: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${at}.artistName must be a non-empty string`);
  }

  return value.trim();
}

function requireArtistVerdict(value: unknown, at: string): "allow" | "block" {
  if (value === "allow" || value === "block") {
    return value;
  }

  throw new Error(`${at}.verdict must be 'allow' or 'block'`);
}

export function parseLabelArtistRulesJson(source: string): ArtistRuleInput[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new Error("Rules file must contain valid JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Rules file must contain a JSON array");
  }

  if (parsed.length > 100) {
    throw new Error("Rules file may contain at most 100 artist rules");
  }

  return parsed.map((entry, index) => {
    const at = `Rules file entry ${index + 1}`;

    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${at} must be an object`);
    }

    const value = entry as Record<string, unknown>;
    return {
      artistMbid: requireArtistMbid(value.artistMbid, at),
      artistName: requireArtistName(value.artistName, at),
      verdict: requireArtistVerdict(value.verdict, at),
    };
  });
}

async function resolveLabel(slugOrId: string): Promise<LabelAdminItem> {
  const { labels } = await adminApiGet<{ labels: LabelAdminItem[]; ok: boolean }>(
    "/api/v1/admin/labels",
  );
  const match = labels.find((label) => label.slug === slugOrId || label.id === slugOrId);

  if (!match) {
    throw new Error(`No label with slug or id '${slugOrId}' — check \`fluncle labels\``);
  }

  return match;
}

export async function listLabelArtistRulesCommand(
  slugOrId: string,
): Promise<{ label: LabelAdminItem; rules: ArtistRule[] }> {
  const label = await resolveLabel(slugOrId);
  const response = await adminApiGet<ArtistRulesResponse>(
    `/api/v1/admin/labels/${encodeURIComponent(label.id)}/artists`,
  );

  return { label, rules: response.rules };
}

export async function replaceLabelArtistRulesCommand(
  slugOrId: string,
  rules: ArtistRuleInput[],
): Promise<{ label: LabelAdminItem; rules: ArtistRule[] }> {
  const label = await resolveLabel(slugOrId);
  const response = await adminApiPut<ArtistRulesResponse>(
    `/api/v1/admin/labels/${encodeURIComponent(label.id)}/artists`,
    { rules },
  );

  return { label, rules: response.rules };
}

export async function mergeLabelCommand(
  losingSlug: string,
  canonicalSlug: string,
): Promise<MergeLabelResult> {
  const response = await adminApiPost<{ ok: boolean; result: MergeLabelResult }>(
    `/api/v1/admin/labels/${encodeURIComponent(losingSlug)}/merge`,
    { canonicalSlug },
  );

  return response.result;
}

export async function updateLabelCommand(
  slugOrId: string,
  seedState?: LabelSeedState,
  rewalk = false,
): Promise<LabelAdminItem> {
  const match = await resolveLabel(slugOrId);

  const response = await adminApiPatch<{ label: LabelAdminItem; ok: boolean }>(
    `/api/v1/admin/labels/${encodeURIComponent(match.id)}`,
    {
      ...(rewalk ? { rewalk: true } : {}),
      ...(seedState === undefined ? {} : { seedState }),
    },
  );

  return response.label;
}

export async function mintLabelCommand(
  mbLabelId: string,
  seedState?: LabelSeedState,
  takeOverSlug?: string,
): Promise<{ label: LabelAdminItem; outcome: MintLabelOutcome; takenOver?: LabelTakeOverResult }> {
  const mbid = mbLabelId.trim().toLowerCase();

  if (!MBID_PATTERN.test(mbid)) {
    throw new Error(`'${mbLabelId}' is not a MusicBrainz label MBID`);
  }

  const response = await adminApiPost<{
    label: LabelAdminItem;
    ok: boolean;
    outcome: MintLabelOutcome;
    takenOver?: LabelTakeOverResult;
  }>("/api/v1/admin/labels", {
    mbLabelId: mbid,
    ...(seedState === undefined ? {} : { seedState }),
    ...(takeOverSlug === undefined ? {} : { takeOverSlug: takeOverSlug.trim().toLowerCase() }),
  });

  return { label: response.label, outcome: response.outcome, takenOver: response.takenOver };
}

export async function describeLabelCommand(
  slug: string,
  options: { bio: string; dryRun?: boolean; finalAttempt?: boolean; promptVersion?: number },
): Promise<EntityBioResult> {
  return adminApiPost<EntityBioResult>(
    `/api/v1/admin/labels/${encodeURIComponent(slug)}/bio`,
    buildBioBody(options),
  );
}

export async function draftLabelBioCommand(slug: string): Promise<EntityBioDraft> {
  return adminApiGet<EntityBioDraft>(`/api/v1/admin/labels/${encodeURIComponent(slug)}/bio-draft`);
}

export async function labelsBioQueueCommand(limit: number): Promise<EntityBioWorkItem[]> {
  const response = await adminApiGet<{ labels: EntityBioWorkItem[]; ok: boolean }>(
    `/api/v1/admin/labels/bio-queue?limit=${limit}`,
  );

  return response.labels;
}

export type LabelImagesBackfillResult = {
  dryRun: boolean;
  failed: Array<{ error: string; slug: string }>;
  failedCount: number;

  nextCursor: string | null;

  none: string[];
  noneCount: number;
  ok: boolean;
  rateLimited: boolean;
  resolved: string[];
  resolvedCount: number;
};

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
    `/api/v1/admin/backfill/label-images?${params.toString()}`,
  );
}

export type LabelLineageBackfillResult = {
  dryRun: boolean;
  failed: Array<{ error: string; slug: string }>;
  failedCount: number;

  nextCursor: string | null;

  none: string[];
  noneCount: number;
  ok: boolean;
  rateLimited: boolean;
  resolved: string[];
  resolvedCount: number;

  unmatchedParents: number;
};

export async function backfillLabelLineageCommand(
  limit: number,
  dryRun: boolean,
  cursor?: string,
): Promise<LabelLineageBackfillResult> {
  const params = new URLSearchParams({ dryRun: String(dryRun), limit: String(limit) });

  if (cursor) {
    params.set("cursor", cursor);
  }

  return adminApiPost<LabelLineageBackfillResult>(
    `/api/v1/admin/backfill/label-lineage?${params.toString()}`,
  );
}
