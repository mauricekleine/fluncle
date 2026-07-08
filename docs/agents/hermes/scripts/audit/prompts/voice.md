# Tonight's domain: Voice integrity

Fluncle's voice is the uncle texting his crew — the traveler with the good records who logs what he
finds out there and sends each one back across the Galaxy. Every human-facing string is one of his
findings, said out loud over the tune, never a drafted marketing sentence. Tonight you audit that
voice as a system: every user-facing line against the canon, and every machine-facing entity string
against the honestly-plain third-person rule. The canon is `packages/skills/copywriting-fluncle/references/voice.md`
(repo-root `VOICE.md` points there) — read it before you judge, it wins on any language conflict.

## The hunt

**1. Banned identity words (highest value — one slip breaks the fiction).** Grep the human-facing
copy for the retired vocabulary and kill each on sight: **transmission(s)**, **signal(s)** as
identity, **anomaly**, **curated / curation**, **content** (a banger is never content),
**stream / streaming** as identity, the retired **📻**, and the collection's old name
**"Fluncle's Finest"** / the whole's old name **"the ecosystem"**. Also the inherited
marketing-buzzword ban (seamless, world-class, leverage, unlock, elevate, …) — the uncle has never
said "leverage" in his life. A banned word in a user-facing string is a fix; in a comment or a
variable name, leave it.

**2. Canon names are current.** The collection is **Fluncle's Findings** (the literal Spotify
artifact stays "Playlist"); the whole across surfaces is **the Galaxy**; the community is **the
crew** (a person in it: junglist / raver / fam / cosmonaut); dates are **Found**, never "Added" or
"Released" (the Found Rule); the row-index column is **Log ID**, not "#". A finding **carries** a
banger; it is not itself the music. A mixtape carries the literal `F` marker in its Log ID
(`019.F.1A`) and never touches the found count.

**3. The mechanical rails — cheap to grep, unambiguous to fix.**

- **No exclamation marks** anywhere in copy (the Dry Rule) — the cover already shouts.
- **No em dash in prose.** The `Artist — Title` tracklist separator is the _only_ sanctioned em
  dash; a prose em dash becomes a comma, colon, period, or parentheses.
- **Sentence case** for all UI copy, headings, buttons, labels ("Submit a track", "Latest
  findings"). ALL CAPS only quotes the cover art or a sanctioned brand-mark plate ("RAVE TERMINAL"
  under the SSH figlet). Never lowercase the name **Fluncle** in a sentence; lowercase `fluncle` is
  handles/identifiers only (`@fluncle`, `fluncle://`, `fluncle.com`).
- **The Banger Budget**: "banger" lands at most once per paragraph; a second in the same breath
  becomes track or tune.
- **Emoji: Telegram only**, and only the sanctioned set (🛸, 🎧). Any emoji on web / CLI / SSH, or
  an off-set emoji on Telegram, is a finding.

**4. The stack — human, crew-facing lines only.** A finding note, a Telegram post, an empty state,
a welcome, a confirmation should read as a reaction escaping a body, not a description from outside:
Reality (a real bodily moment under it) → active voice (Fluncle does the verb, no agentless passive
like "the findings hold it together") → the Oof Test (it earned a bodily reaction) → the Selector's
Rule (turns to the crew — the hit, the pass, the address) → the Sauce (the sci-fi sublime _measures_
a real feeling; Strip Test: delete the space-words and a true active sentence must survive). The
Garnish Rule guards compact controls — the cosmos rides a trailing clause, never costumes a working
verb ("Beam up a track" is banned), and functional labels stay literal ("Submit a track", "Search",
"Load more"). Warmth holds throughout (the Mosh Pit Rule): dry and deadpan, never cynical or cold.
These are judgment calls — fix an obvious nit (a stray exclamation, a passive empty state with a
clean rewrite in canon); **file** a rewrite that changes meaning or reaches for new copy.

**5. Machine strings stay honestly-plain.** The entity description and SEO scaffold — `<meta>`/OG,
JSON-LD, llms.txt, the manifest, the definitional line on a log page — are Fluncle _described_, not
speaking: honestly-plain active third-person, no faked warmth, no stack. The identity strings in
`apps/web/src/lib/identity.ts` (`fluncleDescription`, `fluncleMetaDescription`) are **reused
verbatim, edit-there-or-nowhere** — hunt for any surface that paraphrases them instead of importing
them, or a copy that drifted from the string. Both open with the tagline "Drum & bass bangers from
another dimension." A warm stack-shaped line leaking into a machine string, or a paraphrased bio, is
a finding.

**6. Never fabricate.** No invented tracks, artist bios, dates, Log IDs, stats, or scene history in
any copy. A Log ID coordinate is named only where the value actually exists — never minted to fill a
layout. Any hardcoded-looking artist fact in a string is a file, not a fix.

## Where to look first

`apps/web/src/lib/identity.ts` (the verbatim entity strings) ·
`packages/skills/copywriting-fluncle/references/voice.md` (the canon) ·
`apps/web/src/lib/log-prose.ts` (finding prose) · `apps/web/src/routes/` (index, about, log,
mixtapes, artists — empty/error states + microcopy) · `apps/web/src/components/`
(`submit-track-dialog.tsx`, `subscribe-dialog.tsx`, `track-row.tsx`, `save-finding-button.tsx`) ·
`apps/web/src/lib/server/telegram.ts` (Telegram copy + the emoji set) ·
`apps/web/src/lib/server/agent-discovery.ts` + `apps/web/src/lib/json-ld.ts` +
`apps/web/src/lib/log-schema.ts` (machine strings — must stay plain) ·
`apps/cli/src/output.ts` + `apps/cli/src/brand.ts` (CLI help + empty states) ·
`apps/ssh/internal/` (the rave-terminal menu, help, presence lines).
