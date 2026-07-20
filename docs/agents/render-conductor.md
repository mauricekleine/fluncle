# The render conductor (`fluncle-render`)

The end-to-end doctrine for Fluncle's per-finding VIDEO render pipeline: how a queued finding becomes a shipped video on a GPU box that is asleep the rest of the time. This is the canonical home for the pipeline; the cron-roster row and the wiring summary live in [`hermes/cron/README.md`](./hermes/cron/README.md), and the operator's runbook (the exact reap/forensics/requeue recipes, box IDs, and secret map) is the private companion repo (`fluncle-labs`) plus the [`fluncle-hermes-operator`](../../packages/skills/fluncle-hermes-operator) skill.

> This repo is public. No hostnames, box IDs, ports, `op://` paths, or `/Users/…` paths live here — this doc is the architecture and the procedure; concrete access recipes are the ops runbook in the private companion repo.

## The shape

`fluncle-render` is unlike every other Hermes sweep. The other sweeps run their whole job inside the Hermes orchestrator box; this one is a **conductor**. The Hermes box has no GPU and no Remotion toolchain, so the conductor wakes a separate **scale-to-zero box.ascii GPU render box (rave-03)**, triggers the `@fluncle-video` render of exactly one queued finding _there_, and parks the box when the render finishes. The render box renders + **ships to R2 / the website** (it sets `video_url`); it **never posts to social** — enforced twice over: the render-queue prompt's hard rail says don't, AND the server-side role boundary makes it impossible (the box carries only the `agent`-scoped token, and every publish-class route is operator-tier → 403, so a misbehaving render agent _cannot_ post).

The conductor is a rave-02 HOST systemd timer (`fluncle-render.timer`/`.service`, every 60m — installed by [`hermes/install-host-timers.sh`](./hermes/), unit dir [`hermes/render-timer/`](./hermes/render-timer/)) that runs [`hermes/scripts/render-conductor.sh`](./hermes/scripts/render-conductor.sh). The script bakes into the Hermes image at `/opt/hermes-scripts` and auto-redeploys on merge to `main` via the on-box `pin-watch` self-deploy timer (`pin-watch` is the one host unit off the `fluncle-*` naming pattern). Its two companion scripts: [`provision-rave-03.sh`](./hermes/scripts/provision-rave-03.sh) reproduces the render box from clean `main`, and [`render-detached.sh`](./hermes/scripts/render-detached.sh) runs on the render box.

## The state machine + single-flight

A swangle (software-GL) render runs ~85 min, but the Hermes `--no-agent` runner kills any job at ~120s. So the conductor cannot block on the render. Instead the render runs **detached on the render box** (via `setsid` in `render-detached.sh`, so it survives the short triggering SSH and a Hermes container restart — the render is decoupled from the conductor), and each conductor tick is a quick (<120s) step in a two-state machine persisted under the conductor's `~/.render-conductor/`:

- **RENDERING** → poll the box for its `~/conductor-run.done` marker; when present, STOP (snapshot) the box and return to idle. Still running → NO-OP. Past `MAX_RENDER` → force-park (the stuck guard).
- **IDLE** → if past the hourly start gate AND the queue has a renderable finding: resume the parked box (or reprovision if box.ascii reclaimed it), freshen its checkout to `main`, inject creds, and trigger one detached render → rendering.

**Single-flight is the hard requirement — never two renders at once.** The STATE enforces it (only `idle` starts a render; a `rendering` tick only polls), and an atomic `mkdir` lock is a second guard so two ticks never race the state file (with a stale-lock breaker for a tick the ~120s runner killed mid-hold — `flock` is deliberately avoided as non-portable). Because a render (~85m) outlasts the hourly tick, the `rendering` no-op branch fires every cycle: it is the primary safety, exercised continuously, not a rare net.

**The force-park cap is `MAX_RENDER=12600s` (3.5h).** Plate-lane authoring runs ~2h+; the earlier 2.5h cap killed nearly-done renders, so it was raised to 3.5h. A render past the cap is treated as stuck: the box is force-parked and the finding takes a poison-ledger failure.

**The done-marker freshness guard.** The render box's home persists across stop/resume snapshots, so a done-marker from a PREVIOUS render can outlive it. `render-detached.sh` removes the marker before forking — but only if its trigger actually ran; a wedged box silently no-ops the trigger and leaves the OLD marker in place, which a bare `test -f` would misread as "finished" and chain to the same never-shipped finding forever. So the conductor trusts a marker only when its finish timestamp (`@ <iso>`) is at/after this render's start (minus a clock-skew grace). A stale/undated marker is treated as still-in-flight and the stuck-guard force-parks it, rather than a false "finished".

