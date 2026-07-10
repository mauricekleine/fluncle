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

- [ ] Set `FLUNCLE_VJ_HOST` + `FLUNCLE_VJ_PORT` (default 9000) in the sender's environment. **The two Macs are not on the same LAN subnet** — the M-Track carries audio, not network. Sending to the M5's LAN address fails with `No route to host`; use its **Tailscale** address. This cost an hour at the office; do not rediscover it.
- [ ] On the M5 first: the bridge must be running in VJ mode (`bun run --cwd packages/live bridge --plan all`). It binds the UDP transition channel on all interfaces, port 9000 (override with `FLUNCLE_VJ_TRANSITION_PORT`). Outside `--plan all` the socket is never opened and datagrams go nowhere.
- [ ] With the FLX4 connected and Rekordbox running, start `sender.py` per [the README](../packages/live/scripts/m2-sender/README.md) and mix across both decks: faders, crossfader, bass cuts.
- [ ] Confirm a committed deck flip emits exactly one transition (no flapping on a long blend; sticky-hold when both decks are full up).
- [ ] The control map (deck=channel, CC numbers, 14-bit MSB) was validated live, but the code consuming it was not — if CCs read wrong, start there.
- [ ] `crossfader_gain` is **linear** (centre = 0.5 each) where the FLX4's real curve is a cut curve. It is symmetric, so the live-deck argmax is unaffected and this is not expected to matter — but if flips land at the wrong moment during a crossfader-led blend, this is the first suspect.

## 3. Deck identity — grant Screen Recording, validate the OCR

`deckwatch.py` OCRs the Rekordbox deck headers so a transition carries the track's identity ([docs/live-deck-identity.md](./live-deck-identity.md)).

- [ ] Grant **Screen Recording** permission (System Settings › Privacy & Security) to whatever runs `deckwatch.py` (the terminal, or the launchd context if it ends up wrapped). Without it the capture is blank. The script distinguishes a genuinely uniform image from "content but no header text", so trust what it says rather than assuming permissions.
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

## 6. The DSP key experiment — the ground truth only exists on this machine

Measured 2026-07-10: **BPM is solved.** Every finding is now `analyzedFrom: "full"`, and the two findings with DJ-graded ground truth carry `bpmSource: "audio-file"` (the DSP reading the captured full song, not a Rekordbox write) at 174.02 and 174.00 against Rekordbox's 174.00. The old ~1.5 BPM under-read was purely a 30s-preview artifact. Nobody needs to touch `estimateBpm`.

**Key is not solved, and the gap is invisible by construction.** Both ground-truth rows carry `keySource: "rekordbox"` — so the correct keys there prove the _sync_ works, not the DSP. Meanwhile **20 findings carry `keySource: "audio-file"`**: DSP-written keys, on exactly the tracks that never matched the Rekordbox library, so nothing has ever checked them. The server-side source hierarchy (operator > rekordbox > DSP) means no Rekordbox value will ever arrive to correct them either. If `estimateKey` still confuses the mode (major vs minor on the right tonic — it demonstrably did on preview audio) then those 20 rows are wrong, every future non-Rekordbox finding will be wrong, and the guard guarantees nobody notices.

You cannot answer this from the database: the guard means the DSP's key for a Rekordbox-matched row was never persisted. You must run the analyzer and observe what it _would_ emit. `master.db` is the ground truth and it lives here.

- [ ] Pick 15–20 findings that both have captured full audio (`sourceAudioKey` non-null) and exist in the Rekordbox library.
- [ ] For each, run `analyze-track.ts --audio-file <the captured full song>` and read the emitted `key` / `keyConfidence`. **Write nothing** — this is a measurement, not a backfill.
- [ ] Compare against `DjmdContent.Key.ScaleName`, scoring **tonic agreement** and **mode agreement** as two separate rates. They fail differently.
- [ ] High mode agreement → the 20 DSP keys are trustworthy; the preview was the whole problem, exactly as with BPM. Close the thread.
- [ ] Poor mode agreement → `estimateKey` has a real bug on full audio. Fix it, re-derive the 20 `audio-file` rows, and reconsider whether `KEY_CONFIDENCE_FLOOR = 0.6` is high enough. An honest NULL beats a confident wrong key; the archive already tolerates nulls.
- [ ] **Then update the docs, whichever way it lands.** `packages/skills/fluncle-rekordbox-sync/SKILL.md`'s description currently justifies the sync on "the DSP's key has observed mode errors" — that claim is either confirmed or retired by this experiment. `packages/skills/fluncle-track-enrichment/SKILL.md` describes the same estimator. Rewrite both to what you measured, then **re-run `bun run skills:install`** — the installed `.agents/skills/**` copy is what actually loads, and it ships publicly stale until you do.
- [ ] While you have `master.db` open: **35 findings carry `keySource: rekordbox` but only 2 carry `bpmSource: rekordbox`.** The sync claims to write both. Either it deliberately skips BPM when the DSP already holds a value (defensible, and correct given the result above), or ~33 BPM writes are being dropped. Confirm which.

---

_Not-M2 leftovers, for whichever machine you read this on: the one-time re-key of the 25 non-Rekordbox findings is still pending on the M5 (the `requeue-non-rb.py` one-liner in the 2026-07-10 session scratchpad), and that session's checkout has a consumed duplicate `autostash` entry safe to `git stash drop`._
