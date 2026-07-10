# M2 checklist — operator steps queued for the mixing Mac

Non-canonical operator checklist (AGENTS.md, Docs): the steps below were queued by work that shipped while the M2 was out of reach. Work through it top-to-bottom at the mixing Mac, tick things off by deleting their section, and **delete the whole file when it's empty** — a done checklist is pruned, never kept.

## 1. Rekordbox → Fluncle periodic sync (the `fluncle-rekordbox-sync` skill)

The weekly key/BPM sync ships in [packages/skills/fluncle-rekordbox-sync](../packages/skills/fluncle-rekordbox-sync) — its SKILL.md is the full runbook. The short form:

- [ ] `git pull` this repo on the M2.
- [ ] `brew update && brew upgrade fluncle` — the sync reads `keySource` off `admin tracks list --json`, which the CLI only carries from **0.119.0** (verified: 0.118 silently drops the field). An older CLI makes the dry-run propose ~35 phantom "stamp" writes and trip the max-writes fuse; that symptom means upgrade, not apply.
- [ ] Confirm the CLI is operator-authenticated (`fluncle recent --limit 1` works).
- [ ] Manual dry-run first: `uv run --with pyrekordbox python packages/skills/fluncle-rekordbox-sync/scripts/rekordbox_sync.py`. Expected result: **approximately zero proposals** — the archive was hand-synced against the freshly re-analyzed library on 2026-07-10. A big diff means something moved; read it before any `--apply`.
- [ ] Install the weekly timer: copy `assets/com.fluncle.rekordbox-sync.plist.template` per the SKILL.md (fill the `__REPO__`/`__LOG__` placeholders), then `launchctl load` it.

## 2. m2-sender — validate the MIDI path on the real controller

`packages/live/scripts/m2-sender/` reads the DDJ-FLX4's MIDI and emits the live-deck transition datagram to the bridge. The pure logic is fully tested, but per its README the **MIDI hardware path has never run against the controller** — the FLX4 wasn't present when it was built.

- [ ] **Rekordbox does not take exclusive MIDI, and that is the whole premise here.** The FLX4 is class-compliant and keeps streaming to a second process while Rekordbox is driving it. If `mido` shows no ports, look for one whose name contains `DDJ-FLX4` — do not go hunting for a way to prise the controller away from Rekordbox. This was proven live at the office.
- [ ] Set `FLUNCLE_VJ_HOST` + `FLUNCLE_VJ_PORT` (default 9000) in the sender's environment. **The two Macs are not on the same LAN subnet** — the M-Track carries audio, not network. Sending to the M5's LAN address fails with `No route to host`; use its **Tailscale** address. This cost an hour at the office; do not rediscover it. Both machines need Tailscale up; `tailscale status` on this Mac lists the M5 — use that hostname (or its tailnet IP) as `FLUNCLE_VJ_HOST`.
- [ ] **Prove the sender before you blame the network.** Point `FLUNCLE_VJ_HOST=127.0.0.1` at a local listener (`nc -ul 9000`, or three lines of Python) and mix one flip: you should see exactly one well-formed JSON datagram. This separates "the MIDI or the heuristic is wrong" from "the packet never arrived", which is precisely the confusion that cost the hour above — the logic was fine, the route was not.
- [ ] On the M5 first: the bridge must be running in VJ mode (`bun run --cwd packages/live bridge --plan all`). It binds the UDP transition channel on all interfaces, port 9000 (override with `FLUNCLE_VJ_TRANSITION_PORT`). Outside `--plan all` the socket is never opened and datagrams go nowhere.
- [ ] With the FLX4 connected and Rekordbox running, start `sender.py` per [the README](../packages/live/scripts/m2-sender/README.md) and mix across both decks: faders, crossfader, bass cuts.
- [ ] Confirm a committed deck flip emits exactly one transition (no flapping on a long blend; sticky-hold when both decks are full up).
- [ ] The control map (deck=channel, CC numbers, 14-bit MSB) was validated live, but the code consuming it was not — if CCs read wrong, start there.
- [ ] `crossfader_gain` is **linear** (centre = 0.5 each) where the FLX4's real curve is a cut curve. It is symmetric, so the live-deck argmax is unaffected and this is not expected to matter — but if flips land at the wrong moment during a crossfader-led blend, this is the first suspect.

