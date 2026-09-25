import { readOptionalEnv } from "./env";
import {
  FIRECRAWL_SEARCH_URL,
  isLyricDomain,
  maskEntityName,
  scanObservationScript,
  type FirecrawlResult,
  type VoiceGateViolation,
} from "./observation";
import { renderRegisteredPrompt } from "./prompts";
import { ApiError } from "./spotify";

export type EntityKind = "artist" | "label" | "album";

const BIO_MIN_CHARS = 40;
const BIO_MAX_CHARS = 500;

export { maskEntityName } from "./observation";

export function gateBioText(text: unknown, entityName: string): string {
  const trimmed = requireStorableBio(text);
  const violations = scanBioProse(trimmed, entityName);

  if (violations.length > 0) {
    throw new ApiError("voice_gate", voiceGateMessage(violations), 422);
  }

  return trimmed;
}

function scanBioProse(bio: string, entityName: string): VoiceGateViolation[] {
  return scanObservationScript(maskEntityName(bio, entityName), { allowGeography: true });
}

export function acceptFinalDraftBio(
  text: unknown,
  entityName: string,
): { bio: string; violations: VoiceGateViolation[] } {
  const bio = requireStorableBio(text);

  return { bio, violations: scanBioProse(bio, entityName) };
}

export function gateOrAcceptBio(input: {
  bio: unknown;
  finalAttempt: boolean;
  kind: EntityKind;

  name: string;
  slug: string;
}): { bio: string; gateBypassed?: true; voiceViolations?: string[] } {
  if (!input.finalAttempt) {
    return { bio: gateBioText(input.bio, input.name) };
  }

  const { bio, violations } = acceptFinalDraftBio(input.bio, input.name);

  if (violations.length === 0) {
    return { bio };
  }

  const voiceViolations = violations.map((violation) => violation.reason);

  console.warn(
    `describe_${input.kind}: FINAL-ATTEMPT ACCEPTANCE — stored a bio the voice gate refused for ${input.kind} "${input.slug}". ${voiceGateMessage(violations)}`,
  );

  return { bio, gateBypassed: true, voiceViolations };
}

function voiceGateMessage(violations: readonly VoiceGateViolation[]): string {
  return `The bio fails the voice gate: ${violations.map((violation) => violation.reason).join("; ")}`;
}

function requireStorableBio(text: unknown): string {
  if (typeof text !== "string" || !text.trim()) {
    throw new ApiError("no_bio", "A `bio` (the entity's voiced paragraph) is required", 400);
  }

  const trimmed = text.trim();

  if (trimmed.length < BIO_MIN_CHARS) {
    throw new ApiError(
      "bio_too_short",
      `The bio is too short (${trimmed.length} < ${BIO_MIN_CHARS} chars)`,
      422,
    );
  }

  if (trimmed.length > BIO_MAX_CHARS) {
    throw new ApiError(
      "bio_too_long",
      `The bio is too long (${trimmed.length} > ${BIO_MAX_CHARS} chars)`,
      422,
    );
  }

  return trimmed;
}

export type EntityFacts = {
  facts: string;

  sources: string[];
};

export function buildEntityFactsQuery(kind: EntityKind, name: string): string {
  const descriptor =
    kind === "artist"
      ? "drum and bass producer"
      : kind === "label"
        ? "drum and bass record label"
        : "drum and bass album";

  return `${name} ${descriptor}`;
}

export async function fetchEntityFacts(input: {
  kind: EntityKind;
  name: string;
}): Promise<EntityFacts | null> {
  const apiKey = await readOptionalEnv("FIRECRAWL_API_KEY");

  if (!apiKey) {
    return null;
  }

  const query = buildEntityFactsQuery(input.kind, input.name);

  let payload: { data?: { web?: FirecrawlResult[] } } | undefined;

  try {
    const response = await fetch(FIRECRAWL_SEARCH_URL, {
      body: JSON.stringify({ limit: 5, query }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    if (!response.ok) {
      return null;
    }

    payload = (await response.json()) as { data?: { web?: FirecrawlResult[] } };
  } catch {
    return null;
  }

  const web = payload?.data?.web ?? [];
  const sources: string[] = [];
  const snippets: string[] = [];

  for (const result of web) {
    if (isLyricDomain(result.url)) {
      continue;
    }

    const title = result.title?.trim();
    const description = result.description?.trim();

    if (title || description) {
      snippets.push([title, description].filter(Boolean).join(" — "));
    }

    if (result.url) {
      sources.push(result.url);
    }
  }

  if (snippets.length === 0) {
    return null;
  }

  return { facts: snippets.join("\n").slice(0, 2000), sources };
}

function bioSlug(kind: EntityKind): "describe_artist" | "describe_label" | "describe_album" {
  return kind === "artist"
    ? "describe_artist"
    : kind === "label"
      ? "describe_label"
      : "describe_album";
}

export async function buildEntityBioPrompt(input: {
  facts: string | null;
  findingTitles: string[];
  kind: EntityKind;
  name: string;
}): Promise<{ body: string; version: number }> {
  const facts = input.facts?.trim() ?? "";
  const findings = input.findingTitles.map((title) => `  - ${title}`).join("\n");

  return renderRegisteredPrompt(bioSlug(input.kind), {
    facts: facts || undefined,
    findingCount: String(input.findingTitles.length),
    findings,
    name: input.name,

    noFacts: facts ? undefined : "true",
  });
}
