import {
  type ArtistRule,
  type ArtistRuleInput,
  type ArtistRulesResponse,
  type LabelAdminItem,
  type LabelSeedState,
  type MergeLabelResult,
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

/** Parse the complete scoped-rule set before the replace request can mutate anything. */
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

/** List one label's artist exceptions. The public slug is resolved to the op's label id first. */
export async function listLabelArtistRulesCommand(
  slugOrId: string,
): Promise<{ label: LabelAdminItem; rules: ArtistRule[] }> {
  const label = await resolveLabel(slugOrId);
  const response = await adminApiGet<ArtistRulesResponse>(
    `/api/v1/admin/labels/${encodeURIComponent(label.id)}/artists`,
  );

  return { label, rules: response.rules };
}

/** Transactionally replace one label's complete artist-rule set. */
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

// ── The label merge: fold a slug-split twin into its canonical row (RFC musickit-second-authority
// U2b) ──────────────────────────────────────────────────────────────────────────────────────────
// Thin HTTP client over the operator-tier `merge_label` op. Re-points every FK off the losing label
// onto the canonical, reconciles identity/facts canonical-wins, writes the losing name as a
// confirmed alias, deletes the loser — server-side, in one transaction. See docs/label-entity.md.

// Merge the losing label into the canonical one. The op is keyed by SLUG (the operator's mental
// model + the redirect key), so no id pre-resolution round-trip is needed.
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

// ── The crawl-seed ruling: enable/disable a label as a crawl seed ─────────────
// Thin HTTP client over the operator-tier `update_label` op (PATCH /admin/labels/{id}).
// The ruling steers what Fluncle crawls NEXT — an `enabled` label's releases are stored,
// a `disabled`/`undecided` label's are walked for discovery but written as nothing (the
// storage gate). It touches NOTHING already stored. See docs/label-entity.md.

// The server op is keyed by the raw `lbl_…` id, but the operator thinks in slugs — so
// resolve through the seed-set read first. An exact id is also accepted, so the box's
// worklists can pass ids straight through.
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

// ── The voiced bio: the entity-bio engine (thin HTTP client) ──────────────────
// The label sibling of `admin artists describe`: author the label's bio through the
// agent-tier `describe_label` route. Fills an empty bio only; an operator bio is never
// clobbered. Shares the body builder + result types with the artist command.

// Author + store one label's bio (the voice-gated, fill-empty-only write). `--dry-run`
// runs the voice gate and reports the verdict without storing anything.
export async function describeLabelCommand(
  slug: string,
  options: { bio: string; dryRun?: boolean; finalAttempt?: boolean; promptVersion?: number },
): Promise<EntityBioResult> {
  return adminApiPost<EntityBioResult>(
    `/api/v1/admin/labels/${encodeURIComponent(slug)}/bio`,
    buildBioBody(options),
  );
}

// Trigger the Worker's bio-draft grounding for one label: the Firecrawl gather + finding
// titles + the assembled `describe_label` prompt, returned ready-to-author. The box's bio
// sweep calls this per queued entity, then runs `claude -p` on the returned prompt.
export async function draftLabelBioCommand(slug: string): Promise<EntityBioDraft> {
  return adminApiGet<EntityBioDraft>(`/api/v1/admin/labels/${encodeURIComponent(slug)}/bio-draft`);
}

// The BIO queue: labels with findings but no bio yet, oldest first — the worklist the
// `describe_label` cron drains (each row is a `admin labels describe <slug>`).
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
    `/api/v1/admin/backfill/label-images?${params.toString()}`,
  );
}

export type LabelLineageBackfillResult = {
  dryRun: boolean;
  failed: Array<{ error: string; slug: string }>;
  failedCount: number;
  // The slug cursor to resume from, or null when the worklist is drained (or a MusicBrainz throttle
  // stopped the pass). Each pass handles a bounded batch, so the CLI loops until null.
  nextCursor: string | null;
  // Labels with no MusicBrainz identity to walk — terminal, so they never re-resolve.
  none: string[];
  noneCount: number;
  ok: boolean;
  rateLimited: boolean;
  resolved: string[];
  resolvedCount: number;
  // Backward parent edges MusicBrainz named but no archive label carries by MBID — noted, never minted.
  unmatchedParents: number;
};

// One bounded pass of the label-lineage fill sweep (RFC label-lineage-remixer, U1) via the admin
// API. The Worker walks each pending label's MusicBrainz life-span + area + label-rels and writes
// its founding date/place + parent imprint (matched to an existing label — never minting one).
// `--dry-run` reports the eligible worklist without a vendor call or write. Pass the prior
// `nextCursor` to resume; the CLI loops until it comes back null.
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