## 3. Deck identity — grant Screen Recording, validate the OCR

`deckwatch.py` OCRs the Rekordbox deck headers so a transition carries the track's identity ([docs/live-deck-identity.md](./live-deck-identity.md)).

- [ ] Grant **Screen Recording** permission (System Settings › Privacy & Security) to whatever runs `deckwatch.py` (the terminal, or the launchd context if it ends up wrapped). Without it the capture is blank. The script distinguishes a genuinely uniform image from "content but no header text", so trust what it says rather than assuming permissions.
- [ ] **Then quit and reopen that terminal.** macOS attributes Screen Recording to the responsible app and does not apply a fresh grant to an already-running process. A `deckwatch` spawned by `sender.py --identity-cmd` inherits the grant of the terminal that launched the sender, so grant it there.
- [ ] **Do not minimize Rekordbox.** The window is found via the on-screen window list, so a minimized window is invisible to it and you get "no Rekordbox window found". Occluded or behind other windows is fine — the capture follows the window, not the screen.
- [ ] Validate: load tracks on both decks, run `deckwatch.py --once` — expect both titles parsed. It needs `pyobjc-framework-Quartz` + `pyobjc-framework-Vision` (run it under `uv run --with …`, as the repo does elsewhere).
- [ ] **The crop rects assume the two-deck PERFORMANCE layout**, measured on the M5 (window 1512x949 logical). The rects are fractional, so an identical screen resolution transfers them unchanged — but a four-deck layout, or a windowed/resized Rekordbox, moves the headers. There is a self-calibrating full-window fallback; confirm the fast path hits before relying on it.
- [ ] Then run the sender WITH identity attached: `--identity-cmd 'deckwatch.py --once --deck {deck}'`. The `{deck}` placeholder is substituted with the deck that went live; the sender pre-reads the incoming deck the moment it becomes a debounce candidate and attaches the cached identity on commit, so OCR is off the critical path and the scene still swaps **on the flip**.
- [ ] Confirm a flip's datagram carries the resolved finding, and that a track which is **not** a finding still transitions — falling back to a random VJ scene rather than showing the wrong one.
- [ ] If a track you know is in the archive fails to match: Apple Vision non-deterministically returns a **Cyrillic homoglyph** in the key field (`5А` not `5A`). It is folded, but it is the first thing to check. `MATCH_THRESHOLD` is `0.62` and unvalidated against real negatives — a miss costs you a random scene, a false positive puts the wrong finding on stream, so bias toward raising it if you ever see a wrong match.

## 4. Dress-rehearsal gate

After 2 + 3 individually pass: one end-to-end pass per the [live-show runbook](./live-show-setup.md) — mix a real transition on the rig and watch the glass react with the right track's identity before trusting it at a show.

## 5. Standing decisions to sanity-check once, at the rig

These were decided deliberately and are not bugs. They are recorded here because the rig is the first place they can actually be judged, and because a future reader will otherwise re-litigate them from scratch.

- [ ] **The transition channel is unauthenticated and bound on all interfaces.** Any peer that can reach the bridge's UDP port can drive the visuals. That is the same posture as the phone remote on `:4180`, and it is right for a home LAN or a tailnet. **A venue's network is not that.** Before playing anywhere the rig shares a network with strangers, either keep both machines on the tailnet only, or add a shared-secret field to the datagram. Decide this before the first show, not at the first show.
- [ ] **`MATCH_THRESHOLD = 0.62` was shipped unvalidated** (see §3). The cost is asymmetric: a miss shows a random scene, which nobody notices; a false positive puts the wrong finding on stream, which everybody does. If a real set produces even one wrong match, raise it — the fallback is designed to absorb the misses.
- [ ] **The crossfader curve is linear, the FLX4's is a cut curve** (see §2). Symmetric, so the live-deck argmax should be unaffected. Watch one crossfader-led blend and confirm the flip lands where your ears say it should.

## 6. Optional key spot-check vs the library

