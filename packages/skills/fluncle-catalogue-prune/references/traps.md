# Traps — read before you prune

Every one of these was a real false-positive caught by a dry-run during the pass that created this skill. They are the reason this is an operator-driven, eyeball-every-list procedure and not an automatic pruner.

## The model

- **Storage is enabled-label-only.** A catalogue track should exist only if its release label is an operator-`enabled` seed label (`labels.seed_state`). The crawler's write-gate enforces this going forward (`apps/web/src/lib/server/crawl.ts`, `isEnabledLabel`); this skill cleans what predates it. Canon: `docs/catalogue-crawler.md`, `docs/label-entity.md`.
- **A catalogue track = a `tracks` row with no `findings` row.** A findings-bearing artist/track is Maurice's actual logged work — never prune it. The scripts exclude anything with a finding by construction.

## Signal traps (why there is no auto-classifier)

1. **Roster overlap is a broken signal for label genre.** "What fraction of this label's artists also appear on enabled DnB labels" looks clever but is contaminated: DnB acts guest/remix onto majors, EDM, trap and club comps, so EMI, Mercury, Monstercat, fabric all show 80–100% overlap. Classify labels by **NAME recognition**, not overlap.
2. **`disabled label` ≠ `off-genre track`.** Many disabled labels are multi-genre and released real DnB: fabric/FabricLive, DJ Magazine covermounts, FFRR, StreetBeat, New State, avex trax. Blanket-stripping disabled-label tracks would delete DnB by DJ Marky, S.P.Y, Total Science, Dillinja — and classics like DJ Marky's "LK" (Jorge Ben Jor) and "Carolina Carol Bela" (Toquinho). Only ever strip disabled-label tracks after eyeballing the specific tracks.
3. **Compilation-title heuristics are imprecise both ways.** `/presents|years of|sampler|.../ ` flags legit DnB comps (Viper's _Future Fire_, Spearhead) AND misses real ones ("Fifteen Years of Hospital Records"). Do not gate anything important on album title.
4. **`source='operator'` on `artist_socials` is unreliable.** Agents have written `operator` by mistake. It is NOT proof a human curated the artist — don't use it as a keep-signal.
5. **Do NOT require a certified finding to keep a page.** Fluncle's design is "an entity earns a page on its content"; a findings-free catalogue-only DnB page is legitimate. A findings gate would nuke real DnB. Keep = finding **OR** an enabled-label track.

## The original-of-remix friction (the irreducible residual)

- **MusicBrainz bills a remix to the ORIGINAL artist, not the remixer.** So a DnB remix of a pop/reggae/bossa song mints a page for the non-DnB original: Adele (Nu:Tone/High Contrast on Hospital), Bob Marley, Toquinho (DJ Marky), Jorge Ben Jor ("LK"), Tinie Tempah (Noisia). The remixer is usually only in the **title** ("… (Nu:Tone remix)"), not in a structured MB relationship.
- **A remix is not always a _DnB_ remix.** Pop songs also collect house/EDM/UKG remixes (Emeli Sandé "(MJ Cole Remix)", "(Denney Remix)"). So "is a remix" flags the class but the **label** is what says it's DnB.
- **The right disposition:** these are a small, slow-growing residual (the write-gate throttles inflow). Handle them by hand — strip the artist's off-genre originals, **keep** the DnB remix track. The structurally-correct long-term fix (re-crediting the remix to the remixer parsed from the title) is deliberately NOT automated here; the risk of over-pruning outweighs it at this surface size.
- **The separator that works:** a real DnB act has hundreds of enabled tracks; an original-of-remix artist has 1–3 enabled tracks and a big off-genre back-catalogue. `scan.ts` uses `enabled ≤ 3 AND off > enabled` to surface them — then a human reads the list.

## Operational

- **`op` re-locks on a short timer.** The 1Password desktop app must be unlocked for `op read` to work; it re-locks between long steps. If a script fails with `authorization timeout`, unlock 1Password (and consider extending its auto-lock), then retry.
- **Prod writes need permission.** The prod-write scripts (`rule-labels --confirm`, `purge --confirm`) are blocked by the auto-mode classifier unless the operator has allowlisted them (e.g. a `Bash(bun run …)` rule) or runs them in a permissive mode.
- **`bun run scripts/X && Y` compound commands don't match a `bun run scripts/:*` allow rule** and get blocked — run each prod-write bare.
- **Never trust the local DB for this.** Everything here is prod-only (`op` / exported creds). The local dev DB is a seeded subset.
