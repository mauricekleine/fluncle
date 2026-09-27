# fluncle-label-outliers-timer — the nightly label-outlier review list on a host timer

The rave-02 host trigger for the `--no-agent` **label-outlier** sweep. Once a night it scores every album (and every label-less single) of embedded catalogue tracks against the rest of its own label, keeps the ones that sound far from it, and replaces the review list behind `/admin/label-outliers`. The statistic, the flag rule, the measured precision, and the handoff to the catalogue-prune skill are written up in [docs/catalogue-crawler.md § Label outliers](../../../catalogue-crawler.md#label-outliers-the-review-list-for-what-the-gate-let-through); this page is the box wiring. Zero LLM tokens.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — [`../scripts/label-outliers-sweep.sh`](../scripts/label-outliers-sweep.sh) → [`../scripts/label-outliers-sweep.ts`](../scripts/label-outliers-sweep.ts) (IO: the replica read, the admitted write, the Discord summary) and [`../scripts/label-outliers.ts`](../scripts/label-outliers.ts) (the pure scoring) — riding the image and auto-updating from `main` via pin-watch.

## One tick

1. **Take the device-mirror lock** (`~/.device-mirror.lock`, the same `mkdir` lock `fluncle-device-mirror` holds while it syncs), waiting up to 20 minutes for a running publish to finish. A lock untouched for longer than its 15-minute stale window is taken over, exactly as the device mirror would.
2. **Read the replica read-only** — `~/device-mirror/source-replica.db`, the full local copy of the main database the device mirror keeps in sync — and score it: one streaming pass for the catalogue centroid, then one indexed read per label. The lock is released as soon as scoring finishes, so a device-mirror tick waits seconds, not the whole run.
3. **Write once, admitted.** The scored list goes to `PUT /api/v1/admin/label-outliers` (`record_label_outliers`, agent tier) inside its own `database-admission-runner.sh phase fluncle-label-outliers` window, so the sweep never holds the database lane while it waits on the replica lock. The Worker replaces the stored list, keeps dismissals, and returns what became newly visible.
4. **Discord only when something is new.** One summary through `DISCORD_ALERT_WEBHOOK` (already in the container env) naming up to eight new outliers and linking the board. An unchanged list posts nothing.

The last line of stdout is the `/status` marker summary (`checked` = units scored, `produced` = units posted, `flagged`, `newlyFlagged`, `replicaSyncedAt`). Two non-failure skips set `payloadStarted: false` so the 06:30 retry slot runs the payload: `reason: "replica_busy"` (the device mirror held its lock for the whole wait) and `reason: "admission_<yield>"` (the write phase yielded). A missing replica is a failure (`ok: false`, `reason: "replica_missing"`) because it means the device mirror is not running.

**No new secret.** The sweep needs `FLUNCLE_API_TOKEN` (the box's agent token, from the shared `~/.fluncle-secrets.env`) and `DISCORD_ALERT_WEBHOOK`, both already present. It reads the replica file the device mirror maintains; it does not open its own connection to the hosted database.

## Activation (OPERATOR-GATED — the repo half ships; the box enable does not)

The repo carries the scripts, the units, this doc, and the `/status` registration (`cron.label-outliers` in `@fluncle/registry` + the `fluncle-healthcheck` prober). The Worker half (the three ops, the two tables, the board) ships with the normal deploy, and its migration applies in the Cloudflare build. After the merge has deployed and pin-watch has baked the new scripts into the image, install the timer on the rave-02 HOST, from an up-to-date repo checkout, as root:

```bash
sudo bash docs/agents/hermes/install-host-timers.sh --refresh-unit fluncle-label-outliers.service --refresh-unit fluncle-label-outliers.timer
sudo systemctl enable --now fluncle-label-outliers.timer

sudo systemctl start fluncle-label-outliers.service               # one tick now; safe, the write replaces the list
journalctl -u fluncle-label-outliers.service -n 40 --no-pager      # expect { "ok": true, "flagged": …, "newlyFlagged": … }
systemctl list-timers fluncle-label-outliers.timer
```

The first run announces the whole list as new, once. After it, open `/admin/label-outliers`, select the rows you already know are fine (the low-similarity triage's drum & bass verdicts among them), and mark them fine in one go; they stay off the list until their tracks change.

(A full re-provision restores the timer automatically — [`../install-host-timers.sh`](../install-host-timers.sh) installs every `*-timer/` directory.)
