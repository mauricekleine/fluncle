---
name: fluncle-key-backfill
description: >-
  MANUAL, approval-gated repair tool for filling a Fluncle finding's missing
  musical `key` from your Rekordbox library. Fluncle's DSP stores `key` as scale
  text ("A minor"/"F major") but leaves it NULL when key-confidence is below its
  floor, so part of the archive has no key. Rekordbox holds a confident full-song
  key (DjmdContent.Key.ScaleName, e.g. "Am"/"F"/"Bbm"); this skill reads those,
  matches each to a finding by normalized title+artist, and — after a human eyeballs
  the dry-run proposals — writes the normalized key back via `fluncle admin tracks
  update --key`. Use ONLY when the user explicitly asks to backfill, fill, or repair
  missing musical keys, mentions Rekordbox keys, or invokes it by name. NOT part of
  automated enrichment and never runs on its own: it writes to the production
  database, so it needs an explicit human trigger and a dry-run review before any
  write. The operator runs the live pass on their own Mac (where Rekordbox lives),
  like the mixtape tracklist script.
---

# Fluncle Key Backfill

A hands-on repair tool for the findings whose stored `key` is null. The enrichment
DSP only ever sees a 30-second preview and honestly writes `null` when its
key-detection confidence is below the floor (unlike BPM, key has no fallback). This
skill fills those gaps from the one place that already holds a confident, full-song
key: your Rekordbox library.

## When this runs (and when it must NOT)

This is an **exception / maintenance path**, not a pipeline step. Run it only when a
human explicitly asks — "backfill the missing keys from Rekordbox", "fill in the
keys we don't have", or by name.

Two hard rules, because it has real-world side effects:

1. **It mutates the production database** (via the authenticated admin API). The
   dry-run is the default; review the proposals before writing.
2. **The live pass runs on the operator's Mac** — Rekordbox and its encrypted
   `master.db` live there. Like `rekordbox-tracklist.py`, this is not a box/CI job.

## Requirements

- The **`fluncle` CLI** on PATH and, for the write step, authenticated
  (`FLUNCLE_API_TOKEN`). The list read is admin-tier; the write is `update_track`.
- **`uv`** (runs the bundled `scripts/key_backfill.py` with its inline deps).
- **Rekordbox** installed on this Mac, fully **quit** (it holds an exclusive lock),
  with the SQLCipher key cached once.

### One-time Rekordbox prerequisites

Identical to the mixtapes tracklist script:

1. **Quit Rekordbox fully** — it locks `master.db`.
2. pyrekordbox **auto-extracts the SQLCipher key from your Rekordbox install** when it opens the database, so with Rekordbox installed there is no separate key step. (`python -m pyrekordbox download-key` was removed upstream at AlphaTheta's request — do not re-add it.)

   If auto-extraction ever fails, cache the key once in Python:

   ```python
   from pyrekordbox.config import write_db6_key_cache; write_db6_key_cache("<key>")
   ```

   Or pass it directly: `Rekordbox6Database(key="<key>")`.

## The flow

```
0. Count the backlog            →  fluncle admin tracks list --no-key --json
1. Dry-run (DEFAULT)            →  propose Artist — Title : "Am" → "A minor"
2. Eyeball proposals + flags    →  approve; resolve ambiguous/unknown by hand
3. --apply                      →  write proposals via the CLI admin update
   else: leave it null — never write a guess
```

### Step 0 — Count the backlog

The `hasKey` filter makes the missing-key set countable and targetable (there was
no way to list it before this skill shipped):

```bash
fluncle admin tracks list --no-key --json | jq '.tracks | length'
```

`--has-key true` lists the findings that already carry a key; `--has-key false` is
the same backlog as `--no-key`.

### Step 1 — Dry-run (the default)

```bash
uv run packages/skills/fluncle-key-backfill/scripts/key_backfill.py
```

It reads every Rekordbox key, matches it to a missing-key finding, and prints each
proposal as `Artist — Title : "<rekordbox>" → "<normalized>"`, plus any **flagged**
rows (ambiguous or unknown-key) and a count of findings with no Rekordbox match
(left null — honest). Add `--json` for structured output, `--limit` to cap the page,
`--fluncle-bin ./path/to/fluncle` to point at a specific CLI, and `--db` to point at
a non-default `master.db`.

### Step 2 — Eyeball

- **Proposals** — confirm the `Artist — Title` and the `"short" → "normalized"`
  mapping look right. The normalized key uses the DSP's **sharp** spelling
  ("Bbm" → "A# minor"), so a stored value is directly comparable to DSP output.
- **Flagged / ambiguous** — Rekordbox rows whose keys disagree, or a key the
  normalizer couldn't parse. These are **never written**; resolve by hand (write a
  single track with `fluncle admin tracks update <id> --key "<key>"`).
- **No match** — expected for most of your library; those findings stay null.

### Step 3 — Apply

Once the proposals check out:

```bash
uv run packages/skills/fluncle-key-backfill/scripts/key_backfill.py --apply
```

Each proposal is written with `fluncle admin tracks update <trackId> --key
"<normalized>"` — the same authenticated admin path the enrichment agent uses. The
run reports how many writes succeeded and surfaces any failures.

## Matching discipline

- **Match on normalized title + artist**, never ISRC (Rekordbox's ISRC is
  unreliable). Case, accents, and `&`↔`and` are folded; `feat.` credits are dropped.
- **A remix / VIP / edit is a different recording with a different key.** Its
  mix-descriptor is kept as part of the identity, so "Song (Calibre Remix)" never
  matches the original "Song". `(Original Mix)` is treated as the original (not a
  distinguishing version). Both paren- and dash-notation of a version are folded.
- **An unrecognisable Rekordbox key normalizes to `None` and is SKIPPED** — the
  tool never guesses a key it can't parse.

## When to abstain

If a finding has no confident single-key Rekordbox match, **leave it null**. Null is
honest and retriable; a wrong-match key silently corrupts the archive — the exact
outcome the DSP's null-over-fake design (and this tool's dry-run gate) prevents.

## Notes

- The normalizer's `NOTES` array is a faithful copy of the enrichment DSP's spelling
  (`analyze-track.ts` `NOTES`, sharps). If the DSP's spelling ever changes, update
  `scripts/key_backfill.py` to match — a normalized key MUST equal what the DSP
  would have stored.
- The pure normalizer + matcher are unit-tested in `scripts/test_key_backfill.py`
  (all 24 keys, enharmonics, Camelot codes, unknown→skip, and the remix
  false-match guard). Run them with:

  ```bash
  uv run --with pytest pytest packages/skills/fluncle-key-backfill/scripts/test_key_backfill.py
  ```

- `pyrekordbox` tracks Rekordbox's encrypted schema and can break on a Rekordbox
  update — another reason this is a local, on-demand operator tool, not a cron.
