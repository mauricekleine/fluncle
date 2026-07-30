// The entity-bio engine (Worker-side): the artist/label/album BIO is the entity sibling of a
// finding's editorial `note`. Where the auto-note authors one line about one FINDING, this
// authors a short paragraph about an ARTIST, a LABEL, or an ALBUM — grounded in Firecrawl facts
// + the tracks Fluncle has actually LOGGED, never a fabricated discography, roster, or tracklist.
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
//     It carries THE NAME EXEMPTION (`maskEntityName`): the gate judges the prose FLUNCLE wrote,
//     so the entity's own name is masked out before the scan. A bio may name "Future Signal"; it
//     still fails on a generic "signal" anywhere else.
//   - `acceptFinalDraftBio` — the ONE bounded exception to that hard fail, and a BACKSTOP rather
//     than a routine path: after three authoring attempts the sweep's last draft is stored even
//     when the scan refuses it, with the violations handed back so the acceptance is logged and
//     reviewable, never silent.
//   - `fetchEntityFacts` — the Firecrawl fact-gather, generalized from `fetchTrackContext`. It
//     fires the SAME Firecrawl v2 search idiom (the shared `FIRECRAWL_SEARCH_URL` + the
//     `FIRECRAWL_API_KEY` env read), drops the same lyric/junk domains, and returns the raw
//     snippets as the bio's grounding fuel. Best-effort: null on no key / no results (the cron
//     treats that as "no facts, skip").
//   - `buildEntityBioPrompt` — the reusable prompt-assembly the future cron calls: it resolves
//     the right registry slug (`describe_artist` / `describe_label` / `describe_album`), interpolates the entity's
//     name, its logged findings, and the gathered facts, and returns the rendered body + its
//     provenance version. The GROUNDING RAIL lives in the baked prompt (see prompts.ts).
//
// The AUTHORING itself (the `claude -p` call) is NOT here — it runs in the box cron, exactly
// like the auto-note sweep. The Worker's job is the gate, the facts, and the fill-empty-only
// store (`fillEmptyArtistBio` / `fillEmptyLabelBio` / `fillEmptyAlbumBio` in artists.ts /
// labels.ts / albums.ts).

import { readOptionalEnv } from "./env";
import {
  FIRECRAWL_SEARCH_URL,
  isLyricDomain,
  maskEntityName,
  scanObservationScript,
  type VoiceGateViolation,
} from "./observation";
import { renderRegisteredPrompt } from "./prompts";
import { ApiError } from "./spotify";

/** Which entity a bio describes — the artist page, the record-label page, or the album page. */
export type EntityKind = "artist" | "label" | "album";

// A bio is a short paragraph (2–4 sentences), not a one-line note. Floor it well above
// the note's 24 so a bare stub cannot clear, and cap it at 500 — long enough for four
// dry sentences, short enough that it can never grow into a Wikipedia dump. The ceiling
// is deliberately looser than the note's 280 public budget (a note is ONE line; a bio is
// a paragraph), but the VOICE bans are identical.
const BIO_MIN_CHARS = 40;
const BIO_MAX_CHARS = 500;

/**
 * THE NAME EXEMPTION. The bio was the first family to get it (the operator's 2026-07-29 ruling on
 * the runaway rewrite loop); it now belongs to every voiced family, so the implementation, the
 * full rationale, and its one accepted cost live beside the shared scan in ./observation.ts. It is
 * re-exported here because this module is where the exemption was born and where its tests read
 * it from — the bio's own gate is the single-name case, `maskEntityName(bio, entityName)`.
 */
export { maskEntityName } from "./observation";

/**
 * Validate + voice-gate an agent-authored entity bio, throwing a clean ApiError on any
 * failure (the handler's catch turns it into a 4xx). Returns the trimmed bio on success.
 * Reuses the note/observation shared voice scan (one source of truth for the banned
 * identity words / exclamation / "we"-as-company bans) in the FACTUAL DOSSIER register:
 * it passes `{ allowGeography: true }`, so a Wikipedia-style bio may name a real country
 * or city plainly — the one ban this gate deliberately drops. It carries the bio's own
 * longer length bounds. The bio is a public entity surface, so a violation hard-fails the
 * store before it is ever shown.
 *
 * `entityName` is the entity this bio is ABOUT, and it is required rather than optional so a new
 * call site cannot silently forget the exemption: its occurrences are masked out before the scan
 * (see `maskEntityName`). The LENGTH bounds are measured on the WHOLE bio, name included — the
 * exemption is about what Fluncle is judged for saying, not about how long the paragraph is.
 */
export function gateBioText(text: unknown, entityName: string): string {
  const trimmed = requireStorableBio(text);
  const violations = scanBioProse(trimmed, entityName);

  if (violations.length > 0) {
    throw new ApiError("voice_gate", voiceGateMessage(violations), 422);
  }

  return trimmed;
}

/** The one scan both the gate and the final-attempt acceptance run: the bio minus its subject's name. */
function scanBioProse(bio: string, entityName: string): VoiceGateViolation[] {
  return scanObservationScript(maskEntityName(bio, entityName), { allowGeography: true });
}