## The pick, the poison ledger, and the log-id coherence contract

The pick reads a **window** of the queue (`admin tracks queue --limit 25 --json`, oldest-first), not just the head — so a poisoned head can be stepped over without starving the findings behind it. The pick is the oldest finding that is NOT currently poisoned; 25 is far past any realistic simultaneous-poison count.

**The poison ledger** (a tab-separated `logId  count  lastFailEpoch` file, awk-manipulated write-to-temp-then-mv) is the head-of-line-block guard. After `POISON_THRESHOLD` (default 3) consecutive failures a finding is skipped for `POISON_TTL` (default 6h), then allowed one retry — so a TRANSIENT box.ascii wobble self-heals while an item-specific defect re-poisons. A clean render clears that finding's ledger. This exists because a single finding that failed hourly for ~9h once starved five findings behind it (2026-07-16).

**A clean EXIT is not proof — the video has to actually land.** A render can exit `0` without shipping: the `claude -p` agent gets cut off mid-render by a usage limit, or it renders a video the quality gates reject and withholds it. Treating that EXIT=0 as success clears the poison ledger and re-picks the SAME finding forever (the 2026-07-17 loop: 047.8.6J, then 047.6.6P, each spent hours false-succeeding). So the conductor confirms the finding carries a shipped `videoUrl` before clearing the ledger; a no-video EXIT=0 counts as a failure (false-success detection). A non-zero exit (e.g. the ~13s stale-version crash) counts directly. The ledger read is best-effort: any API/parse hiccup assumes shipped, so a transient read glitch never wrongly poisons a good render.

