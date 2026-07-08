# RFC: Durable, self-updating Hermes box deploy — no stale scripts, nothing lost on rebuild or re-provision

**Status:** Final (research → /taste → 3-role adversarial panel [infra/SRE, Docker/build, CLI-DX/scope] synthesized → operator riff, 2026-07-08) — completeness standard applied.
**For:** a build session (or a small team of agents) + one attended operator rebuild on rave-02.
**Canon/authority:** the codebase (`docs/agents/hermes/Dockerfile`, `docs/agents/hermes/pin-watch/rebuild-hermes.sh`, `docs/agents/hermes/*-timer/**`, `docs/agents/hermes/cron/README.md`, `docs/agents/hermes/scripts/**`) and the operator runbooks (`packages/skills/fluncle-hermes-operator`). `docs/` is non-canonical planning per AGENTS.md.

> Process note: grounded in a two-sided live audit (the rave-02 box over SSH + the repo deploy model), a /taste pass, a 3-role adversarial panel that verified every load-bearing claim live, and an operator riff that reshaped the cron story. The panel overturned the original premise (embed is not dead) and the venv fix (the sketched `uv` incantation was wrong). The riff landed the biggest simplification: **retire the Hermes gateway's cron subsystem for automation and run every sweep from a repo-checked-in host systemd timer** — which makes the schedule code by construction, and cascades into deleting the boot-sync projection and every `cont-init` change the earlier draft carried. The CLI fold is dropped (the DSP goes durable by baking its skill). Verifications in the appendix.

## The standard (definition of done)

Boil the ocean. This ships **complete**: every on-box sweep script + the enrichment DSP skill + `embed-track.py` baked into the image (read directly from the baked path — no hand-`docker cp`, no volume projection); a pinned baked `yt-dlp`; the `copywriting-fluncle` double-ship collapsed; a **durable, digest-pinned** MuQ venv a rebuild can't silently break; a **cheap, memory-capped, timeout-wrapped** pre-smoke that proves the embed engine before the swap; **every automation cron migrated off the Hermes gateway scheduler onto a repo-checked-in host systemd `.timer`/`.service` pair** so the schedule _is_ code and a bare re-provision brings up a _working_ box, not just files; every runbook moved from "docker cp + hermes cron create" to "baked + host-timer, auto-deployed"; and tests (a pre-smoke self-test + the migrated crons verified live; the enrichment DSP tests stay green in place). Tests + docs are acceptance items, not follow-ups. The **only** sanctioned "not now" are two honest external-dependency deferrals, stated plainly: (1) the one attended `rebuild-hermes.sh --force` on rave-02 that first deploys the image change (needs the box + a human); (2) the **accumulated-state** restore tooling (sessions/memories/kanban/cron-output in `state.db` + the agent home) — this RFC makes _code + schedule + secrets_ survive a reset and documents the state boundary, but building the `backup-sweep`→R2 restore utility is a genuinely separate tool.

## 0. Summary / the reframe

- **Two invariants, honestly named** (the /taste pass split the over-stretched banner):
  1. **Code rides the image; the volume holds only state — no projection.** Scripts, the DSP skill, `embed-track.py`, `yt-dlp` all bake into the image and auto-update from `main` via the existing hourly pin-watch rebuild. Their consumers (the host-timer units) exec them **straight from the baked `/opt/hermes-scripts`**, so there is no copy on the volume to go stale — `/opt/data` holds only genuine state (the agent home + auth, secrets, `state.db`, logs, cron output). _This is the form the riff unlocked: the earlier draft synced the baked scripts onto `/opt/data/scripts` at boot because the **gateway** cron runner resolved scripts by basename against its own state dir. Retire the gateway cron subsystem (invariant is now literal) and the projection — and every `cont-init` change — is gone._
  2. **The rebuild must prove its engines before the swap.** pin-watch pre-smoke today tests `fluncle`/`claude` versions + an enrich read + a publish-refusal — it never touches MuQ, which is _exactly_ why a bad build slipped through once. A cheap embed smoke closes that hole. A distinct _deploy-safety_ invariant, not an instance of #1.
