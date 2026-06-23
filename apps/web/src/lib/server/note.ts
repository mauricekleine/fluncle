// The auto-note pipeline (Worker-side): the WRITTEN-note sibling of the spoken
// observation. A finding's `note` is its public editorial "why" — the line that
// shows on `/log/<id>`. Today the operator writes it by hand; this is the path that
// lets Fluncle AUTO-author it, mirroring the observation pipeline as closely as the
// difference between heard and read allows (see docs/agents/note-agent.md).
//
// Two registers, two gates:
//   - the observation SCRIPT is SPOKEN (recovered-audio): scanned by
//     `gateObservationScript` (observation.ts), rendered to mp3, internal until a
//     surface plays it.
//   - the NOTE is WRITTEN and PUBLIC: it lands straight on `/log`, so its gate is
//     the same DEFENCE-IN-DEPTH shape — the agent authors through
//     `copywriting-fluncle`, and the Worker re-runs the mechanical scan and
//     hard-fails any violation before the note is stored.
//
// The bans are SHARED with the spoken gate (one VOICE.md §3 banned-identity-word
// list, one earthly-geography list, the Dry Rule's no-exclamation-marks, no
// "we"-as-company) — `scanObservationScript` is the single source of truth, so a
// word banned in the heard surface is banned in the read one too. Only the LENGTH
// bound differs: a note is a short editorial line (the public `NOTE_MAX_LENGTH`
// 280-char budget), not a 20–45s read.

import { NOTE_MAX_LENGTH } from "../log-prose";
import { scanObservationScript } from "./observation";
import { ApiError } from "./spotify";

// A note is a single editorial line, not a paragraph. Floor it well below the
// spoken script's 80 so a terse, certain note ("Pure rolling menace. That's why
// it's here.") clears, but a one-word stub doesn't. The ceiling is the SAME public
// budget the operator's hand-written note is held to (`parseEditorialNote` →
// NOTE_MAX_LENGTH), so an auto-note can never store a longer string than a typed one.
const NOTE_MIN_CHARS = 24;
const NOTE_MAX_CHARS = NOTE_MAX_LENGTH;

/**
 * Validate + voice-gate an agent-authored finding note, throwing a clean ApiError on
 * any failure (the handler's catch turns it into a 4xx). Returns the trimmed note on
 * success. Reuses the spoken gate's shared banned-word / earthly-geography /
 * exclamation / "we"-as-company scan (one source of truth), with the WRITTEN note's
 * own length bounds. The note is a public `/log` surface, so a violation hard-fails
 * the store before the note is ever shown.
 */
export function gateNoteText(text: unknown): string {
  if (typeof text !== "string" || !text.trim()) {
    throw new ApiError("no_note", "A `note` (the finding's editorial line) is required", 400);
  }

  const trimmed = text.trim();

  if (trimmed.length < NOTE_MIN_CHARS) {
    throw new ApiError(
      "note_too_short",
      `The note is too short (${trimmed.length} < ${NOTE_MIN_CHARS} chars)`,
      422,
    );
  }

  if (trimmed.length > NOTE_MAX_CHARS) {
    throw new ApiError(
      "note_too_long",
      `The note is too long (${trimmed.length} > ${NOTE_MAX_CHARS} chars)`,
      422,
    );
  }

  const violations = scanObservationScript(trimmed);

  if (violations.length > 0) {
    throw new ApiError(
      "voice_gate",
      `The note fails the voice gate: ${violations.map((violation) => violation.reason).join("; ")}`,
      422,
    );
  }

  return trimmed;
}