// ── THE FINAL-ATTEMPT ACCEPTANCE — a SEVERABLE unit ──────────────────────────────────────
//
// This exists on the operator's explicit ruling and is under canon review; it may be reversed.
// It is therefore built to come out in one clean deletion rather than an unpick. To remove it:
//
//   1. delete `acceptFinalDraftBio` and collapse `gateOrAcceptBio` to `{ bio: gateBioText(…) }`
//      (the handlers spread its result, so they need no edit at all);
//   2. drop `finalAttempt` / `gateBypassed` / `voiceViolations` from the three describe contracts;
//   3. drop `--final-attempt` from the CLI (`buildBioBody`, `BioDescribeOptions`, the three
//      `.option()` calls, the `gateBypassed` print) ;
//   4. in the sweep, stop passing `finalAttempt` to `deliverBio` and drop the `bypassedGate`
//      counter.
//
// NOTHING ELSE DEPENDS ON IT. The attempt budget is a separate mechanism and stands on its own:
// with the acceptance gone, a third rejected draft simply lands on the `exhausted` terminal
// outcome the sweep already implements and tests. The name exemption is likewise independent —
// and note it now clears every example this acceptance was originally justified by.

/**
 * THE FINAL-ATTEMPT ACCEPTANCE — the one place the bio voice SCAN is allowed not to hard-fail.
 *
 * The operator's ruling (2026-07-29): an entity gets at most THREE authoring attempts — the
 * initial draft plus two rewrites — and the third draft LANDS rather than being discarded. The
 * on-box `entity-bio-sweep` counts the attempts and asks for this by sending `finalAttempt` on
 * its third and last pass; nothing else in the app may call it.
 *
 * It is the BACKSTOP, not the routine path. The unsatisfiable rejections that caused the runaway —
 * an entity whose own NAME carries a banned word — are fixed at the source by the name exemption
 * above, so a bio about "Future Signal" now clears the gate on attempt 1. What is left for this to
 * catch is a genuinely bad draft: three passes of prose Fluncle chose that still will not clear.
 * At that point another rewrite is a coin flip, and the operator's call is that the third draft
 * lands and gets reviewed rather than the queue spinning on it forever.
 *
 * WHAT IT BYPASSES: the voice SCAN only — the banned-identity-word / exclamation / "we"-as-company
 * checks. It returns the violations rather than swallowing them, so the caller can log the
 * acceptance distinctly and the operator can find and review every bio that landed this way.
 *
 * WHAT IT STILL ENFORCES: `requireStorableBio` — a present, non-empty bio inside the length bounds.
 * Those are not voice judgments; they are what makes the paragraph a renderable paragraph, and
 * unlike a banned name a rewrite genuinely CAN converge on them (the prompt asks for 2–4
 * sentences). A final attempt that is empty / too short / too long still hard-fails, and the sweep
 * reports it as an exhausted entity rather than storing a stub or a Wikipedia dump.
 *
 * It deliberately does NOT retune `BIO_MIN_CHARS`, `BIO_MAX_CHARS`, or the banned lists — loosening
 * the gate itself is a canon call, and this is a bounded escape hatch, not a lower bar.
 */
export function acceptFinalDraftBio(
  text: unknown,
  entityName: string,
): { bio: string; violations: VoiceGateViolation[] } {
  const bio = requireStorableBio(text);

  // The SAME scan the gate runs, name exemption included — so the violations reported here are
  // the real ones the operator has to review, not a stale reading of the entity's own name.
  return { bio, violations: scanBioProse(bio, entityName) };
}

/**
 * The ONE decision point every `describe_*` handler routes its bio through, so artist / label /
 * album can never drift on when a voice violation is fatal.
 *
 * Normal pass (`finalAttempt` absent/false): `gateBioText`, which throws on any violation —
 * unchanged behaviour, and the returned envelope carries no marker.
 *
 * The sweep's third and last pass (`finalAttempt: true`): `acceptFinalDraftBio`, which stores the
 * draft anyway. When it actually accepted something the scan refused, this LOGS THE ACCEPTANCE
 * distinctly (one greppable `FINAL-ATTEMPT ACCEPTANCE` line naming the entity and every reason)
 * and returns `gateBypassed: true` + the reasons, so the box's cron output and the CLI carry the
 * same review flag. A clean third draft is an ordinary write and gets no marker.
 */
export function gateOrAcceptBio(input: {
  bio: unknown;
  finalAttempt: boolean;
  kind: EntityKind;
  /** The entity this bio is ABOUT — its own name is exempt from the scan (`maskEntityName`). */
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

/** The `voice_gate` 422 message, shared so a bypassed acceptance logs the same words it would have thrown. */
export function voiceGateMessage(violations: readonly VoiceGateViolation[]): string {
  return `The bio fails the voice gate: ${violations.map((violation) => violation.reason).join("; ")}`;
}

/**
 * The structural half of the bio gate: present, non-empty, and inside the length bounds. Shared by
 * `gateBioText` and `acceptFinalDraftBio` so the two can never drift on what is STORABLE — only on
 * whether a voice violation is fatal.
 */
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
 * producer; a label is an imprint; an album is a release. The genre anchor ("drum and bass")
 * narrows the result set to Fluncle's lane, exactly as the track query does — the widest query
 * that still lands on the right entity. The name is a trusted identity string, not free web
 * content.
 */
export function buildEntityFactsQuery(kind: EntityKind, name: string): string {
  const descriptor =
    kind === "artist"
      ? "drum and bass producer"
      : kind === "label"
        ? "drum and bass record label"
        : "drum and bass album";

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
function bioSlug(kind: EntityKind): "describe_artist" | "describe_label" | "describe_album" {
  return kind === "artist"
    ? "describe_artist"
    : kind === "label"
      ? "describe_label"
      : "describe_album";
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
