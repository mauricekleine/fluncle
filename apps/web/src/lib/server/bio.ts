// The entity-bio engine (Worker-side): the artist/label BIO is the entity sibling of a
// finding's editorial `note`. Where the auto-note authors one line about one FINDING, this
// authors a short paragraph about an ARTIST or a LABEL — grounded in Firecrawl facts + the
// tracks Fluncle has actually LOGGED, never a fabricated discography, roster, or scene CV.
//
// This module is the BACKEND ENGINE (the surfacing + the box cron land in later PRs):
//   - `gateBioText` — the VOICE gate, adapted from `gateNoteText`. It reuses the SAME shared
//     scan (`scanObservationScript`) but in the FACTUAL DOSSIER register: it keeps the
//     banned-identity-word, no-exclamation Dry Rule, and no-"we"-as-company bans, and ALLOWS
//     earthly geography (`{ allowGeography: true }`) — a Wikipedia-style bio names a real
//     country or city plainly ("a producer from Belgium"), which the observation's
//     cosmos-replaces-the-map ban would wrongly reject. It carries the bio's own longer length
//     ceiling (a 2–4 sentence paragraph, not a one-line note). A bio lands on a public entity
//     page, so a violation hard-fails the store — the same defence-in-depth the note gate gives.
//   - `fetchEntityFacts` — the Firecrawl fact-gather, generalized from `fetchTrackContext`. It
//     fires the SAME Firecrawl v2 search idiom (the shared `FIRECRAWL_SEARCH_URL` + the
//     `FIRECRAWL_API_KEY` env read), drops the same lyric/junk domains, and returns the raw
//     snippets as the bio's grounding fuel. Best-effort: null on no key / no results (the cron
//     treats that as "no facts, skip").
//   - `buildEntityBioPrompt` — the reusable prompt-assembly the future cron calls: it resolves
//     the right registry slug (`describe_artist` / `describe_label`), interpolates the entity's
//     name, its logged findings, and the gathered facts, and returns the rendered body + its
//     provenance version. The GROUNDING RAIL lives in the baked prompt (see prompts.ts).
//
// The AUTHORING itself (the `claude -p` call) is NOT here — it runs in the box cron, exactly
// like the auto-note sweep. The Worker's job is the gate, the facts, and the fill-empty-only
// store (`fillEmptyArtistBio` / `fillEmptyLabelBio` in artists.ts / labels.ts).

import { readOptionalEnv } from "./env";
import { FIRECRAWL_SEARCH_URL, isLyricDomain, scanObservationScript } from "./observation";
import { renderRegisteredPrompt } from "./prompts";
import { ApiError } from "./spotify";

/** Which entity a bio describes — the artist page, or the record-label page. */
export type EntityKind = "artist" | "label";

// A bio is a short paragraph (2–4 sentences), not a one-line note. Floor it well above
// the note's 24 so a bare stub cannot clear, and cap it at 500 — long enough for four
// dry sentences, short enough that it can never grow into a Wikipedia dump. The ceiling
// is deliberately looser than the note's 280 public budget (a note is ONE line; a bio is
// a paragraph), but the VOICE bans are identical.
const BIO_MIN_CHARS = 40;
const BIO_MAX_CHARS = 500;

/**
 * Validate + voice-gate an agent-authored entity bio, throwing a clean ApiError on any
 * failure (the handler's catch turns it into a 4xx). Returns the trimmed bio on success.
 * Reuses the note/observation shared voice scan (one source of truth for the banned
 * identity words / exclamation / "we"-as-company bans) in the FACTUAL DOSSIER register:
 * it passes `{ allowGeography: true }`, so a Wikipedia-style bio may name a real country
 * or city plainly — the one ban this gate deliberately drops. It carries the bio's own
 * longer length bounds. The bio is a public entity surface, so a violation hard-fails the
 * store before it is ever shown.
 */
export function gateBioText(text: unknown): string {
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

  const violations = scanObservationScript(trimmed, { allowGeography: true });

  if (violations.length > 0) {
    throw new ApiError(
      "voice_gate",
      `The bio fails the voice gate: ${violations.map((violation) => violation.reason).join("; ")}`,
      422,
    );
  }

  return trimmed;
}

