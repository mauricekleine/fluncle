# Traps — read before you prune

Every one of these was a real false-positive caught by a dry-run during the pass that created this skill. They are the reason this is an operator-driven, eyeball-every-list procedure and not an automatic pruner.

## The model

- **Storage is enabled-label-only.** A catalogue track should exist only if its release label is an operator-`enabled` seed label (`labels.seed_state`). The crawler's write-gate enforces this going forward (`apps/web/src/lib/server/crawl.ts`, which reads `labels.seed_state = 'enabled'` at the storage gate); this skill cleans what predates it. Canon: `docs/catalogue-crawler.md`, `docs/label-entity.md`.
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

## The namesake class (a right ruling on a wrong identity)

Every trap above is about mis-JUDGING a label. This one is about mis-IDENTIFYING it, and it inverts the usual fix: the operator's ruling is correct and the crawl is still wrong.

- **A seed label is resolved by NAME, once.** It enters the frontier as `fluncle:label:<slug>` — a resolver node whose whole job is turning the operator's label name into a MusicBrainz label MBID, which then becomes `musicbrainz:label:<mbid>`, the node that browses releases. That name→MBID hop is the single point of failure, and it is invisible afterwards: downstream, an impostor's subtree is indistinguishable from an approved one, because `label_slug` says it descends from the enabled seed. It does.
- **Label names are not unique in MusicBrainz, and the resolver picked the top score.** Radar Records is a Belgian DnB label AND a 1978 UK punk label. The DnB one was ruled `enabled`; the punk one got walked — 303 tracks, on an ENABLED seed, across six seeds affected the same way. Nothing about the resulting rows looks wrong to any check in this skill.
- **A LABEL-LEVEL ruling cannot fix it, and trying makes things worse.** `disabled` is the only lever `purge.ts` responds to, and disabling Radar Records would be false twice over: it stops the crawl the operator actually wants, and it still cannot separate the two rosters — at the label level they are one row. `undecided` parks the problem without removing a single wrong track. There is no ruling that expresses "this label, but only the releases that are really its own".
- **So the fix is split in three, and the ORDER is load-bearing.** A code seal (the resolver keys on `labels.mb_label_id`, not a name score) must be DEPLOYED first, then the frontier repaired (`reseed-label.ts`), then the impostor's artists purged by name (`purge-artists.ts`). Out of order it is a regression, not a fix: repair the frontier against an unfixed resolver and the next tick re-walks the impostor; purge the tracks before the frontier is repaired and the next tick re-writes them. Recipe: SKILL.md § Namesake repair.
- **`mb_label_id` is the only authority — a missing one is a hard stop, not a guess.** Without it there is no way to tell which MusicBrainz label the ruling refers to, so `reseed-label.ts` refuses rather than picking. Resolve the label's MusicBrainz identity first.
- **Retire the impostor's frontier nodes; never delete them.** A `note` stamp leaves the walk history readable — how the wrong subtree was reached, and how far it got. The row is inert once the re-arm join is keyed on identity, so deleting it buys nothing and costs the audit trail.
- **The namesake purge deletes tracks on an ENABLED label. That is correct here and nowhere else.** It is the one place in this skill where `[enabled seed]` in a dry-run's label breakdown is expected rather than a stop sign — which is exactly why `purge-artists.ts` prints each label's seed state, and why the artist list is typed by a human instead of derived. Do not generalise this permission to any other step.
- **Separate the two rosters by NAME and ERA, by eye.** A 1978 punk act and a 2004 DnB act are not a close call once you actually look at the pages — but no automatic signal makes the call, and the roster-overlap trap above applies here too. Keep the list in a file with `#` comments explaining each entry; a destructive act should carry its reasoning.

## Operational

- **`op` re-locks on a short timer.** The 1Password desktop app must be unlocked for `op read` to work; it re-locks between long steps. If a script fails with `authorization timeout`, unlock 1Password (and consider extending its auto-lock), then retry.
- **Prod writes need permission.** The prod-write scripts (`rule-labels --confirm`, `purge --confirm`) are blocked by the auto-mode classifier unless the operator has allowlisted them (e.g. a `Bash(bun run …)` rule) or runs them in a permissive mode.
- **`bun run scripts/X && Y` compound commands don't match a `bun run scripts/:*` allow rule** and get blocked — run each prod-write bare.
- **Never trust the local DB for this.** Everything here is prod-only (`op` / exported creds). The local dev DB is a seeded subset.
