// The Voice canon's banned identity words, in ONE place.
//
// Two independent gates enforce this list and they must never drift apart:
//   1. the RUNTIME gate on AGENT-authored text — `gateVoice` in ./observation.ts
//      and its note/bio/logbook siblings, which hard-fail a render or a write,
//   2. the BUILD-TIME static lint over HAND-WRITTEN user-facing string literals
//      (./voice-lint.test.ts), which fails `deploy:gate`.
//
// It lived only inside observation.ts before, so the static lint would have had
// to copy it — and a canon ratification that lands in one copy and not the other
// is exactly the class of bug both gates exist to catch. One array, two readers.

// VOICE.md §3 banned identity words. `signal`/`transmission` are the radio
// metaphor the dimension/log metaphor replaced; `anomaly` is the sci-fi cliché;
// `curated`/`content` are gallery/marketing words; `stream(ing)` as identity is
// Spotify's, not Fluncle's. Matched as whole words, case-insensitively.
//
// The CURATE family is listed in full. §3 bans the row "curated / curation" on the
// reason "Fluncle digs and certifies; he doesn't curate", and the Core terms table
// settles the noun in the same breath ("**selector** — What Fluncle is. Not curator,
// not admin, not editor"). Both sentences name forms the row's two words do not
// spell, so the verb and the agent noun are written out here rather than left to a
// stemmer: whole-word matching has no stem, and "Fluncle curates the archive" would
// otherwise pass both gates.
export const BANNED_WORDS = [
  "signal",
  "signals",
  "transmission",
  "transmissions",
  "anomaly",
  "curate",
  "curated",
  "curates",
  "curating",
  "curation",
  "curator",
  "curators",
  "content",
  "streaming",
] as const;
