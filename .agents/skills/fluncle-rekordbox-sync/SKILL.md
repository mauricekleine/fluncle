---
name: fluncle-rekordbox-sync
description: >-
  Sync the operator's Rekordbox library — the DJ-graded ground truth for musical
  key and BPM — into Fluncle's archive on a PERIODIC schedule. Rekordbox analyses
  the whole song and the DJ hand-corrects it. Fluncle's DSP now analyses the captured
  full song too and its BPM agrees with Rekordbox to within ~0.02, but its KEY is the
  weaker signal: it leaves `tracks.key` NULL below a confidence floor, and mode errors
  (major vs minor on the right tonic) have been observed. So key is what this sync is
  really for. This skill reads
  every Rekordbox key + BPM, matches
  each to a finding by normalized title+artist, and writes the graded values back via
  `fluncle admin tracks update --key-source rekordbox` / `--bpm-source rekordbox` so
  the server-side source hierarchy (operator over rekordbox over DSP) protects them from a
  later agent-tier DSP pass. Dry-run by default with a max-writes fuse; the operator
  runs it (or the weekly launchd timer runs it) on the M2 mixing Mac where Rekordbox
  lives. Use when the user asks to sync Rekordbox keys/BPMs into Fluncle, set up or
  run the periodic key/BPM sync, or invokes it by name. SUBSUMES the retired
  fluncle-key-backfill skill (its matcher lives on here).
---

# Fluncle Rekordbox Sync

The periodic reconciliation of the operator's DJ-graded key + BPM (Rekordbox, the
ground truth) into Fluncle's findings archive. It replaces the one-shot
`fluncle-key-backfill` skill: the ported matcher + `normalize_key` live here verbatim,
and the sync now covers BPM as well as key and runs unattended on a weekly timer.

## Where this runs

On the **M2 mixing Mac** — Rekordbox and its encrypted `master.db` live there, and the
M2 is the LEADING library (a mirror lives on the M5). Like the two `fluncle-mixtapes`
Rekordbox scripts, this reads `master.db` locally; unlike them it also WRITES to the
production archive through the authenticated admin API (never the DB directly).

## The ratified diff rules

| Field   | Propose the Rekordbox value when…                                                                                | Never touch when…                            |
| ------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **key** | the stored key DIFFERS, **or** it matches but `keySource != "rekordbox"` (a protective stamp)                    | `keySource == "operator"` (hand-graded wins) |
| **bpm** | the stored BPM is NULL, **or** \|stored − rb\| > 0.5 (a big delta = a stale-kept DSP value or a suspect capture) | `bpmSource == "operator"`                    |

- Write each proposed finding with one `fluncle admin tracks update <trackId> --key "<k>" --key-source rekordbox` and/or `--bpm <n> --bpm-source rekordbox` (both fields ride ONE update call).
- A finding whose Rekordbox matches DISAGREE (two graded copies with different keys, or BPMs more than 0.5 apart) is AMBIGUOUS: skip it and list it for the operator. Never guess.
- A tiny BPM delta (≤ 0.5) is rounding — leave it. A protective key stamp writes the SAME value the finding already stores, only to record `rekordbox` provenance.

## The safety model

