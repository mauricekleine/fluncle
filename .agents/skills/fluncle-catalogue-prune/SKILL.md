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

The purge is **artist-driven**: it deletes only safe-purge artists (no finding, no enabled-label track), the tracks credited _only_ to them, orphan albums, and the cascade (edges, socials, aliases, centroids/similar, cost_events). It writes a full per-row rollback first. The **entanglement guard** aborts if any deletable track is in a mixtape, a user save, a published post, or a frontier edition — that's a surprise for a human, never a silent delete.

**Read the dry-run's artist/track/album counts and sample before confirming.** If a count is far larger than expected, a label ruling was wrong — go back to step 2.

### 5 — Verify

```bash
# a purged slug should 404; a kept DnB act should 200. Bust the edge cache with a query param.
for s in miles-davis bob-marley-the-wailers loxy degs; do
  printf '%s → ' "$s"; curl -s -o /dev/null -w '%{http_code}\n' -H 'Accept: text/html' "https://www.fluncle.com/artist/$s?cb=$RANDOM"; done
```

### 6 — The original-of-remix residual (human judgement, optional)

The scan's last section lists non-DnB artists kept alive by a _token_ DnB remix (MusicBrainz bills a remix to the original artist). These are a small, slow-growing tail — handle sporadically, by hand. For each, decide: strip the off-genre back-catalogue but **keep the DnB remix track** (often on a multi-genre disabled label like fabric/StreetBeat — do NOT blanket-delete by label). Or leave it: a page showing only "Song (DnB Producer remix)" is on-brand and useful long-tail SEO. There is no `--confirm` for this step on purpose; it is per-track judgement. See `references/traps.md` § "original-of-remix".

## Rollback

Every write leaves a JSON in `$PRUNE_OUT_DIR`: `label-rulings-rollback.json`, `purge-rollback.json`. To undo, re-insert the captured rows (they are full `select *` snapshots) or restore the pre-purge `.sql` backup. The label rollback restores prior `seed_state`.

## Files

- `scripts/scan.ts` — read-only: buckets, off-boundary labels, residual.
- `scripts/rule-labels.ts` — enable/disable labels by name (dry-run/`--confirm`, rollback).
- `scripts/purge.ts` — artist-driven purge with entanglement guard + rollback.
- `scripts/lib.ts` — shared creds + catalogue loader + the safe-purge definition.
- `references/traps.md` — **read first**: the false-positives every naive rule hits.