// ── The Firecrawl fact-gather (generalized from fetchTrackContext) ────────────────────

/** The gathered facts for one entity: the raw snippets + their provenance source URLs. */
export type EntityFacts = {
  /** The cleaned raw Firecrawl snippets, newline-joined — the bio's grounding fuel. */
  facts: string;
  /** The source URLs (provenance for the operator; never quoted into the bio). */
  sources: string[];
};

/**
 * Build the Firecrawl search query for one entity from its kind + name. An artist is a
 * producer; a label is an imprint. The genre anchor ("drum and bass") narrows the result
 * set to Fluncle's lane, exactly as the track query does — the widest query that still
 * lands on the right entity. The name is a trusted identity string, not free web content.
 */
export function buildEntityFactsQuery(kind: EntityKind, name: string): string {
  const descriptor = kind === "artist" ? "drum and bass producer" : "drum and bass record label";

  return `${name} ${descriptor}`;
}

/**
 * Firecrawl-search one entity's factual context (background, scene, releases) and return
 * the cleaned raw snippets as the bio's grounding fuel. Mirrors `fetchTrackContext`'s
 * shape: the SAME Firecrawl v2 search idiom against the SAME endpoint, the SAME lyric/junk
 * domain drop.
 *
 * BEST-EFFORT — returns null (the cron treats it as "no facts, skip") when:
 *   - `FIRECRAWL_API_KEY` is unprovisioned (no key), or
 *   - Firecrawl errors / throws (vendor down), or
 *   - the search returns no usable snippets (a confirmed-empty result).
 *
 * A distil pass is deliberately omitted here: the `context_distil` prompt is track-shaped,
 * and the bio's own authoring prompt already grounds in these raw snippets, so a second LLM
 * hop would buy nothing but a track-flavoured summary. The raw snippets ARE the facts.
 */
export async function fetchEntityFacts(input: {
  kind: EntityKind;
  name: string;
}): Promise<EntityFacts | null> {
  const apiKey = await readOptionalEnv("FIRECRAWL_API_KEY");

  if (!apiKey) {
    return null; // unprovisioned — no facts to gather, the cron skips
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
      return null; // vendor error — best-effort, no facts
    }

    payload = (await response.json()) as { data?: { web?: FirecrawlResult[] } };
  } catch {
    return null; // vendor down / parse failure — best-effort, no facts
  }

  const web = payload?.data?.web ?? [];
  const sources: string[] = [];
  const snippets: string[] = [];

  for (const result of web) {
    if (isLyricDomain(result.url)) {
      continue; // never fold a lyric-site snippet into the facts
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
    return null; // confirmed-empty fetch — no usable facts, the cron skips
  }

  return { facts: snippets.join("\n").slice(0, 2000), sources };
}

type FirecrawlResult = { description?: string; title?: string; url?: string };

// ── The prompt-assembly helper (the reusable seam the future cron authors through) ────

/** The registry slug that authors each entity kind's bio. */
function bioSlug(kind: EntityKind): "describe_artist" | "describe_label" {
  return kind === "artist" ? "describe_artist" : "describe_label";
}

/**
 * Assemble the bio-authoring prompt for one entity — the reusable seam the future on-box
 * sweep calls before its `claude -p` (the auto-note sweep's `buildAuthoringPrompt` lives in
 * the box scripts; this is its Worker-side twin). Resolves the right registry slug, renders
 * the entity's name + its logged findings + the gathered facts into the baked template
 * (which carries the grounding rail), and returns the runnable body plus its provenance
 * version (0 = baked default, N = operator override N) to stamp on the authored bio.
 *
 * TOTAL — `renderRegisteredPrompt` cannot throw and always returns a runnable prompt, so an
 * unreachable prompt table can never stop the sweep (it falls back to the baked default).
 */
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
    // The template's `{{#if noFacts}}` companion to `{{#if facts}}` — so the "author from
    // findings alone" instruction fires exactly when there are no facts (mirrors the
    // note prompt's noContextNote flag).
    noFacts: facts ? undefined : "true",
  });
}
