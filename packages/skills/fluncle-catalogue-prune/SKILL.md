---
name: fluncle-catalogue-prune
description: >-
  Run a sporadic off-genre pruning pass on Fluncle's drum & bass catalogue — find and remove
  non-DnB artists, tracks, and albums (reggae, pop, jazz, classical, metal, Brazilian, house/EDM…)
  that leaked in via the catalogue crawler and got public /artist and /album pages. USE THIS
  whenever the task touches off-genre/off-brand catalogue entities: an artist page that shouldn't
  exist (Bob Marley, Adele, Miles Davis on a DnB site), "why is this non-DnB artist/album live",
  catalogue hygiene/cleanup, pruning the catalogue, disabling an off-genre seed label and removing
  its tracks, purging entities on non-approved labels, or the "original-of-remix" problem (a DnB
  remix billed to a pop/reggae original). Operator-driven and DESTRUCTIVE on production, so it is
  dry-run-first with backups and rollbacks. Trigger even without the word "prune" — "clean up the
  catalogue", "get rid of the reggae/pop pages", "audit off-genre" all count.
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

## Rollback

Every write leaves a JSON in `$PRUNE_OUT_DIR`: `label-rulings-rollback.json`, `purge-rollback.json`, `purge-artists-rollback.json`, `reseed-label-<slug>-rollback.json`, `orphan-edges-rollback.json`. To undo, re-insert the captured rows (they are full `select *` snapshots) or restore the pre-purge `.sql` backup. The label rollback restores prior `seed_state`; the reseed rollback restores each frontier node's prior `state` / `cursor` / `note`.

## Files

- `scripts/scan.ts` — read-only: buckets, off-boundary labels, residual.
- `scripts/rule-labels.ts` — enable/disable labels by name (dry-run/`--confirm`, rollback).
- `scripts/purge.ts` — LABEL-driven purge (safe-purge artists) with entanglement guard + rollback.
- `scripts/purge-artists.ts` — TARGETED purge of an operator-named artist list, for the namesake case (dry-run/`--confirm`, rollback). Same cascade as `purge.ts`; hard-aborts on an unresolved slug, a findings track, or entanglement.
- `scripts/reseed-label.ts` — frontier repair for a wrong-namesake seed: re-arm the resolver node, retire the impostor MusicBrainz nodes without deleting them (dry-run/`--confirm`, rollback).
- `scripts/clean-orphan-edges.ts` — one-off: `track_artists` rows whose track is gone (dry-run/`--apply`, rollback).
- `scripts/lib.ts` — shared creds + catalogue loader + the safe-purge definition + the named-artist resolution + the shared-credit survival rule + the one artist cascade (guard, rollback, FK-safe delete) both purges use + the atomic track/edge delete.
- `scripts/orphan-edges.test.ts` — the delete pair's order/atomicity and the orphan predicate, against a stubbed client.
- `scripts/purge-artists.test.ts` — the shared-credit survival rule, the findings/unknown-slug/entanglement hard aborts, the zero-write dry-run, and the cascade's delete order.
- `scripts/reseed-label.test.ts` — the namesake classification against `mb_label_id`, the three refusals, the zero-write dry-run, and that a namesake node is noted rather than deleted.
- `references/traps.md` — **read first**: the false-positives every naive rule hits.

All three test files run under `bun test --cwd packages/skills/fluncle-catalogue-prune/scripts`, wired into the root `test:scripts` (so the deploy gate covers them). They drive a stubbed libSQL client and the shared no-network rail is armed — nothing here reaches prod.
