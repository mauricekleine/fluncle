# fluncle-verify-captures-timer — the capture-verification backfill on a host timer

The rave-02 host trigger for the `--no-agent` **capture-verification** backfill. `fluncle-verify-captures` is the HISTORIC half of the verification gate ([docs/the-ear.md](../../../the-ear.md) § Wrong audio): the capture sweep fingerprint-verifies every **new** download at ingest, and this sweep walks every capture that landed **before** the gate existed (~590 rows: findings + catalogue) and gives each the same check — the captured bytes, Chromaprint-matched against the track's ISRC-resolved official 30s preview, the one reference that is the right recording by construction.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/verify-captures.sh`](../scripts/verify-captures.sh) → [`../scripts/verify-captures.ts`](../scripts/verify-captures.ts), sharing [`../scripts/fingerprint-match.ts`](../scripts/fingerprint-match.ts) with the capture sweep's ingest gate so the two matchers cannot drift) — riding the image and auto-updating from `main` via pin-watch.

## The model: the box measures, the Worker routes

Per row the box does one private-R2 GET (the captured bytes — the same read + creds `embed-batch.ts` uses), one public `/api/preview` fetch, two `fpcalc -raw -json` runs, and one sliding-window bit-error match — then reports a plain verdict (`match` | `mismatch` | `no-preview`) through the agent-tier `verify_capture` op. The **Worker owns the doctrine** (`apps/web/src/lib/server/catalogue.ts`):

- `match` → stamp `capture_verification = 'preview-match'`.
- `no-preview` → stamp `'unverified'` — the honest abstain; the track has no reference to check against.
- `mismatch` on a **CATALOGUE** row → the wrong-audio quarantine rewind (vector dropped, re-queued for a fresh capture, the poisoned sha remembered in `source_audio_rejected`).
- `mismatch` on a **FINDING** → stamp `'mismatch'` only and raise the `capture-suspect` `/admin` attention item. **A machine never rewinds a public finding** — the operator auditions and rules with `flag_wrong_audio` (or `fluncle admin catalogue flag-wrong-audio <trackId>`).

**Resumable by construction.** The worklist is `capture_verification IS NULL`; a verdict stamps the column, so a verified row leaves the set — re-running after a crash drains what is left, a stamped row is never re-verified, and a drained backlog makes the tick one empty read. Bounded per tick (`FLUNCLE_VERIFY_BATCH`, default 20).

**It degrades honestly without fpcalc.** The binary (`libchromaprint-tools`) joins the Hermes image in the same PR, but the box needs a **rebake** to pick it up. Until then the tick probes for it, reports `fpcalc_missing`, and stamps **nothing** — rows stay queued rather than being wrongly marked, and nothing crashes. So the timer is safe to enable before the rebake; it simply idles until the image carries the binary.

- `FLUNCLE_VERIFY_BATCH` (default `20`) — rows per tick.
- `FLUNCLE_VERIFY_MAX_BER` (default `0.20`) — the bit-error threshold (the reasoning lives on `DEFAULT_MAX_BER` in `fingerprint-match.ts`).

## Why a host timer + the /status marker

Every automation cron runs off repo-checked-in host timers so the SCHEDULE is code. Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-verify-captures`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper. `cron.verify-captures` is registered in `@fluncle/registry`, so it lights up `/status` the moment the timer runs.

## Activation (OPERATOR-GATED — the repo half ships; the box enable does not)

Order matters only in that the **rebake comes first** if you want the first tick to do real work (pin-watch rebakes on the merged Dockerfile change; a manual rebake works too — the fluncle-hermes-operator skill). No new secret: both ops are AGENT tier, and the R2 read uses the private-bucket token capture/embed already hold.

```bash
# On the rave-02 HOST, from a repo checkout, as root:
sudo install -m 0644 docs/agents/hermes/verify-captures-timer/fluncle-verify-captures.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/verify-captures-timer/fluncle-verify-captures.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-verify-captures.timer

# Verify one tick now.
sudo systemctl start fluncle-verify-captures.service
journalctl -u fluncle-verify-captures.service -n 40 --no-pager
# expect { "ok": true, "verified": …, "matched": …, … } — or { "ok": true, "reason": "fpcalc_missing" } pre-rebake
systemctl list-timers fluncle-verify-captures.timer
```

(A full re-provision restores it automatically — [`../install-host-timers.sh`](../install-host-timers.sh) globs every `*-timer/` dir; the manual pass above is only for the FIRST enable on an already-running box.)

Check on it any time:

```bash
fluncle admin catalogue verify --queue          # what is still unverified
fluncle admin queue                             # any capture-suspect rows land on the attention queue
```
