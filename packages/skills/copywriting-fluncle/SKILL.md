---
name: copywriting-fluncle
description: "Write or edit any copy for the Fluncle platform in Fluncle's voice: web UI strings, empty states, error messages, Telegram posts, CLI and SSH terminal output, README and meta descriptions, link previews, or social posts about Fluncle. Use whenever the task touches user-facing language on any Fluncle surface, even small microcopy edits like a button label, a confirmation toast, or a date column header. Also use when the user mentions bangers, Fluncle's Finest, the Fluncle voice, VOICE.md, a copy sweep, or tone-of-voice alignment."
---

# Copywriting Fluncle

Use this skill to write copy that sounds like Fluncle: the uncle with the good records, doing this since '98, floating somewhere above the tower blocks with a Discman. Fluncle's voice is Maurice's personal voice bent through a persona, a drum & bass vocabulary, and a cosmos. The canonical definition lives in `VOICE.md` at the repository root; this skill tells you how to load and apply it, it does not duplicate it.

## Source priority

1. The user's current brief and facts.
2. `VOICE.md` at the repo root: narrator, vocabulary, named rules, surface registers, mechanics, and the rewrite table. Read it before writing anything. If it is missing, stop and ask rather than improvising the voice.
3. `references/voice-baseline.md` for the inherited baseline (proof over hype, understated confidence, short lines, no em dashes, signature patterns).
4. `references/social-formats.md` when the copy is a social post or longer-form writing (X, LinkedIn, README, blog-shaped) rather than product UI.
5. `PRODUCT.md` and `DESIGN.md` for strategy and visual-system context when copy must align with a surface's design (for example empty states inside the playlist shell).

Where sources disagree on language, `VOICE.md` wins. The two known divergences from the baseline: Fluncle uses sentence case everywhere (never the lowercase X habit), and Fluncle speaks as a persona ("I" = the uncle), not as a founder.

## Workflow

1. Identify the surface: web UI, Telegram, CLI, SSH, README/meta, or social. The surface sets the register via VOICE.md's Depth Gradient (web and Telegram float in space; CLI and SSH get progressively more technical and referential, borderline Ready Player One at the SSH prompt).
2. Read `VOICE.md` in full. It is short by design; do not skim it from memory of a previous session, because the vocabulary and rules evolve there first.
3. Extract the factual payload before writing: what happened (a banger was discovered, a submission arrived, an error occurred), what the reader should do next, and which facts are real. Never invent tracks, artists, dates, listener counts, or scene credentials.
4. Draft in the register of the surface, then tighten against the named rules.
5. Run the final checks below.

## Writing the voice, compressed

These are reminders, not the spec; the spec is VOICE.md.

- Fluncle says "I", addresses the listener as "you", and at identity moments as junglist, raver, or fam. There is no "we"; there is no team, there's an uncle.
- Dry confidence: the music brags, the copy does not. No exclamation marks anywhere.
- "Banger" is the primary noun and lands once per breath; "track" and "tune" carry repeats and technical contexts.
- Dates and the verb around them are about discovery (the moment Fluncle first heard it and went "fuck yeah"), never release or database insertion.
- The cosmos is garnish, never the verb: "Banger received from another dimension" works because "received" still does the job; "Beam up a track" is banned cosplay. Functional labels stay literal.
- Scene vocabulary is used confidently and never explained: tune, roller, rinse, rewind, dubplate, selector, 174, junglist.

## Final checks

Before returning copy, verify against VOICE.md:

- No "transmission", "curated", "content", or marketing buzzwords.
- "Banger" appears at most once per paragraph; repeats became track or tune.
- No exclamation marks. No em dashes in prose (the `Artist — Title` separator is the only sanctioned use).
- Sentence case for UI copy, headings, buttons, and labels; ALL CAPS only quotes the cover art.
- Emoji only on Telegram, only from the sanctioned set (🛸, 🎧).
- Cosmos garnish modifies a working earth verb; it never replaces one, and it never appears inside compact controls.
- The register matches the surface's altitude (quiet on web, emoji-warm on Telegram, dry and technical in the terminal).
- CLI and SSH output stays clean and parseable when it is data; jokes live in help text, welcomes, and empty states, not in machine-readable lines.
- Every claim is real: no invented tracks, dates, stats, or scene history.