The 2026-07-10 accuracy run is fully closed: both estimators rebuilt and benchmarked (#424 BPM ±0.1 vs the beatgrids; #430 key at 82.8% full-song precision), the archive re-derived from full audio, the Rekordbox sync applied (35 keys + 2 BPMs), and the final 25-row re-key drained on 2026-07-10 — 17 keys confirmed, **8 corrected** (one mode-flip, seven relative/fourth-shift roots), zero failures, honest nulls kept, the one-time requeue script pruned. What survives as an optional M2-only check:

- [ ] Any non-DJ-graded finding that exists in the library but eluded the strict matcher (e.g. `004.4.8B`) can be checked against `DjmdContent.Key.ScaleName`. Where the DSP and Rekordbox disagree on mode, flag it or hand-set via `fluncle admin tracks update --key` (an operator write stamps `key_source: operator` server-side and is durably protected) — never assume either side is infallible. The weekly sync (§1) will stamp matcher-reachable rows on its own.

## 7. Historical set tracklists → mixability ground truth

The mixability engine's scoring weights are validated against how Fluncle actually mixes, and today the evidence is ONE set (`019.F.1A`, 16 transitions — the sample that showed his real transitions sit at chance on the Camelot axis). Every historical set in Rekordbox history widens that evidence. The extraction script emits per-track `key` + `bpm` (Rekordbox's whole-song analysis), so a set is self-contained ground truth — its transitions score directly from the emitted values, no archive join needed, non-findings included.

- [ ] Quit Rekordbox fully first — it holds an exclusive lock on `master.db` (§1's pyrekordbox key note applies here too).
- [ ] List what history holds: `uv run packages/skills/fluncle-mixtapes/scripts/rekordbox-tracklist.py --list` (newest first). Only REAL sets are ground truth — skip soundcheck noodling and single-track sessions; you are the judge of which sessions were actual mixing.
- [ ] Per real set: `uv run packages/skills/fluncle-mixtapes/scripts/rekordbox-tracklist.py --session <name-substring> --json > apps/web/scripts/__fixtures__/rekordbox-sets/<session-name>.json` (create the dir on first use; kebab-case the filename). That directory is the contract: the M5 session extends the mixability diagnostics to sweep exactly it once the first extracts land.
- [ ] Eyeball each JSON before committing: the script flags `DUP` rows (re-loads) and cannot distinguish a soundcheck pre-load from a played track — prune the spurious rows by hand; an unpruned pre-load poisons two transitions.
- [ ] Commit + push the extracts with a one-liner per set: date, row count, how many rows carry a key. Expect near-100% keyed (Rekordbox grades the whole library).
- [ ] Report the totals in §8: N sets, N transitions total (rows minus one per set). The M5 side then wires the diagnostics sweep and re-runs the weight validation against the widened evidence — that conclusion comes back through git, nothing else for the M2 to do.

## 8. Report back to the M5 (the cross-machine loop)

The M5 session that queued this work reconciles the results. Two channels:

- **Git is the async channel.** Prune finished sections from this file, and where a step produced numbers (transition counts, OCR parse rates, key spot-check disagreements), write them in — a dated one-liner per finding beats "done". Commit and push; the M5 session pulls and reconciles. Anything that turned out to be a code fix goes through the normal flow (small fix → commit on main; larger → worktree PR).
- **The live-rig validation (§2 + §3) is synchronous and needs both machines.** Coordinate with a session on the M5: it starts the bridge (`bun run --cwd packages/live bridge --plan all`), tails the bridge's transition log, and is the receiver-of-record — for each mixed flip the M2 reports "sent" and the M5 confirms "received, with identity payload X, scene swapped". Score sent vs received and note any datagram that arrived without identity. That pairing is itself the cross-machine communication test.
- **If the M2 says "sent" and the M5 never receives**, and the loopback self-test in §2 passed, suspect the M5's macOS application firewall (System Settings › Network › Firewall) silently dropping inbound UDP to the `bun` process — not the sender. UDP gives you no error on the sending side, so the M2 will look healthy either way.

---

_Not-M2 leftover: the M5 session's checkout has a consumed duplicate `autostash` entry safe to `git stash drop`._