- **Dry-run is the default.** The script proposes and writes nothing until `--apply`.
- **`--max-writes N` (default 20) is a fuse.** If the proposed write count exceeds it, the run writes NOTHING and exits non-zero — a blown join or a mass Rekordbox re-grade fails loudly for an unattended run rather than half-applying. Eyeball the diff, then raise the fuse if it is genuinely all correct.
- **The server hierarchy guard is the real backstop.** Even a buggy `--apply` can never overwrite an operator-graded value: the agent-tier guard in `apps/web` `track-update.ts` drops a `rekordbox` write onto an `operator` row. Operator stamps are never clobbered.
- **Match discipline (ported, unchanged).** Normalized title+artist, never ISRC (Rekordbox's is unreliable). Case/accents/`&`↔`and` folded, `feat.` credits dropped. A remix/VIP/edit keeps its mix-descriptor as identity, so "Song (Calibre Remix)" never matches the original "Song". An unparseable Rekordbox key normalizes to nothing and yields no proposal.

## Requirements

- The **`fluncle` CLI** on PATH, and for `--apply`, operator-authenticated (`FLUNCLE_API_TOKEN`). The archive read is admin-tier; the write is `update_track`.
- **`uv`** (runs the bundled `scripts/rekordbox_sync.py` with its inline `pyrekordbox` dep).
- **Rekordbox** installed on this Mac and fully **quit** (it holds an exclusive lock on `master.db`), with the SQLCipher key auto-extractable (pyrekordbox does this from your install — no separate key step).

## Run it

```bash
# Dry-run (the default) — propose, write nothing:
uv run packages/skills/fluncle-rekordbox-sync/scripts/rekordbox_sync.py

# Machine-readable summary of the same dry-run:
uv run packages/skills/fluncle-rekordbox-sync/scripts/rekordbox_sync.py --json

# Apply after eyeballing the diff:
uv run packages/skills/fluncle-rekordbox-sync/scripts/rekordbox_sync.py --apply

# Unattended (what the timer runs): one-line summary + a non-zero exit on any failure:
uv run packages/skills/fluncle-rekordbox-sync/scripts/rekordbox_sync.py --apply --quiet
```

Flags: `--max-writes N` (fuse, default 20), `--fluncle-bin ./path/to/fluncle`, `--db /path/to/master.db` (default: auto-detect), `--self-test` (run the pure-rule checks and exit).

On this M5 mirror, a dry-run after a fresh sync should propose ≈0 changes — a near-empty diff is the expected in-sync result.

## One-time M2 setup (the weekly timer)

1. Confirm the checkout, the `fluncle` CLI (operator-authenticated), and `uv` are present on the M2.
2. Run a manual dry-run first and eyeball the proposals:
   ```bash
   uv run packages/skills/fluncle-rekordbox-sync/scripts/rekordbox_sync.py
   ```
3. Copy the launchd template and fill in the two placeholders with real absolute paths (no `~`):
   ```bash
   cp packages/skills/fluncle-rekordbox-sync/assets/com.fluncle.rekordbox-sync.plist.template \
     ~/Library/LaunchAgents/com.fluncle.rekordbox-sync.plist
   # edit ~/Library/LaunchAgents/com.fluncle.rekordbox-sync.plist:
   #   __REPO__ -> the absolute path to your Fluncle checkout
   #   __LOG__  -> an absolute path for the run log
   ```
4. Load it:
   ```bash
   launchctl load -w ~/Library/LaunchAgents/com.fluncle.rekordbox-sync.plist
   ```

It runs `--apply --quiet --max-writes 20` weekly (Sunday 12:00 local). Quit Rekordbox before that time so the lock is free. Tail `__LOG__` after the first run to confirm a clean summary. NEVER commit the filled-in plist — the concrete paths are machine topology.

## Tests

The pure diff rules + matcher are unit-tested (operator-skip, protective stamp, key-differ, BPM-only-on-null-or-big-delta, ambiguity, the max-writes fuse):

```bash
uv run --with pytest pytest packages/skills/fluncle-rekordbox-sync/scripts/test_sync_rules.py
```

A dependency-free mirror runs without pytest as a box-side smoke:

```bash
uv run packages/skills/fluncle-rekordbox-sync/scripts/rekordbox_sync.py --self-test
```

## Notes

- The normalizer's `NOTES` array is a faithful copy of the enrichment DSP's spelling (`analyze-track.ts` `NOTES`, sharps). Keep it identical — a normalized key MUST equal what the DSP would have stored, so a value comparison is honest.
- The matcher (`_fold` / `_normalize_artists` / `_split_title` / `match_key`) is the same one mirrored in the TS `apps/web/src/lib/server/track-match.ts` and the mixtapes `_matching.py`. This skill's `scripts/rekordbox_sync.py` is now its canonical Python home (it moved here from the retired key-backfill).
- `pyrekordbox` tracks Rekordbox's encrypted schema and can break on a Rekordbox update — another reason this is a local, operator/timer job on the M2, not a server cron.
