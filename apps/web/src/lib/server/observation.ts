// The audio-observation pipeline (Worker-side): the third enrichment artifact.
//
// A track's "observation" is Fluncle's spoken, recovered FIELD OBSERVATION — what
// he saw and felt arriving at the coordinate, in the recovered-audio register (a
// new VOICE.md §5 surface; see docs/agents/observation-agent.md). It rides the
// same R2 rails the video bundle runs on (lib/media.ts), and the Worker holds
// every vendor secret — the agent only ever carries its admin token.
//
// Two artifacts, two registers (see docs/track-lifecycle.md + the RFC):
//   1. context_note — firecrawl-derived FACTS (label/year/release). Internal fuel.
//      Never on /log, never in JSON-LD/RSS, never quotes lyrics.
//   2. the observation script — Fluncle's voice, authored by the AGENT (which
//      holds copywriting-fluncle), passed to the observe endpoint. The Worker
//      mechanically scans it (the voice gate) and relays it to ElevenLabs.
//
// The Worker can't run ffmpeg, so it never normalises loudness or probes duration
// (the agent does both if needed). It does the two pure-HTTP vendor calls
// (firecrawl search, ElevenLabs TTS) — a `fetch` await burns ~no Worker CPU and
// the ~0.5 MB mp3 fits in memory.

import { readEnv, readOptionalEnv } from "./env";
import { ApiError } from "./spotify";

// ── The script + render artifacts (R2 `observation.json` shape) ──────────────

/** The TTS model. A config constant so a v3-audio-tags swap is one line. */
export type ObservationModel = "eleven_multilingual_v2" | "eleven_v3";

export const DEFAULT_OBSERVATION_MODEL: ObservationModel = "eleven_multilingual_v2";

export type ObservationVoiceSettings = {
  similarityBoost: number;
  speed: number;
  stability: number;
  style: number;
};

// A measured read for a quiet field observation, tuned by ear for the bespoke
// Fluncle voice: stability steady-but-not-flat (lower than before, so the read
// keeps some life), a touch more style for colour, speed just under 1 so the
// <break/>s breathe.
export const DEFAULT_VOICE_SETTINGS: ObservationVoiceSettings = {
  similarityBoost: 0.75,
  speed: 0.88,
  stability: 0.48,
  style: 0.3,
};

/** The structured observation the agent authors and posts to /observe. */
export type ObservationScript = {
  durationTargetSec: number; // 20–45
  logId: string; // the fluncle:// coordinate
  model: ObservationModel;
  sources?: string[]; // firecrawl provenance, kept off the DB
  text: string; // the spoken prose (with <break/> for v2) — what goes to TTS
  trackId: string;
  voiceSettings: ObservationVoiceSettings;
};

/** What lands at <log-id>/observation.json — script + render metadata + provenance. */
export type ObservationArtifact = ObservationScript & {
  audioUrl: string; // found.fluncle.com/<log-id>/observation.mp3
  contextNote?: string; // the firecrawl facts used as fuel (also stored on the row)
  durationMs: number;
  generatedAt: string;
  provider: "elevenlabs";
  textUrl: string; // …/observation.txt
  voiceId: string;
};

// ── The voice gate (mechanical scan) ─────────────────────────────────────────
//
// The North-Star human sign-off (does the rendered audio clear "would the uncle
// say this out loud over a tune?") is a separate content control. This is the
// AUTOMATABLE half: the bans, the Dry Rule, no "we"-as-company. The script is a
// live Fluncle voice surface, so a banned word in a SPOKEN artifact is a brand
// failure that can't be skimmed past — the gate hard-fails the render.

// VOICE.md §3 banned identity words. `signal`/`transmission` are the radio
// metaphor the dimension/log metaphor replaced; `anomaly` is the sci-fi cliché;
// `curated`/`content` are gallery/marketing words; `stream(ing)` as identity is
// Spotify's, not Fluncle's. Matched as whole words, case-insensitively.
const BANNED_WORDS = [
  "signal",
  "signals",
  "transmission",
  "transmissions",
  "anomaly",
  "curated",
  "curation",
  "content",
  "streaming",
] as const;

