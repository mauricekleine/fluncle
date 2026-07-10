# M2 checklist — operator steps queued for the mixing Mac

Non-canonical operator checklist (AGENTS.md, Docs): the steps below were queued by work that shipped while the M2 was out of reach. Work through it top-to-bottom at the mixing Mac, tick things off by deleting their section, and **delete the whole file when it's empty** — a done checklist is pruned, never kept.

## 1. Rekordbox → Fluncle periodic sync (the `fluncle-rekordbox-sync` skill)

The weekly key/BPM sync ships in [packages/skills/fluncle-rekordbox-sync](../packages/skills/fluncle-rekordbox-sync) — its SKILL.md is the full runbook. The short form:

- [ ] `git pull` this repo on the M2.
- [ ] `brew update && brew upgrade fluncle` — the sync reads `keySource` off `admin tracks list --json`, which the CLI only carries from **0.118.0**. An older CLI makes the dry-run propose ~35 phantom "stamp" writes and trip the max-writes fuse; that symptom means upgrade, not apply.
- [ ] Confirm the CLI is operator-authenticated (`fluncle recent --limit 1` works).
- [ ] Manual dry-run first: `uv run --with pyrekordbox python packages/skills/fluncle-rekordbox-sync/scripts/rekordbox_sync.py`. Expected result: **approximately zero proposals** — the archive was hand-synced against the freshly re-analyzed library on 2026-07-10. A big diff means something moved; read it before any `--apply`.
- [ ] Install the weekly timer: copy `assets/com.fluncle.rekordbox-sync.plist.template` per the SKILL.md (fill the `__REPO__`/`__LOG__` placeholders), then `launchctl load` it.

## 2. m2-sender — validate the MIDI path on the real controller

`packages/live/scripts/m2-sender/` reads the DDJ-FLX4's MIDI and emits the live-deck transition datagram to the bridge. The pure logic is fully tested, but per its README the **MIDI hardware path has never run against the controller** — the FLX4 wasn't present when it was built.

- [ ] With the FLX4 connected and Rekordbox running, start `sender.py` per [the README](../packages/live/scripts/m2-sender/README.md) and mix across both decks: faders, crossfader, bass cuts.
- [ ] Confirm a committed deck flip emits exactly one transition (no flapping on a long blend; sticky-hold when both decks are full up).
- [ ] The control map (deck=channel, CC numbers, 14-bit MSB) was validated live, but the code consuming it was not — if CCs read wrong, start there.

## 3. Deck identity — grant Screen Recording, validate the OCR

`deckwatch.py` OCRs the Rekordbox deck headers so a transition carries the track's identity ([docs/live-deck-identity.md](./live-deck-identity.md)).

- [ ] Grant **Screen Recording** permission (System Settings › Privacy & Security) to whatever runs `deckwatch.py` (the terminal, or the launchd context if it ends up wrapped). Without it the capture is blank and the script reports "no text on either deck".
- [ ] Validate: load tracks on both decks, run `python3 packages/live/scripts/deckwatch/deckwatch.py --once` — expect both titles parsed.
- [ ] Then run the sender WITH identity attached (`--identity-cmd` per the deck-identity doc) and confirm a flip's datagram carries the resolved finding.

## 4. Dress-rehearsal gate

After 2 + 3 individually pass: one end-to-end pass per the [live-show runbook](./live-show-setup.md) — mix a real transition on the rig and watch the glass react with the right track's identity before trusting it at a show.

---

_Not-M2 leftovers, for whichever machine you read this on: the one-time re-key of the 25 non-Rekordbox findings is still pending on the M5 (the `requeue-non-rb.py` one-liner in the 2026-07-10 session scratchpad), and that session's checkout has a consumed duplicate `autostash` entry safe to `git stash drop`._
