// Some legacy observation scripts (authored before the Cartesia migration) carry the
// occasional SSML tag a reader doesn't want — a pause (`<break time="1.0s" />`) or an
// emphasis span (`<emphasis>…</emphasis>`). Cartesia strips these at render time, but
// they must never reach a human-facing surface as literal text either (the admin
// transcript reads the raw stored script).
//
// `stripSsml` removes every `<…>` tag SPAN from a free-prose string and collapses
// the double space a mid-sentence tag leaves behind, so the transcript reads as the
// clean prose it speaks. This is the prose-string counterpart to the token-level
// drop in `parseObservationAlignment` (lib/server/tracks.ts): that path works over
// a pre-tokenised alignment array and drops whole tag "words"; this one strips the
// markup spans out of a single string.

/**
 * Strip SSML tag spans (e.g. `<break time="1.0s" />`, `<emphasis>…`) from an
 * observation script string, collapsing the resulting run of spaces to one and
 * trimming. A string with no tags is returned unchanged (modulo trim).
 */
export function stripSsml(text: string): string {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
