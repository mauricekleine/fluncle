# Homogenisation — the evidence ledger

The collection phase for the roadmap's Homogenisation slice ([ROADMAP.md](./ROADMAP.md) § Homogenisation — the operator calls the phenomenon "Homogenisis"): Fluncle's generated artifacts drift toward a mean, and an archive whose every artifact rhymes with its neighbours reads as machine-made — the one thing the persona cannot afford. The operator's ruling (2026-07-13): **collect evidence first, address it properly later.** This file is where occurrences land as they are seen, so the eventual design pass starts from a real corpus of failures rather than a vibe.

## How to add an entry

One dated entry per observed occurrence: the artifact family (notes / observations / videos / covers / sprites / logbook / captions), what specifically repeats (a palette, a texture, a phrase, a structure), how many of how many artifacts it touches, and — when a metric exists — the measured number. Screenshots go in [assets/](./assets/). An entry is evidence, not a fix; counter-measures that already exist are noted so the ledger stays honest about what is and is not already handled.

## The ledger

### 2026-07-14 · Observations — the counter-measure ships (the notes' rail, ported to the spoken family)

The audit below named the observations the confirmed priority (echoing 59/61, mean pairwise 0.0816, "…enjoy cosmonauts" verbatim closing 32/61, "hope" in 51/61, 34/61 opening on "I…"/"This one…") and the context-note `Texture:` vocabulary as the upstream seed. The same day, the notes' proven mechanism (the vibe-neighbour layer + echo gate, 0.041 → 0.015) was ported to them end to end:

- **The vibe-neighbour layer:** the observe sweep now authors against the finding's sonic neighbours' scripts, handed to the model as SPENT moves (openers, closers, body reactions, sign-offs) over a new agent-tier `list_observation_neighbours` read. `OBSERVE_NEIGHBORS=0` is the A/B control.
- **The echo gate:** `observe_track` re-reads the same neighbours and 422s a draft that lifts a ≥4-word run or reuses ≥0.3 of a neighbour's content words — BEFORE the Cartesia render, so a bounce costs nothing. One pointed re-author, then the finding stays unvoiced. Same scorer as the note gate (a shared `scoreEcho`), operator-tunable dials on their own `settings` keys.
- **The ledger:** a rejected script is HELD (`observation_rejections`, one open row per finding) and raised in the attention queue (`observation-rejected`); the operator rules from the observation dialog's held panel — Render it (a deliberate, render-spending overrule) or Bin it.
- **The closer formula broken in the prompt:** the baked `observation_script` prompt (and the registry default) now treats the crew address as one move among several — rotate the kin name (junglist / raver / fam / cosmonaut), vary the phrasing, sometimes no sign-off — and names "hope it… enjoy, cosmonauts" as worn through. Opener variation is mandated the same way.
- **The upstream seed:** the `context_distil` prompt's `Texture:` instruction now demands track-specific pointers across the full sensory range and names `rolling`/`liquid`/`introspective`/`atmospheric`/`breakbeats` as overused; the line's parseable shape is unchanged.
- **The measure:** `measure-artifact-diversity.ts` grew a REGISTER cut per family — top openers/closers (first/last 3 words), the opening-word histogram, and the crutch words `hope`/`enjoy`/`cosmonaut(s)`/`shoulders` — so the audit's hand-made numbers above are now one command, re-runnable.
- **Provenance:** the audit's `note_prompt_version`-NULL-on-60/61 finding traced to HISTORY, not a broken write — the stamp shipped with the prompt registry (#516) after most of the corpus was authored, and the forward path (sweep → CLI → handler → the atomic fill) is now pinned by tests so it cannot silently reopen. Observations were already stamped (`observation_prompt_version`); rows authored before the registry stay honestly NULL.

**Honesty note:** these are the mechanisms, not yet the after-numbers. The before-numbers are the audit's (directly below); the proof is a re-run of the measure harness once the sweep has authored a meaningful batch under the new rail — expect the existing 61 to stay put (nothing rewrites a stored script) and the MARGINS to diversify, which is what the notes' "flat, not shrinking" trajectory looked like.

### 2026-07-14 · The full-corpus audit — every generated family measured at once