// Earthly geography is banned from the SPOKEN read: the cosmos replaces the map,
// so no countries, cities, nationalities, or regions. The context_note (firecrawl
// facts) may carry "US/American producer" as fuel, but a real render leaked it as
// "the American side of the map", breaking the fiction — translate an origin into
// a far sector or drop it (see references/recovered-audio-delivery.md). This list
// is deliberately TIGHT: only terms with no plausible cosmic or innocent meaning
// in a 30s observation, so ambiguous short tokens that would false-positive (e.g.
// a bare "us"/"uk") are left out and only their unambiguous dotted forms are
// caught. Matched as whole words, case-insensitively.
const BANNED_GEOGRAPHY = [
  "american",
  "americas",
  "america",
  "british",
  "britain",
  "england",
  "english",
  "london",
  "dutch",
  "holland",
  "netherlands",
  "european",
  "europe",
  "u.k.",
  "u.s.",
  "usa",
] as const;

export type VoiceGateViolation = { reason: string; word?: string };

/**
 * Scan a spoken observation script for the automatable voice-gate failures.
 * Returns the violations (empty = clean). The endpoint hard-fails on any.
 */
export function scanObservationScript(text: string): VoiceGateViolation[] {
  const violations: VoiceGateViolation[] = [];
  const lower = text.toLowerCase();

  for (const word of BANNED_WORDS) {
    // Whole-word match so "signature"/"contention" don't false-positive.
    if (new RegExp(`\\b${word}\\b`, "i").test(lower)) {
      violations.push({ reason: `banned identity word "${word}" (VOICE.md §3)`, word });
    }
  }

  for (const place of BANNED_GEOGRAPHY) {
    // Escape the dotted abbreviations (u.k./u.s.) and anchor on word boundaries.
    // A trailing dot already ends the token, so we only need a trailing \b for the
    // plain alphabetic terms.
    const escaped = place.replace(/\./g, "\\.");
    const pattern = place.endsWith(".") ? `\\b${escaped}` : `\\b${escaped}\\b`;

    if (new RegExp(pattern, "i").test(lower)) {
      violations.push({
        reason: `earthly geography "${place}" — the cosmos replaces the map; translate an origin into a far sector or drop it (recovered-audio-delivery.md)`,
        word: place,
      });
    }
  }

  if (text.includes("!")) {
    violations.push({ reason: "exclamation mark (the Dry Rule bans them)" });
  }

  // "we" as a company — Fluncle says "I"; there's an uncle and his crew, no team.
  if (/\bwe\b/i.test(text)) {
    violations.push({
      reason: 'first-person plural "we" — Fluncle says "I", never "we" as a company',
    });
  }

  return violations;
}

const SCRIPT_MIN_CHARS = 80;
const SCRIPT_MAX_CHARS = 1200; // ~45s of speech at a measured pace; v2 SSML is well under the 5k cap

/**
 * Validate + voice-gate an agent-authored script, throwing a clean ApiError on any
 * failure (the catch turns it into a 4xx). Returns the trimmed text on success.
 */
export function gateObservationScript(text: unknown): string {
  if (typeof text !== "string" || !text.trim()) {
    throw new ApiError("no_script", "An observation `script` (the spoken text) is required", 400);
  }

  const trimmed = text.trim();

  if (trimmed.length < SCRIPT_MIN_CHARS) {
    throw new ApiError(
      "script_too_short",
      `The observation script is too short (${trimmed.length} < ${SCRIPT_MIN_CHARS} chars)`,
      422,
    );
  }

  if (trimmed.length > SCRIPT_MAX_CHARS) {
    throw new ApiError(
      "script_too_long",
      `The observation script is too long (${trimmed.length} > ${SCRIPT_MAX_CHARS} chars)`,
      422,
    );
  }

  const violations = scanObservationScript(trimmed);

  if (violations.length > 0) {
    throw new ApiError(
      "voice_gate",
      `The observation script fails the voice gate: ${violations
        .map((violation) => violation.reason)
        .join("; ")}`,
      422,
    );
  }

  return trimmed;
}

// ── Firecrawl context fetch (the context_note) ───────────────────────────────
//
// Raw `fetch` to the REST endpoint, not the Node-authored SDK (its workerd
// `nodejs_compat` cleanliness is unverified). A single search payload is trivially
// Worker-safe. The result is FACTS ONLY — lyric-site snippets are dropped, and
// the assembled note never quotes lyrics.

const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";

// Lyric/tab domains whose snippets we never fold into the context note (a leaked
// lyric in a spoken artifact is a copyright + voice problem at once).
const LYRIC_DOMAINS = [
  "genius.com",
  "azlyrics.com",
  "lyrics.com",
  "metrolyrics.com",
  "musixmatch.com",
  "songlyrics.com",
  "lyricsfreak.com",
  "lyricstranslate.com",
];

