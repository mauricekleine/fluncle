---
name: fluncle-catalogue-prune
description: >-
  Run an off-genre pruning pass on Fluncle's drum & bass catalogue — find and remove
  non-DnB artists, tracks, and albums (reggae, pop, jazz, house/EDM…) that leaked in via
  the catalogue crawler and got public /artist and /album pages. USE THIS whenever the task touches
  off-genre catalogue entities: an artist page that shouldn't exist (Bob Marley, Adele on a DnB
  site), "why is this non-DnB artist/album live", catalogue hygiene/cleanup, disabling an off-genre
  seed label and removing its tracks, or the "original-of-remix" problem (a DnB remix billed to a
  pop original). ALSO the artist-identity repairs the same crawl leaves behind: one row holding TWO
  real acts, TWO duplicate rows holding ONE act ("merge these duplicate artist pages", "two pages
  for the same artist"), a row wearing the WRONG MusicBrainz mbid, and RESTORING tracks a purge
  should not have deleted ("undo that purge"). Operator-driven and DESTRUCTIVE on production, so
  dry-run-first with backups and rollbacks. Triggers without the word "prune" too.
---

# Fluncle catalogue off-genre pruning pass

Fluncle is a **drum & bass** archive. Its catalogue crawler walks the MusicBrainz graph out from operator-approved seed labels, and historically over-reached: it pulled a hop-1 artist's _entire_ discography regardless of label, so off-genre entities (Bob Marley's reggae, Adele's pop, Miles Davis's jazz) leaked in and earned public pages. The crawler's write-gate now seals new entry (`docs/catalogue-crawler.md`); this skill is the periodic pass that **cleans what already leaked**, safely.

It is destructive on production, and every automatic classifier we tried over-prunes. So this is a **human-in-the-loop procedure**: the scripts _surface_ candidates and do the mechanical deletes; **you make every genre call**. Read `references/traps.md` before your first run — it is the list of specific false-positives (DJ Marky, S.P.Y, a DJ Marky classic) that a naive rule would have deleted.

## Ground rules (non-negotiable)

- **Prod only.** The local DB is a seeded subset and lies about scale. All scripts hit prod via `op` or exported Turso creds.
- **Dry-run → eyeball → backup → confirm.** Never run a `--confirm` before reading its dry-run and taking a fresh backup.
- **Keep = a finding OR an enabled-label track.** Anything with a `findings` row is Maurice's real work — untouchable. Do NOT add a "must have a certified finding" gate; findings-free catalogue-only DnB pages are legitimate.
- **Classify labels by NAME, not by data heuristics.** Roster-overlap, comp-titles, and "disabled label" are all broken signals (see traps). When you can't identify a label, leave it `undecided`.

## Setup

Run everything from the **repo root** (`@libsql/client` is hoisted to the root `node_modules`, so the scripts resolve it from there). Provide creds — prefer `op`:

```bash
export FLUNCLE_TURSO_OP_ITEM='op://<vault>/<turso-prod-item>'          # operator knows the concrete item
export PRUNE_OUT_DIR="$PWD/apps/web/.dev/catalogue-prune"              # rollbacks/reports land here (gitignored)
mkdir -p "$PRUNE_OUT_DIR"
```

`op` must be unlocked (biometric) and re-locks on a timer — if a script fails with `authorization timeout`, unlock 1Password and retry. Prod-write steps may need the operator to allowlist `bun run` in permissions.

Script paths below are repo-root-relative: `packages/skills/fluncle-catalogue-prune/scripts/`.

## The pass

### 1 — Scan (read-only)

```bash
bun run packages/skills/fluncle-catalogue-prune/scripts/scan.ts
```

Prints three things: the artist **buckets** (keep vs safe-purge), the **off-boundary labels** still `undecided` behind off-genre artists (with sample artists, so you classify by name), and the **original-of-remix residual**. Nothing is written. Run this first, and again after each ruling to see the effect.