The first systematic sweep across every family (operator request; two harnesses — the repo's `measure-artifact-diversity.ts` for comparability with earlier entries, plus purpose-built opener/closer/verbatim/texture cuts). Corpus-size reality first: notes/observations/context-notes are 61 each, the **video ledger is 61 vehicles / 26 grain+register stamps** (completed the same morning via the eyeball backfill), the **logbook is only 5 entries and the newsletter 1 sent edition** — those two are already rhyming but too thin for a trend.

- **Observations — HOMOGENISED, the confirmed priority (no rail).** Echoing 59/61, mean pairwise 0.0816 (the highest of the big corpora). The closer is a formula: **"…enjoy cosmonauts" verbatim as the last words of 32/61**, "enjoy" in the final sentence 41/61, "hope" somewhere in 51/61. The opener is a register: 34/61 start on "I…" or "This one…", 14/61 with an arrival verb. Cross-script verbatims persist, including the ledger's flagged "my shoulders went before i'd clocked the coordinate" (still in both 024.7.3Y and 026.2.1M, the 54.8% worst pair). Trend vs the 07-12 entry (corpus 60→61): hope 50→51, cosmonaut 38→38, shoulders 22→23 — **held flat, neither regressing nor improving, because nothing ships against it yet**.
- **Notes — DRIFTING, and the rail is holding.** Echoing 22/61, mean pairwise 0.0299 (a third of the observations'). Only `liquid` (19/61) clears the >25% bar; shoulders **15/61, exactly flat since the 07-11 entry**. Verbatims survive in the tail ("i've been rewinding" ×3). The vibe-neighbour layer + echo gate is the one shipped counter-measure, and the numbers show it working — flat, not shrinking, is what a rail on a growing corpus looks like. Provenance gap: `note_prompt_version` is NULL on 60/61, so auto-vs-operator can't be segmented; the stamp isn't being written.
- **Videos — the REGISTER axis has collapsed; the texture vocabulary has not.** From the completed ledger: grain families are healthy (7 families over 26 stamps, none above 23%) and vehicle names are the most diverse corpus Fluncle generates (60 names, max token reuse "swarm"/"hull" ×3). But **register is 24/26 representational (92%)** — only two abstract renders exist. And the operator's 07-13 thumbnail-strip attractor (four amber-halftone lookalikes) is invisible to every stored column: **palette is the unmeasured axis**, the first candidate metric when collection graduates to fixing.
- **Logbook — homogenised on structure, WATCH (n=5).** 4 of 5 entries end on "Enjoy, cosmonauts." (the observation closer, inherited); all 5 open on the same terse day-tally move; `cosmonauts`/`sector`/`find` in 5/5. Some overlap is by-design (an entry retells its day's findings) — the shared closer is the real tell. Will inherit whatever the observation fix ships.
- **Context notes — homogenised largely by design, with one actionable finding: the UPSTREAM SEED.** The `Texture:` slot (59/61) runs on a narrow recycled descriptor palette — `rolling` 34, `breakbeats` 27, `liquid` 25, `introspective` 25, `atmospheric` 19 — and that vocabulary flows straight downstream into the notes (`liquid` 19/61) and observations. **No written-family rail reaches back to this source.** Fixing diversity downstream while the fuel is monochrome is treating the symptom.
- **Newsletter — n=1, already rhyming.** The one sent edition's six why-lines land the body-clock move three times ("knees went up before I'd clocked the drop" / "Shoulders back on first listen" / "shoulders dropped and stayed down"), with the intro reinforcing it. Re-measure at ≥4 editions.

**What this audit adds to the fix map:** (1) observations are confirmed as the first target and now have opener/closer numbers to design against; (2) the context-note Texture palette is a newly-identified upstream cause; (3) videos need a palette metric, not a texture one; (4) the register collapse (92% representational) is a second video axis nobody had noticed; (5) `note_prompt_version` should actually be stamped so the corpus can be segmented.

### 2026-07-13 · Videos — 4 of 5 consecutive renders share palette AND texture (operator-observed)

Five consecutive YouTube Shorts, in publish order: Whole Place Lift, Dribble - VIP, Days Like These, Nine Clouds, Revolution. **Four of the five share (almost) the same amber/sepia palette and the exact same halftone/scanline texture; Nine Clouds is the only deviation** (cooler palette, volumetric cloud material, no halftone). Whatever the per-render briefs asked for, the generator converged on one look — the attractor is visible at a glance on the channel page, which is exactly where a viewer sees the videos side by side.

![Five consecutive YouTube thumbnails, four sharing one amber halftone look](./assets/homogenisation-2026-07-13-youtube-thumbnails.png)

Existing counter-measure that did NOT prevent this: the video work's diversity law ("assign each agent a distinct structural family at launch") governs parallel batch renders — these are sequential per-finding renders through the same prompt, so the law never applied. No texture/palette-distance metric exists for videos yet.

### 2026-07-12 · Observations — three stock moves across most of the corpus (measured)

Measured over the 60 live observation scripts (the taste-pack run, `apps/web/scripts/measure-artifact-diversity.ts`): **"hope" in 50/60, "cosmonaut" in 38/60, "shoulders" in 22/60**. Worst pair (Monrroe / Muffler) shares **56%** of content words, including the line "my shoulders went before I'd clocked the coordinate" **verbatim in both**. Three candidate fix directions captured in the taste pack (port the notes' neighbourhood rail / assigned angle families / one-owned-detail rule) — awaiting the operator's pick.

### 2026-07-11 · Notes — the finding that named the property (measured)

The word **"shoulders" in 15/61** live notes; "I've been rewinding it since" lifted verbatim between two findings; the un-layered auto-note reproduced a standing GLXY note almost word for word. Counter-measure ALREADY SHIPPED: the vibe-neighbour layer + echo gate (the model is handed the neighbourhood's moves as spent), which measurably reduced within-region overlap **0.041 → 0.015** (`scoreNoteEcho` + the `--dry-run` harness keep the claim falsifiable). The notes are the one family with a working metric AND a working counter-measure — the template for the rest.

### 2026-07 (standing) · Videos — the attractor law from the overhaul runs

Learned during the video-overhaul and batch-render runs, written down before this ledger existed: **parallel generation converges on a shared attractor, so diversity has to be DESIGNED IN, not hoped for** — assign each agent a distinct structural family at launch; prescriptive mid-flight coaching increases convergence rather than fixing it. The 2026-07-13 entry above shows the sequential form of the same property.

## What the ledger still wants

- **A metric per family.** Notes have `scoreNoteEcho`; observations have the taste-pack word counts; videos, covers, and sprites have nothing — a palette-histogram + texture-family tag per render would have caught the 07-13 strip automatically. "An anti-sameness effort with no metric is folklore" (ROADMAP).
- **Entries from families not yet observed** (covers, sprites, logbook entries, clip captions) — absence of evidence there is so far just absence of looking.