type FirecrawlResult = { description?: string; title?: string; url?: string };

function isLyricDomain(url: string | undefined): boolean {
  if (!url) {
    return false;
  }

  try {
    const host = new URL(url).hostname.replace(/^www\./, "");

    return LYRIC_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

export type ContextFetchResult = { contextNote: string; sources: string[] };

/**
 * Build the Firecrawl search query for a track's factual context from its
 * metadata. One assembly point shared by the `observe-context` step and (as a
 * fallback) `observe_track`, so both fetch the same facts. The track fields are
 * Spotify/Deezer metadata — trusted identity strings, not free web content.
 */
export function buildContextQuery(track: {
  artists: string[];
  label?: string;
  releaseDate?: string;
  title: string;
}): string {
  return [track.artists.join(" "), track.title, track.label, track.releaseDate, "drum and bass"]
    .filter(Boolean)
    .join(" ");
}

/**
 * Firecrawl search for the track's factual context (label/year/release/artist
 * background). Assembles the non-lyric snippets into a compact note and returns
 * the source URLs (provenance — kept off the DB, stored in observation.json).
 * Best-effort: a firecrawl failure returns an empty note rather than blocking the
 * render (the agent-authored script can stand on the track metadata alone).
 */
export async function fetchTrackContext(query: string): Promise<ContextFetchResult> {
  const apiKey = await readEnv("FIRECRAWL_API_KEY");

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
      return { contextNote: "", sources: [] };
    }

    payload = (await response.json()) as { data?: { web?: FirecrawlResult[] } };
  } catch {
    return { contextNote: "", sources: [] };
  }

  const web = payload?.data?.web ?? [];
  const sources: string[] = [];
  const lines: string[] = [];

  for (const result of web) {
    if (isLyricDomain(result.url)) {
      continue; // never fold a lyric-site snippet into the facts
    }

    const title = result.title?.trim();
    const description = result.description?.trim();

    if (title || description) {
      lines.push([title, description].filter(Boolean).join(" — "));
    }

    if (result.url) {
      sources.push(result.url);
    }
  }

  // A lean, internal note — facts as fuel, never public copy.
  const contextNote = lines.join("\n").slice(0, 2000);

  return { contextNote, sources };
}

// ── ElevenLabs render ────────────────────────────────────────────────────────
//
// Raw `fetch` to the TTS REST endpoint (same Worker-safety reasoning as
// firecrawl). The voice id is a config secret/var (swappable for the bespoke
// Fluncle voice later); the API key is a Worker secret. Returns the mp3 bytes;
// the Worker R2.put()s them (≈0.5 MB, well under the edge limit). ElevenLabs does
// NOT return a duration — the agent probes it with ffprobe and passes durationMs.

const ELEVENLABS_OUTPUT_FORMAT = "mp3_44100_128";

export type RenderObservationOptions = {
  model: ObservationModel;
  text: string;
  voiceSettings: ObservationVoiceSettings;
};

export type RenderedObservation = { bytes: ArrayBuffer; voiceId: string };

/** Resolve the configured ElevenLabs voice id (the request may override it). */
export async function resolveVoiceId(override?: string): Promise<string> {
  if (typeof override === "string" && override.trim()) {
    return override.trim();
  }

  const configured = await readOptionalEnv("ELEVENLABS_VOICE_ID");

  if (!configured) {
    throw new ApiError(
      "no_voice_id",
      "No ELEVENLABS_VOICE_ID configured and no voiceId in the request",
      400,
    );
  }

  return configured;
}

/** Render the spoken observation to mp3 bytes via the ElevenLabs TTS REST API. */
export async function renderObservation(
  voiceId: string,
  { model, text, voiceSettings }: RenderObservationOptions,
): Promise<RenderedObservation> {
  const apiKey = await readEnv("ELEVENLABS_API_KEY");
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
    voiceId,
  )}?output_format=${ELEVENLABS_OUTPUT_FORMAT}`;

  const response = await fetch(url, {
    body: JSON.stringify({
      model_id: model,
      text,
      voice_settings: {
        similarity_boost: voiceSettings.similarityBoost,
        speed: voiceSettings.speed,
        stability: voiceSettings.stability,
        style: voiceSettings.style,
      },
    }),
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey,
    },
    method: "POST",
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");

    throw new ApiError(
      "elevenlabs_error",
      `ElevenLabs render failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      502,
    );
  }

  return { bytes: await response.arrayBuffer(), voiceId };
}