### 2 — Rule the labels

The safe-purge artists trace to non-enabled labels. **Rule those labels first** so the purge is clean — this is Fluncle's existing model (the crawler proposes, the operator rules; `docs/label-entity.md`). Go down the scan's undecided-label list and split by name:

- **Clearly DnB** (you recognise it as a DnB label) → `--enable`. This _rescues_ its artists into the keep bucket.
- **Clearly not DnB** (major, EDM, house, metal, jazz, world, pop) → `--disable`. This makes its off-genre-only artists purge-eligible.
- **Can't identify** → leave it. It stays `undecided` in the `/admin/labels` review queue.

```bash
# dry-run first, then --confirm
bun run packages/skills/fluncle-catalogue-prune/scripts/rule-labels.ts \
  --enable "Kos.Mos.Music|Syncopix Records" \
  --disable "Paradoxx Music|Carbon Music|Helix Records"
bun run packages/skills/fluncle-catalogue-prune/scripts/rule-labels.ts --disable "Paradoxx Music|Carbon Music|Helix Records" --confirm
```

Re-run the scan and watch the safe-purge count move. Note: a big jump after disabling one label just means it was a large multi-genre reissue label — sample its artists (scan output) to confirm they're off-genre before trusting it.

### 3 — Backup

```bash
bun run --cwd apps/web db:pull-prod   # reads FLUNCLE_TURSO_OP_ITEM; writes apps/web/.dev/seed.sql
mkdir -p apps/web/.dev/backups
cp apps/web/.dev/seed.sql "apps/web/.dev/backups/prod-seed-$(date +%Y%m%d-%H%M%S)-pre-purge.sql"
```

### 4 — Purge (dry-run, then confirm)

```bash
bun run packages/skills/fluncle-catalogue-prune/scripts/purge.ts            # dry-run + entanglement guard
bun run packages/skills/fluncle-catalogue-prune/scripts/purge.ts --confirm  # writes rollback then deletes
```

