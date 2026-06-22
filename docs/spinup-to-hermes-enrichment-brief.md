# Enrichment: Spinup → Hermes migration (brief)

**Status: scoping, not built.** Move the track-enrichment compute (BPM / musical key / `features_json`) off Spinup and onto the Hermes box as a `--no-agent` cron, then decommission the Spinup enrichment agent. This is the detailed scoping of the one line the automation brief left open ("audio analysis — ffmpeg + JS DSP, once ffmpeg is in its image — replacing Spinup", [docs/hermes-automation-brief.md](./hermes-automation-brief.md)). Per `AGENTS.md`, a `*-brief.md` is non-canonical planning; the codebase and canon win on any conflict, and this file gets deleted once the migration ships.

## Why

Spinup is the last external compute dependency in the pipeline. Enrichment is deterministic, light (ffmpeg + DSP on a 30s preview), and already self-contained — so it fits the Hermes box (2 vCPU / 4 GB; only video render is too heavy to move). Folding it into Hermes makes the box the single automation home, removes a vendor SDK + a set of secrets, and lets enrichment run as a cheap, frequent, token-free cron.

## The core flip

- **Today:** the Worker calls `triggerEnrichment` → `runs.create` on the **Spinup enrichment agent**, which runs the `fluncle-track-enrichment` skill (resolves the preview, ffmpeg-analyzes it) and writes back via the CLI. Fired on-add (the `/admin` board) and by the `enrich --all` sweep.
- **After:** a **Hermes `--no-agent` cron** runs the analysis itself — drains the enrich-queue, runs `analyze-track.ts` per finding, and writes back via the CLI. The Worker stops triggering Spinup entirely; there is no on-add push (a new find is caught on the next cron tick).

## Decisions (locked)

- **`--no-agent --script`, not an agent cron.** Enrichment is pure compute (get → analyze → update) with no authoring, so no LLM is involved — zero tokens per tick, fully deterministic. (Contrast: the observation cron needs the agent because it _writes_ copy.)
- **Every ~5 minutes.** Because it burns no tokens and is a cheap queue-read that no-ops when the queue is empty, it runs far more often than the hourly agent crons — so a new find enriches within minutes, not within the hour. (Drops the fast on-add path; the small latency is the accepted "everything is a cron" trade.)
- **Skill installed the `copywriting-fluncle` way** — into the host-mounted `~/.hermes/skills/` (→ `/opt/data/skills/`), updatable without an image rebuild (procedure: [hermes-agent.md](./agents/hermes-agent.md) § Voice). The skill is what puts `scripts/analyze-track.ts` on the box.

## The pieces

1. **Hermes image** (`docs/agents/hermes/Dockerfile`): add **`ffmpeg`** (decodes the preview) and **`bun`** (the skill is `#!/usr/bin/env bun`, zero npm deps — node alone will not run it). Rebuild + restart. This is the only image change.
2. **Install `fluncle-track-enrichment`** on the box (mounted skills dir), giving the box `/opt/data/skills/fluncle-track-enrichment/scripts/analyze-track.ts`.
3. **The cron job** — a `--no-agent --script` job on a ~5m interval. The cron runner executes `.sh`/`.bash` via bash (anything else via Python), so the job is a small **bash wrapper** that shells to a **bun orchestrator** for the JSON work. The orchestrator loop, per finding in the enrich-queue:
   - `fluncle admin tracks enrich-queue --json` → the worklist (`status=queue`: pending ∪ failed ∪ stale processing).
   - `fluncle tracks get <id|logId> --json` → `artists`, `title`, `isrc`, `trackId`.
   - `bun /opt/data/skills/fluncle-track-enrichment/scripts/analyze-track.ts --artist <a> --title <t> [--isrc <i>]` → the analysis JSON (BPM, `key` or `null`, `features`). The skill resolves the preview itself (Deezer/iTunes), so no preview URL is passed.
   - `fluncle admin tracks update <trackId> --bpm <bpm> [--key "<key>"] --features '<json>' --status done` — `--key` only when non-null (respect the skill's confidence gate); `--status failed` when no preview is available.
   - Idempotent by construction: the queue is `status=queue`, so a `done` finding is already out of it; re-running never double-writes. No-op (fast exit) when the queue is empty.
     The wrapper + orchestrator are version-controlled in the repo (alongside the cron config under `docs/agents/hermes/`) and deployed to `~/.hermes/scripts/`, same canonical-repo / box-is-a-target model as everything else.
4. **Worker cleanup** (one PR): remove `triggerEnrichment` + the on-add call (`apps/web/src/routes/admin/index.tsx`), the `enrich --all` / `enrich-sweep` Spinup re-fire (`apps/web/src/routes/api/admin/enrich-sweep.ts`), `apps/web/src/lib/server/spinup.ts`, the `@getspinup/sdk` dependency, and the `SPINUP_ENRICH_AGENT_ID` / `SPINUP_ENRICH_AGENT_KEY` secrets. The `admin tracks update` write-back path stays (it is the cron's writeback). Keep the `/admin` board's manual "Run enrichment" affordance, repointed to mark a finding `queue` (the cron does the rest) rather than firing Spinup. Coverage + the admin tests update with the removal.
5. **Decommission Spinup** (operator-side): delete the enrichment agent on Spinup and its keys once the Hermes cron is proven.
6. **Docs**: update `track-lifecycle.md` Phase 2 (enrichment now runs on Hermes, not Spinup), `docs/agents/enrichment-agent.md` (the agent bootstrap → the cron), the automation brief's "audio analysis" line, and add the enrichment cron + the ffmpeg/bun image lever to `hermes-agent.md`.

## Build order

1. **Image**: add ffmpeg + bun to the Dockerfile, rebuild, restart, verify both present (`docker exec hermes sh -c "ffmpeg -version; bun --version"`).
2. **Skill**: install `fluncle-track-enrichment` on the box; smoke-test `bun .../analyze-track.ts --artist … --title …` on one finding's preview → confirm a sane BPM/key/features JSON.
3. **Cron script**: write + deploy the wrapper + orchestrator; run it once by hand against the live enrich-queue (a real finding) → confirm the writeback lands and the finding leaves the queue.
4. **Schedule** the `--no-agent` cron at ~5m; watch a couple of ticks (and a deliberate new add) drain to `done`.
5. **Worker cleanup PR** (removes Spinup trigger + SDK + secrets) — merge after the cron is proven, so enrichment never has a gap.
6. **Decommission** the Spinup agent + keys.

## Gotchas

- **bun, not just node.** The box has node/npx but the skill's shebang is bun — without it the analysis silently fails as a missing interpreter. Add bun in step 1.
- **Cron script language.** The `--no-agent --script` runner uses bash for `.sh`/`.bash` and **Python for everything else** — so the job entry is a `.sh` wrapper that calls `bun` for the actual orchestration, not a bare `.ts`.
- **The stale Spinup instructions translate almost verbatim** (get → analyze → update, key honesty, one-per-run, no-preview → `failed`). The only refresh is the post-#88 command names: `track get` → `tracks get`, `admin track update` → `admin tracks update` (plural admin group, Convention B).
- **Order the cutover so there's no gap**: ship the Hermes cron and prove it _before_ the Worker-cleanup PR removes the Spinup trigger.
- **Image rebuild = brief chat-bot downtime** on restart; expected.

## Sequencing vs other work

Slot after the rate-limiting hardening. Independent of it (different surfaces), so it can also run in parallel if desired.
