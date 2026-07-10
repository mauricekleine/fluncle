# fluncle-triage-timer — the submission-triage pre-chew sweep on a host timer

The rave-02 host trigger for the HYBRID `--no-agent` **submission-triage** sweep. `fluncle-triage` pre-chews a pending crew submission before the operator gets to it: it dedupes the banger against the archive by Spotify id, reads a cheap DnB plausibility from the metadata, and writes an advisory one-line verdict (a "looks like a find / already logged / not our lane" read) via the agent-tier `triage_submission` op. That verdict then rides the submission's row in the `/admin` attention queue, so a submitted banger arrives already assessed. Deterministic everywhere (the queue read, the archive dedupe, the write-back) except one `claude -p` verdict per submission. **Approve/reject authority never moves — the sweep only does legwork; the operator still decides.**

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/triage-sweep.sh`](../scripts/triage-sweep.sh) → [`../scripts/triage-sweep.ts`](../scripts/triage-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch (Unit A). The `.sh` sources the SHARED `${HOME}/.fluncle-secrets.env` (the same `claude -p` OAuth token note-sweep uses — **no new secret**) and runs the bun orchestrator.

## The decision logic (per pending, un-triaged submission)

1. **Dedupe** — a submission's `spotifyTrackId` IS the archive's `track_id` (`approveSubmission` keys off exactly that), so `fluncle admin tracks get <spotifyTrackId>` resolving a finding means the banger is **already logged**. A `not_found` means it is new.
2. **Assess** — `assessSubmission(...)` (pure, unit-tested in [`../scripts/triage-sweep.test.ts`](../scripts/triage-sweep.test.ts)) scores a cheap DnB plausibility from the title/album keywords + the dedupe result: `likely` (a DnB-positive keyword, or a known archive artist), `unlikely` (an off-lane genre word and nothing positive), or `unclear` (no genre tell — the honest default, since most DnB carries none).
3. **Author** — ONE `claude -p` call (subscription auth, read-only tools, the `copywriting-fluncle` skill) phrases the deterministic lean as one voiced line.
4. **Deliver** — `fluncle admin submissions triage <id> --verdict-file <tmp>` posts it; the Worker length-gates the line (advisory only, no public voice gate) and stores it onto the **pending** submission. A 409 (already reviewed between the queue read and now) is a clean no-op.

`BATCH_CAP=3` per tick; the queue is the durable worklist. The sweep is fill-first (it acts on submissions with no verdict yet).

## Why a host timer + the /status marker

Every automation cron runs off repo-checked-in host timers so the SCHEDULE is code. Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-triage`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper.

## Activation (OPERATOR-GATED — the repo half ships; the box enable does not)

The repo carries the scripts, the timer units, and this doc. Enabling it on the box is one manual pass (no new secret — the shared `${HOME}/.fluncle-secrets.env` and the agent token are already present):

```bash
# On the rave-02 HOST, from a repo checkout, as root:
sudo install -m 0644 docs/agents/hermes/triage-timer/fluncle-triage.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/triage-timer/fluncle-triage.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-triage.timer

# Verify one tick now.
sudo systemctl start fluncle-triage.service            # one tick
journalctl -u fluncle-triage.service -n 40 --no-pager  # expect a { "ok": true, … } summary line
systemctl list-timers fluncle-triage.timer
```

(A full re-provision restores it automatically — [`../install-host-timers.sh`](../install-host-timers.sh) globs every `*-timer/` dir, so this timer is installed + enabled alongside the others; the manual pass above is only for the FIRST enable on an already-running box.)

**Optional — add it to /status monitoring.** To have the `fluncle-healthcheck` prober report `cron.triage`, add one row to `CRON_SPECS` in [`../scripts/fluncle-healthcheck.ts`](../scripts/fluncle-healthcheck.ts):

```ts
{ cadenceMs: 15 * 60_000, match: "triage", service: "cron.triage" },
```

then rebake the image (pin-watch will roll it out). Left out by default so `/status` never advertises a cron that is not yet enabled.
