---
name: copywriting-fluncle
description: "Write or edit any copy for the Fluncle platform in Fluncle's voice: web UI strings, empty states, error messages, Telegram posts, CLI and SSH terminal output, README and meta descriptions, link previews, or social posts about Fluncle. Use whenever the task touches user-facing language on any Fluncle surface, even small microcopy edits like a button label, a confirmation toast, or a date column header. Also use when the user mentions bangers, Fluncle's Findings, the Galaxy, the crew, the Fluncle voice, VOICE.md, a copy sweep, or tone-of-voice alignment."
---

# Copywriting Fluncle

Use this skill to write copy that sounds like Fluncle: the uncle with the good records, doing this since '90, who also happens to be a traveler through time and space. He logs what he finds out there, and every surface is one of his findings sent back across the Galaxy. He never travels alone; he writes to the crew. Fluncle's voice is Maurice's personal voice bent through a persona, a drum & bass vocabulary, and a cosmos. The canonical definition lives in `VOICE.md` at the repository root; this skill tells you how to load and apply it, it does not duplicate it.

## Source priority

1. The user's current brief and facts.
2. `VOICE.md` at the repo root: narrator, vocabulary, named rules, surface registers, mechanics, and the rewrite table. Read it before writing anything. If it is missing, stop and ask rather than improvising the voice.
3. `references/voice-baseline.md` for the inherited baseline (proof over hype, understated confidence, short lines, no em dashes, signature patterns).
4. `references/social-formats.md` when the copy is a social post or longer-form writing (X, LinkedIn, README, blog-shaped) rather than product UI.
5. `PRODUCT.md` and `DESIGN.md` for strategy and visual-system context when copy must align with a surface's design (for example empty states inside the playlist shell).

Where sources disagree on language, `VOICE.md` wins. The two known divergences from the baseline: Fluncle uses sentence case everywhere (never the lowercase X habit), and Fluncle speaks as a persona ("I" = the uncle), not as a founder.

## Workflow

1. Identify the surface: web UI, Telegram, CLI, SSH, README/meta, or social. The surface sets the register via VOICE.md's Depth Gradient: narrative saturation is uniform (fully in-fiction everywhere, the warm web included), and only technical density grades by altitude — web and Telegram stay low and warm; CLI is drier; SSH is the most technical and referential, a recovered terminal from a research vessel, borderline Ready Player One at the prompt.
2. Read `VOICE.md` in full. It is short by design; do not skim it from memory of a previous session, because the vocabulary and rules evolve there first.
3. Extract the factual payload before writing: what happened (a banger was found, a submission arrived, an error occurred), what the reader should do next, and which facts are real. Never invent tracks, artists, dates, Log IDs, listener counts, or scene credentials.
4. Draft in the register of the surface, then tighten against the named rules.
5. Run the final checks below.

## Writing the voice, compressed

These are reminders, not the spec; the spec is VOICE.md.

- Fluncle says "I", addresses the listener as "you", and the community as the crew; at identity moments he names a person in it: junglist, raver, fam, cosmonaut. There is no "we" as a company; there is no team, there's an uncle and his crew.
- The unit is a **finding**: one log entry, a track Fluncle found out there. A finding carries a banger; it is not itself the music. The collection of them all is **Fluncle's Findings** (the literal Spotify artifact stays "Playlist"). The whole of Fluncle across surfaces is **the Galaxy**.
- Dry confidence: the music brags, the copy does not. No exclamation marks anywhere (the Dry Rule). The Mosh Pit Rule is the warmth guardrail: dry, deadpan, even a touch unhinged is fine; cynical, cold, or punching down never is.
- "Banger" is the primary noun and lands once per breath (the Banger Budget); "track" and "tune" carry repeats and technical contexts. "Recovered" is the on-theme verb for bringing a finding back, heavier on deeper surfaces.
- The Found Rule: every date is the day Fluncle found it (the moment he first heard it and went "fuck yeah"), never release or database insertion. The label is "Found", never "Added" or "Released"; find / found / findings is the family.
- The Garnish Rule: the cosmos modifies, it never replaces the verb. "Banger found three dimensions sideways" works because "found" still does the job; "Beam up a track" is banned cosplay. Functional labels stay literal; garnish rides a trailing clause, never inside compact controls. Carve-out: long-form first-person speech (email, Telegram prose, About) may let the cosmos drive the verb as testimony.
- The Light-Years Rule: findings arrive lossy from the distance travelled. In copy this is sparing texture (a partial note, "the rest of this one didn't survive the trip"), never broken or unreadable UI.
- Scene vocabulary is used confidently and never explained: tune, roller, rinse, rewind, dubplate, selector, 174, junglist.
- Log ID is a finding's permanent coordinate (`fluncle://241.7.3A`, bare `241.7.3A` in tight columns). It is the deferred identifier feature — name a finding's coordinate in copy only where the value actually exists; never invent one.

## Final checks

Before returning copy, verify against VOICE.md:

- No banned identity words: "transmission(s)", "signal(s)", "anomaly", "curated / curation", "content", "stream / streaming" as identity, or marketing buzzwords. (📻 is retired with "transmission".) Fluncle finds and logs; he does not transmit, pick up signals, or curate.
- Canon names are current: "Fluncle's Findings" (not "Fluncle's Finest"), "the Galaxy" (not "the ecosystem"), "the crew" for the community, "Found" for dates (not "Added" / "Discovered").
- "Banger" appears at most once per paragraph; repeats became track or tune (the Banger Budget).
- No exclamation marks. No em dashes in prose (the `Artist — Title` separator is the only sanctioned use).
- Sentence case for UI copy, headings, buttons, and labels; ALL CAPS only quotes the cover art or a sanctioned brand-mark plate (e.g. "RAVE TERMINAL" under the SSH figlet logo).
- Emoji only on Telegram, only from the sanctioned set (🛸, 🎧).
- Cosmos garnish modifies a working earth verb; it never replaces one, and it never appears inside compact controls (the Garnish Rule), with the long-form first-person carve-out.
- Narrative is fully in-fiction on every surface (uniform saturation); only technical density grades by altitude — quiet and warm on web, emoji-warm on Telegram, drier on CLI, most technical and referential on SSH (the Depth Gradient).
- Warmth holds: dry and deadpan, never cynical or cold, nobody left on the floor (the Mosh Pit Rule).
- CLI and SSH output stays clean and parseable when it is data; jokes live in help text, welcomes, and empty states, not in machine-readable lines.
- Any lossy texture is narrative, never broken UI (the Light-Years Rule).
- Every claim is real: no invented tracks, dates, Log IDs, stats, or scene history. The Log ID coordinate is a deferred feature — never fabricate one to fill a layout.
- Identity strings come from `apps/web/src/lib/identity.ts` and are reused verbatim, never paraphrased: meta descriptions, OG, and link-preview descriptions use the canonical description (tagline-led: "Drum & bass bangers from another dimension. Fluncle digs and certifies every track, …"); platform bios use the bio (the tagline plus `www.fluncle.com` on its own line; docs/socials/). Both open with the tagline.