The purge is **artist-driven**: it deletes only safe-purge artists (no finding, no enabled-label track, AND ≥1 track on a label you've explicitly **disabled** — so an artist with only undecided/no-label tracks is never swept in on a metadata gap), the tracks credited _only_ to them, orphan albums, and the cascade (edges, socials, aliases, centroids/similar, cost_events). It writes a full per-row rollback first. The **entanglement guard** aborts if any deletable track is in a mixtape, a user save, a published post, or a frontier edition — that's a surprise for a human, never a silent delete.

**Edges die with their tracks.** The track delete and the `track_artists` delete for the same ids ride one transaction, so a deleted track can never strand an edge behind it. `track_artists` is the only table referencing `tracks.track_id` that is neither guarded nor swept by the artist cascade — everything else is either protected (`findings`, and the nine guard tables) or cascaded (`cost_events`).

**The dry-run NAMES every artist it would delete, with their labels — eyeball that list; every one should be recognisably off-genre.** If a count is far larger than expected, a label ruling was wrong — go back to step 2.

**After a purge, the hub counts lag.** The maintained `renderable_track_count` / `certified_finding_count` on artists/labels/albums are delta-maintained by the server's write paths, and this purge writes straight to prod out of band — so they overstate the truth until the nightly `reconcile_hub_counts` sweep recomputes them (within a day; it names this skill as one of its three drift sources). To correct them immediately instead of waiting, fire that sweep's trigger by hand: `POST /api/v1/admin/hub-counts/reconcile` with an admin token.

### 5 — Verify

```bash
# a purged slug should 404; a kept DnB act should 200. Bust the edge cache with a query param.
for s in miles-davis bob-marley-the-wailers loxy degs; do
  printf '%s → ' "$s"; curl -s -o /dev/null -w '%{http_code}\n' -H 'Accept: text/html' "https://www.fluncle.com/artist/$s?cb=$RANDOM"; done
```

### 6 — The original-of-remix residual (human judgement, optional)

The scan's last section lists non-DnB artists kept alive by a _token_ DnB remix (MusicBrainz bills a remix to the original artist). These are a small, slow-growing tail — handle sporadically, by hand. For each, decide: strip the off-genre back-catalogue but **keep the DnB remix track** (often on a multi-genre disabled label like fabric/StreetBeat — do NOT blanket-delete by label). Or leave it: a page showing only "Song (DnB Producer remix)" is on-brand and useful long-tail SEO. There is no `--confirm` for this step on purpose; it is per-track judgement. See `references/traps.md` § "original-of-remix".

### 7 — Orphaned edges (one-off, from the deletes that came before this rail)

An **orphaned edge** is a `track_artists` row pointing at a track that no longer exists. Purges done before the transactional pair above left 62 of them across 36 artists (measured 2026-07-26). They render as nothing and count as nothing, but they lie to anything that reads `track_artists` raw. Sweep them up once:

```bash
bun run packages/skills/fluncle-catalogue-prune/scripts/clean-orphan-edges.ts            # dry-run: count + per-artist breakdown
bun run packages/skills/fluncle-catalogue-prune/scripts/clean-orphan-edges.ts --apply    # rollback JSON, delete, re-count
```

Safe to re-run — once clean it finds nothing. `--apply` prints before/after counts and warns if any survive (which would mean something is still writing them).

## Namesake repair (wrong MusicBrainz label walked under an enabled seed)

**A different failure from everything above.** The pass so far assumes a wrong LABEL RULING: the operator's call on a label was too generous, so disabling it makes its artists purge-eligible. The namesake case is the opposite — **the ruling is right and the identity is wrong.** A seed label enters the frontier as `fluncle:label:<slug>`, a resolver node whose only job is to turn the operator's label NAME into a MusicBrainz label MBID. When two labels share a name, that resolution can pick the other one, and the crawler then walks a label nobody approved as though it were the approved seed.

The case that created this section: **Radar Records** — a Belgian DnB label the operator correctly ruled `enabled`, whose slug resolved to a 1978 UK punk label of the same name. 303 tracks came in under an ENABLED seed, across six seeds affected the same way.

**Why nothing above can fix it.** `purge.ts` needs a `disabled` label behind an artist before it will touch them, and disabling Radar Records would be a lie — the DnB label is genuinely a seed, and disabling it stops the crawl the operator wants. There is no label-level signal that separates the two labels, because at the label level they are the same row. Only a human naming the wrong artists resolves it. See `references/traps.md` § "the namesake class".

### The ordered recipe

**Order matters more here than anywhere else in this skill.** Repairing the frontier before the resolver fix is deployed just walks the impostor again on the next tick; purging the tracks before the frontier is repaired means the next tick re-writes them.

**0 — The code seal must be DEPLOYED first.** The resolver has to key on `labels.mb_label_id` rather than a top-scoring name match, so a re-armed seed resolves to the identity the operator's ruling refers to. Confirm the fix is live on prod before touching anything — `apps/web/src/lib/server/crawl.ts`, and `docs/catalogue-crawler.md` for the boundary gate it sits in. Everything below is a no-op-then-regression without it.

**1 — Repair the frontier.** One label at a time, dry-run first:

```bash
bun run packages/skills/fluncle-catalogue-prune/scripts/reseed-label.ts --slug radar-records
bun run packages/skills/fluncle-catalogue-prune/scripts/reseed-label.ts --slug radar-records --confirm
```

The dry-run verifies the `labels` row exists, is `enabled`, and carries `mb_label_id` — that column is the **authority**, and with it missing the script refuses, because nothing can then tell the impostor from the original. It then lists every frontier label node for the slug and flags each MusicBrainz node whose `external_id` ≠ `mb_label_id` as **WRONG NAMESAKE**. `--confirm` resets the resolver node to `state='pending', cursor=0` (the next tick re-mints the correct MB node) and stamps each namesake node's `note` with `wrong namesake; retired <date>`. **The namesake rows are kept, never deleted** — the tightened re-arm join leaves them inert, and they are the record of what was walked.

**2 — Identify the impostor's artists.** Human work, and the part no script does for you. Read `/artist/<slug>` pages under the affected label and separate the two rosters by name and by era. A punk act from 1978 and a DnB act from 2004 are not a close call once you look; do look. Keep the list in a file, one slug per line, with your reasoning in `#` comments — that file is the audit trail for a destructive act.

**3 — Purge, dry-run first.**

```bash
bun run packages/skills/fluncle-catalogue-prune/scripts/purge-artists.ts --artists-file "$PRUNE_OUT_DIR/radar-namesake.txt"
```

**4 — Eyeball three lists.** The dry-run prints them because each one catches a different mistake:

- **the artists**, with their labels and track counts — every name must be recognisably the wrong act;
- **the labels the deleted tracks sit on**, each with its seed state — expect `[enabled seed]` here. That is the whole point of the tool and the one place in this skill where seeing `enabled` is correct rather than alarming. Anything you did not expect on this list means a named artist also released elsewhere, and the purge is wider than you think;
- **the tracks that SURVIVE**, with the co-credit keeping each one alive — a track shared with an artist you did not name is never deleted, so the impostor's row disappears while a collaboration stays. If a track you meant to remove is on this list, the co-artist belongs in the list too.

The run **hard-aborts** rather than skipping on: a slug with no `artists` row, a named artist carrying a `findings` track (Maurice's logged work — never a namesake), and any deletable track entangled in a mixtape, save, published post, or frontier edition. A refusal means your list is wrong; fix the list, don't work around it.

**5 — Backup, then confirm.** Same backup as § 3 above (`db:pull-prod` into a timestamped copy), then:

```bash
bun run packages/skills/fluncle-catalogue-prune/scripts/purge-artists.ts --artists-file "$PRUNE_OUT_DIR/radar-namesake.txt" --confirm
```

It writes `purge-artists-rollback.json` before deleting and runs the identical cascade `purge.ts` runs — the shared code in `lib.ts`, not a second implementation.

**6 — Verify both halves.** The purged pages should 404 and the real DnB act should still 200:

```bash
for s in <impostor-slug> <real-dnb-slug>; do
  printf '%s → ' "$s"; curl -s -o /dev/null -w '%{http_code}\n' -H 'Accept: text/html' "https://www.fluncle.com/artist/$s?cb=$RANDOM"; done
```

Then watch the next crawl tick: the seed should resolve to `mb_label_id` and mint a MusicBrainz node whose `external_id` matches. If a namesake node goes `pending` again, the resolver fix is not actually live — stop and go back to step 0. Hub counts lag as after any purge; the nightly `reconcile_hub_counts` sweep heals them within a day.

## Conflated entities (one artists row, two real acts)

**The case the namesake purge deliberately leaves behind.** `purge-artists.ts` deletes an artist WHOLE, so it spares any artist holding genuine enabled-label tracks — correctly, because deleting them would take a real drum & bass page with them. What survives that rule is the **conflated row**: ONE `artists` row carrying a real DnB act AND an unrelated same-named act whose tracks arrived on the impostor walk. The impostor's tracks still render on the real act's public page.

The case that created this section: **`K`** — the Audio Couture / Subtitles / Breakbeat Science drum & bass act, whose row also held 23 tracks by a Japanese pop act credited `K.` on the avex "Cutting Edge" impostor walk. Same shape on `Luna`, `Rose`, `The Kaleidoscope`, `Danger` and others.

**How a row ends up holding two acts — sealed in code, so this is cleanup, not an ongoing leak.** Three paths write `track_artists` edges and only one checked identity. Measured on prod 2026-07-27 across the six namesake labels: of 225 impostor-side edges, **181** came from the crawl-time link (`linkTracksToArtistEntities`, which joined on `artists.name` alone while holding the credit's MusicBrainz artist id), **29** from slice 0's fold (`fold("K.") === fold("K")` — punctuation collapses), and **15** from the mbid-keyed credit sweep, which refuses homonyms by construction and so wrote only genuine crossovers. Both name-only paths now apply the credit sweep's ladder — mbid match wins, a name may only claim an UNCLAIMED row, and a row carrying a different mbid gets no edge (`apps/web/src/lib/server/artists.ts` § THE HOMONYM SEAL).

### 1 — Detect (read-only)

```bash
bun run packages/skills/fluncle-catalogue-prune/scripts/find-conflated-artists.ts
bun run …/find-conflated-artists.ts --no-musicbrainz            # local signals only, no vendor calls
bun run …/find-conflated-artists.ts --labels "radar-records" --samples 3
```

It derives the impostor-walk labels from the **frontier** (the `wrong namesake; retired …` notes `reseed-label.ts` leaves behind), takes every artist holding tracks on BOTH an impostor label and another enabled label, and prints one evidence block each: per-side track counts, labels, titles, the raw credit spellings (`K` vs `K.`), which code path wrote each side's edges, and — sampling each side's recordings through MusicBrainz at 1 req/1.2s — **which MB artist those recordings are actually credited to**.

That last line is the ruling. Disjoint MB artist ids on the two sides ⇒ `CONFLATION (proven)`; a shared id ⇒ `crossover (proven)`; anything unanswered stays `unsure` and is yours to research by hand. Evidence also lands in `$PRUNE_OUT_DIR/conflated-artists.json`.

**A crossover is not a conflation.** One act really did appear on both labels — a drum & bass remix billed to the original artist is the common shape. Those stay exactly as they are.

### 2 — Repair, dry-run first

```bash
# SPLIT — the other act keeps its tracks on a NEW artists row of its own (nothing is deleted)
bun run …/split-artist.ts --artist k --labels "cutting-edge" --into "K." --into-mbid <mb-artist-id>

# STRIP — the other act's catalogue has no business on a DnB archive; delete those tracks
bun run …/split-artist.ts --artist the-kaleidoscope --labels "cutting-edge" --strip
```

Prefer **SPLIT** when the other act is real and worth its own page, or whenever you would rather not destroy data to fix an identity mistake — it is an `update` of `track_artists.artist_id`, so `position` and `role` ride across and the move is reversible from the rollback. Use **STRIP** when the catalogue is simply off-genre; it goes through the same `deleteTracksWithEdges` transaction, entanglement guard and per-row rollback both purges use.

Pass `--into-mbid` whenever the detector named the impostor side's MusicBrainz artist — a row born with its real identity is one the seal can defend later.

**The rails, all hard aborts:** an unresolved slug; `--labels` that match none of the artist's tracks; an artist with **nothing** outside the impostor labels (that is a whole-artist namesake — use `purge-artists.ts`); a `findings` row on the impostor side; and, for `--strip`, any entangled track. A co-credited impostor-side track is **held back**, never moved or deleted, because re-pointing it would silently change what the co-artist's page shows.

Re-run with `--confirm` after a fresh backup (§ 3 above). The `artists` row itself is never deleted by this tool — that is the whole difference from `purge-artists.ts`. Hub counts lag as after any purge.

### Duplicate rows (two artists rows, ONE real act)

The exact inverse of a conflation, and the tail a repair pass leaves behind. The crawler mints an artist per MusicBrainz identity it walks, so an act MusicBrainz carries under two MBIDs — or one Fluncle met twice before an MBID was known — lands as `orion` and `orion-2`: two `/artist` pages, one discography split across them, and usually at least one row wearing an MBID that belongs to **neither** act.

```bash
# MERGE — fold the duplicate into the canonical
bun run …/merge-artist.ts --canonical orion --duplicate orion-2 --drop-duplicate-socials

# …and fix the survivor's identity in the same pass
bun run …/merge-artist.ts --canonical instinct --duplicate instinct-2 --set-mbid <mb-artist-id>

# REPOINT ONLY — no duplicate involved, just a wrong identity (--duplicate is optional)
bun run …/merge-artist.ts --canonical neon --set-mbid <mb-artist-id>
```

**No track is ever deleted** — a merge moves credit, so it is reversible from the rollback. It re-points every reference to the duplicate, reconciles identity **canonical-wins** (an EMPTY canonical slot is filled from the duplicate), records the duplicate's name + slug as a **confirmed operator alias** so the merged-away slug can never be re-minted, moves the maintained hub counts by measured delta, and deletes the duplicate row. It mirrors `mergeLabel` (`apps/web/src/lib/server/labels.ts`) statement for statement.

**Pick the survivor by SLUG, not by row richness.** The merge re-points _all_ edges either way, so the survivor holds the union regardless of direction — "the richer row" decides nothing. The un-salted slug is the better public URL and the one property a merge cannot fix afterwards; identity is one `--set-mbid` away.

**`--drop-duplicate-socials` when the two rows' MBIDs disagree.** MB-sourced channels belong to the MBID that sourced them, so a duplicate wearing a different MBID carries a _different act's_ links — moving them puts a stranger's SoundCloud in the survivor's public `sameAs`. The dry-run prints every social and warns when the MBIDs differ.

**The findings rule.** `findings` keys on `track_id`, not on an artist, so a merge can never orphan or destroy one — but it _can_ change which `/artist` page a certified finding hangs off. So: **ABORT** when the duplicate credits a finding-bearing track the canonical does not already credit (a finding MOVING pages needs a human ruling); **ALLOW** when the canonical already credits it (the finding inherits cleanly — the merge only collapses a double credit and the page is unchanged).

**The other rails, all hard aborts:** either slug unresolved; canonical and duplicate the same row.

`--set-mbid` that CHANGES the identity also clears `resolved_at`, putting the row back on the artist-resolution worklist so the resolver re-walks the new MBID and refreshes socials + KG anchors against it.

### Restore rows a purge deleted

```bash
bun run …/restore-from-rollback.ts --rollback "$PRUNE_OUT_DIR/edgeless-rollback.json" \
  --tracks mb_eb5c1f5d-…            # or a comma/space list, or @file, or `all`
```

The undo every destructive tool here has always promised. It re-inserts albums → artists → tracks → `track_artists`, each `insert or ignore`, so a row already live is never clobbered and a second run changes nothing. Use it for the narrow case that actually comes up: a purge was RIGHT about a label and WRONG about a handful of rows under it.

**A requested id the file does not hold is a hard abort** — that means the wrong rollback was named, and a silent partial restore is the worse outcome. Schema drift is handled: each insert uses the intersection of the snapshot's columns and the live table's (`pragma table_info`), so a column added since takes its default and a dropped one is reported rather than throwing.

Deliberately NOT restored: `cost_events` (a ledger of spend that already happened — re-inserting double-counts it), and the hub counts (they lag exactly as after a purge; `reconcile_hub_counts` recomputes from truth within a day).

## Rollback

Every write leaves a JSON in `$PRUNE_OUT_DIR`: `label-rulings-rollback.json`, `purge-rollback.json`, `purge-artists-rollback.json`, `reseed-label-<slug>-rollback.json`, `orphan-edges-rollback.json`, `split-artist-<slug>-rollback.json`, `merge-artist-<dup>-into-<canonical>-rollback.json`, `repoint-artist-<slug>-rollback.json`. They are full `select *` snapshots.

**For a track-level undo, use `restore-from-rollback.ts` (§ Restore rows a purge deleted, above)** rather than hand-writing inserts — it is idempotent, closes over each track's album + artists + edges, and guards schema drift. For anything else, re-insert the captured rows by hand or restore the pre-purge `.sql` backup. The label rollback restores prior `seed_state`; the reseed rollback restores each frontier node's prior `state` / `cursor` / `note`. A merge rollback captures BOTH artists rows and every referencing row for both, because the merge edits the canonical as well as deleting the duplicate.

## Files

- `scripts/scan.ts` — read-only: buckets, off-boundary labels, residual.
- `scripts/rule-labels.ts` — enable/disable labels by name (dry-run/`--confirm`, rollback).
- `scripts/purge.ts` — LABEL-driven purge (safe-purge artists) with entanglement guard + rollback.
- `scripts/purge-artists.ts` — TARGETED purge of an operator-named artist list, for the namesake case (dry-run/`--confirm`, rollback). Same cascade as `purge.ts`; hard-aborts on an unresolved slug, a findings track, or entanglement.
- `scripts/reseed-label.ts` — frontier repair for a wrong-namesake seed: re-arm the resolver node, retire the impostor MusicBrainz nodes without deleting them (dry-run/`--confirm`, rollback).
- `scripts/find-conflated-artists.ts` — READ-ONLY detector for one `artists` row holding two real acts: per-side evidence plus the MusicBrainz identity of each side's recordings.
- `scripts/split-artist.ts` — the conflation repair: SPLIT the other act onto a new row (re-point edges) or STRIP its tracks (dry-run/`--confirm`, rollback, shared cascade + guard).
- `scripts/merge-artist.ts` — the DUPLICATE-ROW merge (the conflation's inverse): fold two `artists` rows that are one act, re-pointing every reference, or repoint identity alone with `--set-mbid` and no `--duplicate` (dry-run/`--confirm`, rollback). Deletes no track. `ARTIST_REFERENCES` is the enumerated map of every table carrying an `artists.id`.
- `scripts/restore-from-rollback.ts` — the UNDO: re-insert rows a purge deleted, from its rollback JSON, closing over each track's album/artists/edges (dry-run/`--confirm`, idempotent, schema-drift guarded).
- `scripts/clean-orphan-edges.ts` — one-off: `track_artists` rows whose track is gone (dry-run/`--apply`, rollback).
- `scripts/lib.ts` — shared creds + catalogue loader + the safe-purge definition + the named-artist resolution + the shared-credit survival rule + the one artist cascade (guard, rollback, FK-safe delete) both purges use + the atomic track/edge delete.
- `scripts/orphan-edges.test.ts` — the delete pair's order/atomicity and the orphan predicate, against a stubbed client.
- `scripts/purge-artists.test.ts` — the shared-credit survival rule, the findings/unknown-slug/entanglement hard aborts, the zero-write dry-run, and the cascade's delete order.
- `scripts/reseed-label.test.ts` — the namesake classification against `mb_label_id`, the three refusals, the zero-write dry-run, and that a namesake node is noted rather than deleted.
- `scripts/find-conflated-artists.test.ts` — the candidate gate, the edge-writer attribution, the MB verdict (and its refusal to guess), and that the whole run only reads.
- `scripts/split-artist.test.ts` — the shared-credit hold-back, the findings / not-actually-conflated / entanglement aborts, both zero-write dry-runs, and the two apply shapes.
- `scripts/merge-artist.test.ts` — the findings rule (blocker vs inherited), the same-row aborts, the zero-write dry-run, the repoint-only shape, and **the re-point completeness proof**: an independent transcription of every `artists.id` reference that fails the moment `ARTIST_REFERENCES` stops spanning it or a table stops being swept.
- `scripts/restore-from-rollback.test.ts` — the wrong-file abort, idempotence (`insert or ignore`), the parents-before-children order, the schema-drift guard, the zero-write dry-run, and that a restore only ever inserts.
- `references/traps.md` — **read first**: the false-positives every naive rule hits.

All test files run under `bun test --cwd packages/skills/fluncle-catalogue-prune/scripts`, wired into the root `test:scripts` (so the deploy gate covers them). They drive a stubbed libSQL client and the shared no-network rail is armed — nothing here reaches prod.