**The STALL WARNING.** One failure ahead of the poison alert — at `POISON_THRESHOLD - 1` consecutive clean-exit-no-video runs — the conductor fires a Discord ping. Two consecutive clean exits with no video landing is the silent-waste signature (a whole render's tokens burned twice with nothing shipped), so the operator is paged an hour before the poison threshold rather than after a third burn.

**The log-id coherence contract (poison ↔ queue).** The render agent must film the SAME finding the conductor accounts for. The conductor stamps the assigned finding as `FLUNCLE_RENDER_LOG_ID` in the injected box env, and the render-queue prompt treats that as THE pick (its `videoUrl` guard keeps re-runs safe). Before this, the agent re-read the queue itself and could re-pick a head the conductor had just poison-skipped — the fail counter then bumped an innocent finding while the offender burned tokens uncounted (2026-07-19: 049.4.4G took fail #2 for 049.7.6B's renders). The stamp closes that gap: the conductor's accounting and the agent's work name the same finding.

## The diversity-axes injection

Homogenisation is designed out UP FRONT, not coached mid-flight (prescriptive coaching increases convergence rather than fixing it). Before triggering the render the conductor pipes the vehicles ledger (`admin tracks vehicles --json`) through [`hermes/scripts/assign-video-axes.ts`](./hermes/scripts/assign-video-axes.ts), which emits `FLUNCLE_VIDEO_*` env lines appended to the box env, so the render agent's creativity lives inside a fixed cell (vehicle name, shader concept, motion, composition stay free):

- `FLUNCLE_VIDEO_GRAIN` — the grain family, chosen least-recently-used and excluding the last three renders' grains.
- `FLUNCLE_VIDEO_REGISTER` — **hard-pinned `representational` since 2026-07-20**. Representational is a PREREQUISITE, not a quota: the TikTok read is unambiguous (plate-lane pieces with real shapes/figures/artifacts consistently outperform; abstract underperforms), so every render stages a presence. Diversity now lives entirely in the grain family, the palette-avoid directive, the plate subject-kind rotation, and the vehicle — the axes that vary WITHIN representational.
- `FLUNCLE_VIDEO_PALETTE_AVOID` — an optional NEGATIVE directive ("<X> is spent — swing away") derived from the recent window's worn palette bucket or the known amber/halftone basin; absent when nothing is clearly worn.

The assigner is **fail-open by contract**: any hiccup (malformed ledger, a missing bin) prints nothing and the render falls back to free-choice behaviour — an axis assign NEVER blocks a render.

## The headless `claude -p` trap (and the rails)

**Doctrine: EVERY box `claude -p` invocation sets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`.** Headless mode kills backgrounded Bash tasks ~5s after the final result (documented Claude Code behaviour: code.claude.com/docs/en/env-vars.md). A render agent that backgrounds the encode and ends its turn "waiting for the notification" dies unshipped with EXIT=0 — the 2026-07-19 dead-render class. The whole render must fit in ONE blocking Bash call.

`render-detached.sh` sets the rails behind that doctrine for the render:

- `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` — the harness-level guarantee: no background tasks at all (the render-queue prompt also forbids `run_in_background`, but this is the belt behind the prompt's braces).
- `BASH_MAX_TIMEOUT_MS=3600000` + `BASH_DEFAULT_TIMEOUT_MS=900000` — a full render must fit in one blocking Bash call, so the Bash-tool timeout ceiling is raised to 60 min.
- `--max-turns 150` — bounds a wedged run (healthy renders measure 76–98 turns) so a stall fails fast and the next hourly tick retries.
- `--model opus` — the render is pinned to Opus, never the CLI default (which is whatever the box token resolves to). Video authoring is held to the Opus bar everywhere; pinning it here stops a shifting CLI default from silently re-tiering the render.

## The version trap has two faces

The bundled `fluncle` CLI + `render-detached.sh` do not ride the checkout, so a resumed snapshot can carry a stale vintage while the pin moves on — and the drift bites in both directions:

- **A STALE box `claude` crashes clean** — EXIT=1, ~13s. The finding takes a direct poison-ledger failure.
- **A FRESH box `claude` auto-backgrounds and false-idles** — EXIT=0, no video. Caught by the false-success detection above (video-landed check), which counts it as a failure and eventually poisons.

The conductor mitigates by re-copying both the bundled CLI (to `~/.local/lib/fluncle.mjs`) and `render-detached.sh` at every wake — one small scp each against an ~85m render, best-effort (a failed copy logs and renders on the box's existing copy). This keeps the box's render entry + CLI current with the conductor's baked vintage; the checkout freshen (below) keeps `packages/video` + the skill current.

## Snapshot freshness (the checkout freshen)

A resumed snapshot carries a stale `fluncle` checkout — the clone from whenever the box was last provisioned — so a `packages/video` / `fluncle-video`-skill fix would otherwise not reach the render box until box.ascii purged the snapshot and forced a reprovision. The render box is scale-to-zero (asleep but for a render), so it can't watch `main` itself like the rave-02 `pin-watch` timer; instead the conductor freshens it **at wake**, right after a successful `box resume`, via `freshen_checkout`: a drift-gated `git fetch --depth 1` + `git reset --hard origin/main`, running `bun install` and re-adding the `fluncle-video` skill ONLY when the lockfile / skill subtree actually moved. It is best-effort — a fetch/reset failure logs and renders on the existing checkout — and the common case (a code change, no dep change) is a few seconds against an ~85m render. So every render runs current `main`; a fix lands on the next render, not at the next purge. The reprovision path needs none of this — it clones clean `main` by construction. When a resume succeeds but box.ascii's snapshot dropped `~/fluncle` entirely, `freshen_checkout` signals the missing checkout so the conductor stops that box and reprovisions rather than looping on a stale done-marker.

## Reap recovery (stale/wedged box → cold provision)

When a box goes stale or wedged — the checkout freshen silently failing on flaky box.ascii `box ssh` 500s, `machine_not_running` loops, a resume that keeps producing no render — the recovery is **reap → cold provision**, and it always converges because a fresh box clones current `main` by construction:

1. `box delete <id>` — reap the wedged box.
2. Clear the conductor's box-id state file — so the next tick has no box to resume.
3. Set the conductor state to `idle`.
4. Trigger the render service — the conductor cold-provisions a fresh box from clean `main`.

The conductor already condemns a box that fails to launch a render (it deletes the box, clears the box-id, and stays idle so a fresh box provisions next tick). The manual reap is for the cases its own guards do not catch. The exact commands (box IDs, state-file path) are the ops runbook in the private companion repo.

## Snapshot forensics (read a stopped box without resuming)

A stopped box's filesystem is readable WITHOUT resuming it (no billing for a running box, no risk of racing the conductor):

- `box snapshots <id>` — list the box's snapshots.
- `box snapshot tree <id>` — browse the snapshot's filesystem.
- `box snapshot pull <id>` — pull snapshot files to the operator machine.

For selective extraction of a large file, resume + stream it off (`box ssh -- "gzip -c <file>"` piped to the operator machine), then stop the box. The box CLI verbs that exist are `resume` / `stop` / `delete` / `ssh` / `scp` / `snapshot` — there is **no `start`** (`resume` wakes a parked box; `provision-rave-03.sh` creates a new one).

## Known issues (documented as such)

Two failure modes are known and lived-with, not yet fixed — recognise them rather than re-diagnosing:

- **`box ssh` intermittently 500s.** box.ascii's `box ssh` occasionally returns a 5xx, which makes the best-effort checkout freshen silently fail — so a long-lived box can render with a days-stale prompt. The freshen is best-effort by design (it renders on the existing checkout on any hiccup); the durable fix for a persistently-stale box is the reap recovery above.
- **A cold-wake tick can exceed the runner kill window.** A cold wake (resume + freshen + scp) can exceed the ~120s Hermes runner kill window, dying silently between resume and trigger. Symptom: the box is resumed but no render started and the state is still `idle`. The next hourly tick recovers (the box is already warm, so the tick is fast), or the reap recovery forces it.

## requeue-video (re-render a shipped finding)

`fluncle admin tracks requeue-video <id|logId>` (operator tier) puts a finding back in the render queue. It clears BOTH `video_url` (the render-queue gate) and `video_squared_at` (the radio-eligibility gate), while the prior vehicle/grain ledger columns stay put so the next render diversifies away from what shipped. `finalize_track_video` auto-purges the cached Cloudflare Media-Transformation renditions on every finalize, so a re-render replaces the old clip cleanly (no manual CDN purge). This is the operator's lever for a bad render: requeue, and the conductor picks it up on the next hourly idle tick.

## Cost accounting

The conductor emits the render's self-seconds compute to the cost ledger (`video` · `self` · `seconds` · `subsidized`, the render's own wall-clock DURATION from the done-marker, scoped to the rendered logId). It is best-effort and never fails a tick — a dropped emit only understates the ledger.

## box.ascii CLI quirks (handled)

Wiring the conductor live surfaced several box.ascii CLI realities a stubbed dry-run could not — all handled in the Dockerfile + scripts, recorded so a rebuild does not re-debug them:

- **The installer needs `$SHELL` set + ends in an interactive onboard.** It runs `basename "$SHELL"` under `set -u` (`$SHELL` unset in a Docker build → exit 2) AND ends with an interactive `box onboard` needing a tty. The Dockerfile sets `SHELL=/bin/sh`, wraps the install `(curl | sh || true)`, and `test -x` the binary; runtime auth is `box login`, never baked.
- **`box new --ttl` is SECONDS (not a duration string) and is mutually exclusive with `--no-auto-stop`.** The conductor REQUIRES `--no-auto-stop` (it poll-detects done by ssh'ing the RUNNING box; a TTL/auto-stop box would vanish mid-poll), so there is no box-side lifetime backstop — the conductor is the sole stop authority.
- **`box status` exits 0 even when unauthenticated**, so it cannot gate the login; the conductor always `box login`s (idempotent).
- **`box ssh` propagates remote pass/fail (0 vs 1) but not the exact exit code** (it prints an error JSON on non-zero, flattening a remote `exit 42` to its own `1`). Load-bearing remote steps therefore assert on an explicit OUTPUT marker the remote command emits (the `~/conductor-run.done` poll and the "needs reprovision" grep are this pattern), not on the wrapper's exit code.
- **`box ssh 'bash -s' <<heredoc` feeds the script on stdin, and `npx skills add` reads that stdin**, eating the rest of the script. Every provision step gets `</dev/null` + a post-setup dir check.

## Operator ops

Smoke-testing, box IDs, the secret map, and the exact reap/forensics recipes are the operator's domain: mimic the cron user (`docker exec -u hermes -e HOME=<agent-home>`), run the conductor by hand against a non-empty queue (expect `started render of <logId> on <boxid>`; a second immediate run holds on single-flight), and confirm the first render ships before scheduling. The full recipes live in [`hermes/render-timer/README.md`](./hermes/render-timer/README.md), the [`fluncle-hermes-operator`](../../packages/skills/fluncle-hermes-operator) skill, and the ops runbook in the private companion repo.