- **The schedule is state today, and that's the real reset gap.** All ~11 remaining automation crons live in the gateway's `state.db` on the volume — created by `hermes cron create`, invisible to git. A bare re-provision with perfect _code_ durability still boots a box where **nothing schedules the work** (~2 of 16 jobs run). And the gateway runner is _worse_ than the alternative anyway: one serial runner on a ~300 s global budget, which is why `capture`/`embed`/`healthcheck`/`pin-watch` already fled it for host systemd timers. So: **finish that migration.** Every `--no-agent --script … --deliver local` cron becomes a repo-checked-in host `.timer`/`.service` pair installed by the provision script. Schedule = code, durable by construction; one scheduler, the better one (parallel, `Persistent=true` reboot-catch-up, `journalctl` observability); `state.db` stops holding any schedule; the gateway _chat_ agent (the Discord presence, `gateway run`) is untouched.
- **The premise correction the panel forced: embed is _not_ dead.** The box has rebuilt past the `#383` break (now on `v2026.07.08-73e5c1a`); `import torch, muq` works and the 1.3 GB weights are present. The break **self-healed on an unchanged Dockerfile** — the signature of a Docker layer-cache / mutable-base-tag flake, not a code bug. And embed isn't even a gateway cron (it's already a host timer). So this is a **latent-fragility + missing-guard** problem, not an outage — which _strengthens_ the durability case (intermittent, cache-driven breakage is the worst kind) and removes a false alarm.
- **The lever already exists.** `pin-watch.timer` → `rebuild-hermes.sh` already `reset --hard origin/main` + rebuilds + pre-smokes + swaps + auto-rolls-back, hourly. We are not building a deploy system — we are baking the last hand-managed code, closing the pre-smoke hole, and moving the schedule into git.
- **Decomposition:**
  - **Unit A — Bake the code surface (read-from-baked).** No boot-sync, no cont-init. Additive; breaks nothing.
  - **Unit B — Durable, digest-pinned MuQ venv.** Independent.
  - **Unit C — Pre-smoke proves the engine.** The deploy-safety keystone; guards A/B forever.
  - **Unit D — Pinned baked `yt-dlp` + collapse the `copywriting-fluncle` double-ship.** Rides A.
  - **Unit E — Retire the gateway cron subsystem for automation → repo-checked-in host systemd timers.** The reset-durability spine; makes the schedule code.
  - **Unit F — Docs, runbooks, tests.**
  - **Dropped — the CLI fold.** Baking the enrichment skill (Unit A) makes the DSP durable + auto-updating with zero product-surface change, so folding `analyze-track` into the CLI buys durability nothing. Not pursued (rationale retained in §8 in case it's ever revisited on product merits).

## 1. Context & goals

**Why now.** This session hand-`docker cp`'d 6 files to un-stale the box's enrich/embed scripts, then hit a MuQ venv that had broken on an image rebuild. Both are the same shape: the box's code is split between an auto-updating image and a hand-managed volume, the rebuild's pre-smoke doesn't test the half that broke, and the _schedule_ that runs it all lives in mutable volume state. The operator's bar: **the full rig survives a server restart/reset with no file stale or lost.**

**Goals (calibrated — what's in reach vs. the honest boundary):**

1. Zero manual `docker cp` for code, and zero manual `hermes cron create` for schedule — a merge to `main` reaches the box automatically for every script, the DSP, `embed-track.py`, `yt-dlp`, _and_ every cron definition. **In reach.**
2. An image rebuild can never again silently ship a broken embed engine. **In reach** (digest-pin + pre-smoke).
3. A bare host re-provision brings up a **working** box: code baked _and_ the schedule installed from the repo _and_ secrets re-injected. **In reach** (host-timer migration + provision script + `fluncle-secrets-sync`). The accumulated agent state (sessions/memories/output) restore tooling is the one honest follow-on.
4. One source of truth per artifact (kill the `copywriting-fluncle` double-ship). **In reach.**

## 2. Unit A — Bake the code surface (read directly from the baked path)

**Direction.** The Dockerfile bakes the on-box code into `/opt/hermes-scripts` (+ the DSP skill into `/opt/hermes-skills`). Its consumers — the host-timer units (Unit E) and any manual operator invocation — exec **from the baked path**. No boot-sync, no `cont-init`, no volume copy: `/opt/data` never holds a script again.

**Concrete plan.**

- Dockerfile: `COPY docs/agents/hermes/scripts/ /opt/hermes-scripts/` — **filtered** (build context is repo-root per `Dockerfile:5-7`, so the path resolves like the existing font/skill COPYs). The dir contains `*.test.ts` (capture/embed/enrich sweep tests) + `provision-rave-03.sh` + `clip-drip-sweep.sh` (a _deliberately_ un-deployed cron per memory) — do **not** blanket-bake them. Use an explicit include list (or a `.dockerignore`-scoped copy); `clip-drip-sweep.sh` stays out until its own go-live.
- Bake the enrichment skill — **mirror `Dockerfile:183`** (`COPY packages/skills/fluncle-track-enrichment/scripts /opt/hermes-skills/fluncle-track-enrichment/scripts`). This is what makes the DSP (`analyze-track.ts`, which lives under `packages/skills/`, **not** under `docs/agents/hermes/scripts/`) durable + auto-updating. Point `enrich-sweep.ts`'s analyze-script default at the baked path (`/opt/hermes-skills/fluncle-track-enrichment/scripts/analyze-track.ts`), retiring the `/opt/data/skills/...` constant (and its `enrich-sweep.test.ts` pin) as part of Unit E's per-cron migration.
- `chmod -R a+rX /opt/hermes-scripts /opt/hermes-skills && chmod +x /opt/hermes-scripts/*.sh /opt/hermes-scripts/*.py`. **Perms, not ownership, are the invariant** (the sweeps are read+exec'd by the non-root `hermes` user; `a+rX` grants that regardless of owner).
- **No `cont-init`/s6 work at all.** The earlier draft's `03-sync-scripts` oneshot existed only to feed the gateway's basename resolution; Unit E removes that consumer, so the sync is not written. (This deletes the whole s6-bundle risk class from the plan.)

**Honesty (in the doc + runbooks):** `/opt/data/{scripts,skills}` become vestigial once Unit E lands — the host-cp'd copies are unused. Unit E/F prune them on the box and drop them from the reset path so no dead code lingers. The invariant is clean: **image = the only home for code; volume = state only.**

**Staging note (why A breaks nothing on its own).** A is purely additive — it bakes to `/opt/hermes-scripts` while the still-live gateway crons keep reading their existing `/opt/data/scripts` copies (unchanged from today). Nothing switches to the baked path until Unit E repoints it. So A and E can land in the same PR or A first; there is no window where a cron reads a path that isn't there.

## 3. Unit B — Durable, digest-pinned MuQ venv

**Direction.** Make an image rebuild deterministic and the venv self-contained, so it can't silently ship a dangling interpreter. **Root cause (panel-diagnosed):** the Dockerfile is single-stage and prunes nothing under `/root/.local`, yet the venv broke once and self-healed — the signature of **(a) a mutable base tag** (`FROM nousresearch/hermes-agent:v2026.7.1`, not a digest — the box has two base builds cached) drifting under **(b) a cached venv layer** (the venv `RUN` at `:67-76` sits _above_ the frequently-bumped `fluncle`/`claude` pins, so a pin bump like `#383` leaves it a cache hit — its build-time `from_pretrained` assertion at `:74` **never re-executes**). A base that drifts under a stale cached venv = "built fine yesterday, dead today."

**Concrete plan (all four; the sketched `uv venv --relocatable` is a NON-FIX — it rewrites entry-point shebangs, does not relocate the interpreter — drop it):**

- **Digest-pin the base:** `FROM nousresearch/hermes-agent@sha256:<digest>` (resolve the digest for `v2026.7.1`; bump deliberately). The actual durability fix — it removes the mutable substrate the cached venv sits on.
- **Relocate the interpreter into a stable baked path + patch-pin it:**
  ```dockerfile
  ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python
  RUN uv python install 3.11.15 \                 # PATCH-pinned, not floating 3.11
   && uv venv --python 3.11.15 --seed "${MUQ_VENV}" \
   && chmod -R a+rX /opt/uv-python
  ```
  Floating `3.11` re-resolving to a different build after a base `uv` bump is the most likely trigger; patch-pinning makes the symlink target deterministic.
- **Evict from `/root` (a latent bug this also fixes):** today `/opt/muq-venv/bin/python` symlinks into `/root/.local/...` (mode `700`, root-only). The non-root `hermes` cron user **cannot traverse `/root`** — embed works _only_ because the host timer runs it via `docker exec -u hermes` against an interpreter that happens to resolve today; `/opt/uv-python` + `a+rX` is the exact "cp out of `/root`" pattern the Dockerfile already applies to bun/box/fluncle (`:82-90,:96-117`) and removes the traversal fragility. Name it in the RFC — it's durability _and_ a permissions fix.
- **Make the import assertion run against the shipping bytes:** the cached-layer assertion is a no-op on pin bumps. Either `--no-cache` the venv stage, or rely on the Unit C runtime pre-smoke as the real backstop — it's the only check that runs against the actually-shipping image.

## 4. Unit C — Pre-smoke proves the engine (the keystone), cheaply and safely

**Direction.** Add an embed smoke to `rebuild-hermes.sh` pre-smoke so a broken embed engine fails pre-smoke and rolls back — but **matched to the failure mode and capped**, because the box is 7.6 GB RAM / 4 vCPU / **zero swap** with the live container capped at 4 GB, and a naive full MuQ forward (~2.85 GB, uncapped) during a rebuild can trip the OOM killer against the _live_ agent, and a hung forward would **wedge pin-watch** (it holds `flock` for the whole run; every later tick then no-ops silently).

**Concrete plan.**

- The smoke matches the actual `#383` break (a dangling interpreter symlink), cheap to catch:
  ```sh
  timeout 120 docker run --rm --memory=3g --memory-swap=3g "$NEW_IMAGE" sh -c \
    'test -e "$(readlink -f /opt/muq-venv/bin/python)" && /opt/muq-venv/bin/python -c "import torch, muq"' \
    || presmoke_fail "embed engine broken (interpreter/import)"
  ```
  ~2–3 s, <1 GB (treat a `timeout` as `presmoke_fail`). A full 1024-d forward is over-built for the bug it guards and is where the OOM/timeout risk lives — drop it.
- **Drop the analyze smoke** — the enrichment DSP is pure TS; the CI golden test (Unit F) covers it earlier and better; a box-arch end-to-end check isn't worth the pre-smoke weight.
- **Defense-in-depth:** add a small zram swap on the box (operator step) so a memory spike degrades instead of OOM-killing.
- **First-boot-after-ship trap:** when this PR first deploys, pin-watch runs the _new_ pre-smoke against the new image; a flaky first smoke would roll back to the _old_ (split-code, no-guard) image — the guard's first act could reject the fix that installs it. **So the first deploy is an attended operator `rebuild-hermes.sh --force`** (watch the smoke pass), then the hourly tick is trusted. _(Operator-confirmed.)_

## 5. Unit D — Pinned baked `yt-dlp` + collapse the `copywriting-fluncle` double-ship

- **`yt-dlp`:** its own **pinned** early layer, NOT the scripts COPY (it's a 40 MB binary, not in the repo, and must never be committed to public git):
  ```dockerfile
  RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/download/<PINNED>/yt-dlp_linux \
        -o /opt/hermes-scripts/yt-dlp && chmod 755 /opt/hermes-scripts/yt-dlp
  ```
  A separate layer is better cache hygiene (a `.sh` change shouldn't bust a 40 MB layer). **Watched pin (recommended):** `yt-dlp` is the one dep with a fast external breakage clock (it breaks when YouTube changes) and a stale one silently rots the _live_ `fluncle-capture` timer — so add a `WANT_YTDLP` to the pin-watch drift check. Caveat: confirm the `fluncle-maintenance` drift-check can express "watch a GitHub release tag" (it watches base/bun/fluncle/claude today) before scoring it trivial.
- **`copywriting-fluncle`:** drop the host-cp copy (`/opt/data/skills/...`); the baked `/opt/claude/skills/...` under `CLAUDE_CONFIG_DIR=/opt/claude` is the single source (verified the `claude -p` crons resolve it there). Kills the "ships twice" dual-maintenance hazard.

## 6. Unit E — Retire the gateway cron subsystem for automation → host systemd timers

**Direction.** Every automation cron becomes a repo-checked-in host `.timer`/`.service` pair, exactly like the four that already migrated (`capture`/`embed`/`healthcheck`/`pin-watch`). The provision script installs them; the schedule is git, not `state.db`; the gateway's cron feature goes unused for automation.

**What migrates (the ~11 still on the gateway, per `cron/README.md`):** `enrich`, `context-note`, `note`, `observation`, `backfill`, `social-capture`, `live`, `studio-clip`, `newsletter`, `render`, `backup` (+ any `artist*` sweep still gateway-scheduled). Already host timers: `capture`, `embed`, `healthcheck`, `pin-watch`.

**Concrete plan.**

- **One `.timer`/`.service` pair per job**, checked into `docs/agents/hermes/<job>-timer/` (the established layout), each modeled on `embed-timer/`:
  ```ini
  # <job>.service
  ExecStart=/usr/bin/docker exec -u hermes -e HOME=/opt/data/home hermes \
            bash /opt/hermes-scripts/<job>-sweep.sh          # baked path (Unit A), not /opt/data
  Type=oneshot
  TimeoutStartSec=<per-job>                                   # fast Worker-triggers ~120s; render/newsletter longer
  # + the modest root-docker-driving hardening the embed unit uses
  ```
  ```ini
  # <job>.timer
  OnBootSec=<staggered>          # spread simultaneous ticks so parallel claude -p jobs don't pile
  OnUnitActiveSec=<cadence>      # 5m/10m/30m/60m per the roster
  Persistent=true                # catch up a tick missed across a reboot
  ```
  `newsletter`'s weekly slot is timezone-aware and expressible directly: `OnCalendar=Fri 15:00 Europe/Amsterdam`.
- **Generate, don't hand-write eleven near-clones.** The units differ only in name/cadence/timeout, so drive them from one small table in the provision script (a loop that renders + `install`s + `enable --now`s each), or a single templated unit per cadence. Keep the rendered units in the repo for greppability + review.
- **The one real migration detail — the `/status` freshness signal.** The gateway runner wrote each job's output to `~/.hermes/cron/output/<name>/<ts>.md`, which the `fluncle-healthcheck` prober reads (its `AUTOMATION_CRONS` mirror). A host-timer sweep must keep writing that marker itself — `embed-sweep` already does; give the rest a tiny shared helper (append a one-line JSON marker to the output dir) so the prober is **unchanged**. (Alternative, if cleaner in practice: switch the prober to systemd's `ActiveEnterTimestamp`/`journalctl` per unit. Pick one; the marker keeps the blast radius smallest.)
- **Concurrency:** host timers run in **parallel** (vs. the gateway's serial runner) — a strict win for the latency-sensitive fast sweeps. Stagger `OnBootSec` and, if simultaneous `claude -p` jobs (`note`/`observation`/`newsletter`) ever contend, drop them in a shared `systemd` slice with a concurrency cap. Not a blocker; a knob.
- **Pilot one before the fan-out** (agent-orchestration): migrate `enrich` end-to-end first — install its timer, confirm it fires, the sweep runs from the baked path, the output marker lands, `/status` stays green, then `hermes cron delete` the gateway copy — before repeating for the rest. The four already-migrated timers are the proof the pattern holds.
- **Retire:** once all are host timers, `hermes cron list` is empty for automation; delete each gateway cron as its timer goes green (never both live at once — the sweeps are idempotent, but double-scheduling wastes ticks). The Discord chat agent (`gateway run`) is untouched.

**The reset boundary, documented as an explicit acceptance line (not a buried caveat):** _a reset restores **code** (baked, Unit A) + **schedule** (the host-timer units, installed by the provision script) + **secrets** (`fluncle-secrets-sync` from 1Password); the accumulated agent **state** — sessions, memories, kanban, cron output/run-history under the agent home + `state.db` — restores from the daily `backup-sweep`→R2 backup, whose restore **tooling is the one sanctioned follow-on** (out of this epic, but named)._

## 7. Unit F — Docs, runbooks, tests

- **Runbooks flip from "docker cp + hermes cron create" to "baked + host-timer, auto-deployed":** the per-cron sections of `docs/agents/hermes/cron/README.md` become host-timer install blocks (or the doc reframes around `*-timer/` as the canonical form + a table of cadences); `packages/skills/fluncle-hermes-operator/**` (the deploy model + the "ships twice" note goes away); the existing `*-timer/README.md` deploy sections repoint `ExecStart` at `/opt/hermes-scripts`; `docs/agents/hermes-agent.md` (the persistence model + the reset boundary + "no gateway automation crons"). Prune the vestigial `/opt/data/{scripts,skills}` copies on the box and drop them from the reset path.
- **Audit `/opt/data/skills` + `/opt/data/scripts` for any hand-cp'd code** beyond what the roster names — bake whatever's found; leave nothing hand-managed.
- **Tests:** a `rebuild-hermes.sh` pre-smoke self-test (the capped embed smoke runnable in a dry-run); the migrated crons verified live (the pilot + a `systemctl list-timers` acceptance); the enrichment DSP tests stay green **in place** (the skill stays baked; its 3 co-located `analyze-track.*.test.ts` files move only if the enrich-sweep path constant they lean on moves — keep them beside the source). `bun run --cwd apps/cli typecheck/build` unaffected (no CLI change).

## 8. Dropped — the CLI fold (rationale retained)

The operator floated folding `analyze-track` into the CLI so it auto-updates. **Baking the skill (Unit A) already delivers that** — the DSP rides the image, auto-updates from `main`, survives rebuild + re-provision — with zero product-surface change. So the fold buys durability nothing and is **not pursued.** Retained rationale, if it's ever revisited on product merits (not durability): it would be `fluncle admin tracks enrich <id> [--audio-file]` extending the existing `enrich` verb — **not** a new `analyze` (which isn't in the closed verb set, `docs/naming-conventions.md` §3, and would mint a second name for `enrich`) — and the DSP would go in a shared `packages/` module, because `packages/video/src/pipeline/{fft,audio-curves,analyze-audio}.ts` already holds a second copy of the same kernel and a CLI-local copy would be the third. Its own RFC if ever taken up; nothing in this epic depends on it.

## Sequencing & ownership

- **The durability spine (one PR, or A→E in two): Unit A + Unit E** — bake the code to `/opt/hermes-scripts` + the skill; migrate every automation cron to a repo-checked-in host timer reading the baked path; prune the vestigial volume copies. This is the "no stale scripts, schedule survives a reset" delivery. Pilot `enrich` before fanning out the rest.
- **The venv-safety pair (one PR): Unit B + Unit C** — digest-pin + durable venv + the capped pre-smoke guard. Independent of A/E; can land first (it fixes the more acute latent risk).
- **With A: Unit D** (yt-dlp own layer + copywriting collapse) — so a re-provision has `yt-dlp`.
- **Unit F** trails each.
- **The one attended step:** the operator runs the first `rebuild-hermes.sh --force` on rave-02 (watches the new embed pre-smoke pass) — this deploys the image-side change (A/B/C/D) and avoids the first-boot rollback trap. _(Operator-confirmed.)_ The host-timer install (E) is `sudo install … && systemctl enable --now`, run by the provision path / operator.
- **Deploy discipline:** normal repo PRs; merge to `main` is the deploy trigger (pin-watch, hourly). Space merges (build coalescing).

## Decisions — resolved in the riff, with two small confirmations left

- ✅ **Retire the gateway cron subsystem for automation** → repo-checked-in host systemd timers (schedule = code). _(Operator-confirmed — this reshaped Unit E and deleted the boot-sync/cont-init from Unit A.)_
- ✅ **Venv approach:** digest-pin the base + `UV_PYTHON_INSTALL_DIR=/opt/uv-python` + patch-pin `3.11.15` + evict-from-`/root`. _(Operator-confirmed; the builder proves it by rebuilding + `import torch,muq` against the shipping image.)_
- ✅ **Attended first rebuild:** operator runs `rebuild-hermes.sh --force` once the image change lands. _(Operator-confirmed.)_
- ✅ **CLI fold:** dropped (DSP goes durable via the baked skill). _(Operator-confirmed.)_
- ▫️ **yt-dlp watched pin (Unit D):** recommend yes; confirm the maintenance drift-check can express a GitHub-release-tag watch before scoring it trivial.
- ▫️ **`/status` freshness signal (Unit E):** keep-the-output-marker (prober unchanged) vs. switch the prober to systemd timestamps — builder's call at implementation; default to the marker.

## Acceptance criteria

- Merge to `main` → pin-watch rebuild → every (filtered) sweep script, the enrichment skill, `embed-track.py`, and `yt-dlp` present in the new image under `/opt/hermes-scripts` + `/opt/hermes-skills`; **no `docker cp` and no `/opt/data/scripts` copy needed** (host timers exec from the baked path).
- `systemctl list-timers` on the box shows a `fluncle-<job>.timer` for **every** automation cron; `hermes cron list` shows **no** automation crons; the Discord chat agent still runs. A pilot job (`enrich`) is verified end-to-end (timer fires → sweep runs from baked path → output marker written → `/status` green).
- A simulated bare re-provision (empty `/home/admin/.hermes` + secrets re-injected + `provision-*.sh` run) boots a box whose schedule is present (the timers enabled) with **no** manual `hermes cron create` — schedule restored, not just files. The reset boundary (code+schedule+secrets vs. accumulated state) is documented.
- A throwaway container from the new image passes the **capped** embed smoke (`--memory=3g`, `timeout 120`); a **deliberately** dangled interpreter symlink fails pre-smoke and does **not** swap (drill it, like the existing rollback drill).
- `import torch, muq` succeeds in the rebuilt image; `readlink -f /opt/muq-venv/bin/python` resolves inside `/opt/uv-python` (a baked layer, not `/root`); the base is digest-pinned.
- `copywriting-fluncle` exists once (baked); the host copy + its "ships twice" note are gone; `/opt/data/{scripts,skills}` are vestigial-free (pruned + dropped from the reset path).
- Docs contain no "docker cp" / "hermes cron create" deploy instruction for automation; the pre-smoke self-test is green; `apps/cli` typecheck/build pass; the enrichment DSP tests stay green.

## Risks & open questions

- **Pre-smoke OOM/wedge** (the biggest operational risk) — mitigated by the _cheap, memory-capped, timeout-wrapped_ smoke (Unit C); a full forward is explicitly rejected.
- **Parallel host-timer execution** (vs. the gateway's serial runner) could contend on simultaneous `claude -p` jobs — mitigated by staggered `OnBootSec` and, if needed, a concurrency-capped `systemd` slice. A knob, not a blocker.
- **`/status` freshness regression** if a migrated sweep stops writing its output marker — mitigated by the shared marker helper (or the systemd-timestamp prober switch); part of Unit E acceptance.
- **Digest-pinning the base adds a manual bump** (pin-watch doesn't watch `FROM`, by design) — acceptable: base bumps stay a deliberate operator brake, and that's the point (a mutable base under a cached venv is the bug).
- **Double-scheduling during the migration window** (a gateway cron + its new timer both live) — mitigated by delete-as-you-go (green the timer, then `hermes cron delete`); the sweeps are idempotent so a transient overlap only wastes ticks.
- **No `cont-init`/s6 change at all** — a _removed_ risk, called out because the earlier draft carried it: retiring the gateway cron subsystem deleted both reasons to touch the container init (boot-sync projection, cron reconcile).

## Appendix — verifications & sources (panel + riff, live)

- **The cron mechanism** (riff, `cron/README.md` + the `*-timer/` units): every automation job is `--no-agent --script … --deliver local` (output to a file, **not** Discord) — no gateway-native feature is used; `jobs.json = []`. `capture`/`embed`/`healthcheck`/`pin-watch` are **already** host systemd timers (`docs/agents/hermes/{capture,embed,healthcheck}-timer/`, `pin-watch/`); `embed-timer` documents itself as _"decoupled from the latency-sensitive gateway cron runner."_ The host-timer pattern is `docker exec -u hermes -e HOME=/opt/data/home hermes bash /opt/data/scripts/<job>-sweep.sh` + `Persistent=true`; `embed-sweep` writes its `/status` marker to `~/.hermes/cron/output/` itself.
- **Embed is alive** (Docker + infra, live): current image `fluncle-hermes:v2026.07.08-73e5c1a`; `/opt/muq-venv/bin/python -c "import torch,muq"` → `2.12.1+cpu`; weights `/opt/muq-cache` = 1.3 G; `readlink -f` resolves. The break self-healed on an unchanged Dockerfile.
- **Venv fragility root** (Docker + infra): single-stage Dockerfile, nothing prunes `/root/.local`; venv `RUN :67-76` is above the `fluncle`/`claude` pins → cache-hit on pin bumps; base `FROM` is a mutable tag (2 base builds cached); interpreter symlinks into `/root` (mode 700). `uv venv --relocatable` does not relocate the interpreter (uv docs).
- **Box budget** (infra): 7.6 GB RAM, 4 vCPU, `Swap: 0B`; live container `--memory=4g`; MuQ peaks ~2.85 GB (Dockerfile comment).
- **pin-watch pre-smoke has no MuQ** (all): `rebuild-hermes.sh:137-147` checks only `fluncle version`, `claude --version`, an enrich `--queue` read, publish-refusal.
- **CLI-fold facts (retained rationale)** (CLI-DX): `docs/naming-conventions.md` §3 closed verb set excludes `analyze`; the op maps to the existing `enrich`. `analyze-track.ts` importers today = its 3 co-located tests + `enrich-sweep.ts`; `packages/video/src/pipeline/{fft,audio-curves,analyze-audio}.ts` is a second copy of the same kernel.
- **copywriting double-ship** (Docker + infra): `/opt/claude/skills/...` (baked) + `/opt/data/skills/...` (cp'd) both live.
- **Mount / manual-cp surface** (session audit): `-v /home/admin/.hermes:/opt/data` bind; 33 files in `/opt/data/scripts` + `analyze-track.ts` in `/opt/data/skills`; `docker cp` + `hermes cron create` instructions across `cron/README.md` + each `*-timer/README.md`.

## Paste-ready /goal

```
Execute docs/hermes-durable-deploy-rfc.md (Final). Make the rave-02 Hermes box's code ride the image (auto-update from main via pin-watch, survive rebuild + re-provision), make the cron SCHEDULE code (retire the gateway cron subsystem for automation → repo-checked-in host systemd timers), and make a rebuild unable to silently ship a broken embed engine. NOT an outage fix — embed self-healed; this kills latent fragility + the guard hole + the schedule-lives-in-mutable-state hole. Ship as PRs:

(A + E, the durability spine) COPY docs/agents/hermes/scripts/ (FILTERED — no *.test.ts / provision / clip-drip) to /opt/hermes-scripts + the fluncle-track-enrichment skill (mirror Dockerfile:183) to /opt/hermes-skills; chmod a+rX. NO cont-init/boot-sync — consumers read the baked path directly. Migrate EVERY remaining gateway automation cron (enrich, context-note, note, observation, backfill, social-capture, live, studio-clip, newsletter, render, backup, artist*) to a repo-checked-in host .timer/.service pair under docs/agents/hermes/<job>-timer/, modeled on embed-timer/, ExecStart=docker exec -u hermes -e HOME=/opt/data/home hermes bash /opt/hermes-scripts/<job>-sweep.sh, Persistent=true, staggered OnBootSec, cadence per cron/README.md (newsletter: OnCalendar=Fri 15:00 Europe/Amsterdam). Generate the units from one table in the provision script; keep the rendered units in the repo. Preserve the /status freshness signal (each sweep writes its ~/.hermes/cron/output marker; embed already does — give the rest a shared helper). Repoint enrich-sweep's analyze-script default at the baked /opt/hermes-skills path (retire the /opt/data/skills constant + its test pin). PILOT enrich end-to-end (timer fires → runs from baked path → marker written → /status green → hermes cron delete the gateway copy) before fanning out. Prune the vestigial /opt/data/{scripts,skills} copies.

(B + C, the venv-safety pair) DIGEST-pin the base FROM ...@sha256:; UV_PYTHON_INSTALL_DIR=/opt/uv-python + patch-pin `uv python install 3.11.15` + chmod a+rX (evict the interpreter from /root/700 — same pattern as bun/box/fluncle); make the import assertion run against shipping bytes. Add a CHEAP capped embed smoke to rebuild-hermes.sh pre-smoke — timeout 120 docker run --memory=3g --memory-swap=3g … 'test -e "$(readlink -f /opt/muq-venv/bin/python)" && python -c "import torch,muq"' → presmoke_fail (NOT a full forward — OOM risk on the 7.6GB/zero-swap box). Drop the analyze smoke.

(D) bake a PINNED yt-dlp via its own RUN curl layer (never a repo commit; add a watched WANT_YTDLP pin); drop the copywriting-fluncle host-cp (baked is the keeper).

(F) flip every runbook from docker-cp/hermes-cron-create to baked+host-timer; document the reset boundary (code+schedule+secrets restore; state.db accumulated-state restore tooling is the one follow-on); audit for other hand-cp'd code; add the pre-smoke self-test + the systemctl list-timers acceptance.

Operator-gated (external): the ONE attended `rebuild-hermes.sh --force` first deploy (watch the embed smoke — avoids the first-boot rollback trap). DROPPED: the CLI fold (the baked skill already makes the DSP durable). Verify live over ssh -p 2222 admin@fluncle-rave-02. Tests + docs are done, not follow-ups.
```
