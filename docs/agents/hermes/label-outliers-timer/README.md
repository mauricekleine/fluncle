# fluncle-label-outliers-timer — the nightly label-outlier review list on a host timer

The rave-02 host trigger for the `--no-agent` **label-outlier** sweep. Once a night it scores every album (and every label-less single) of embedded catalogue tracks against the rest of its own label, keeps the ones that sound far from it, and replaces the review list behind `/admin/label-outliers`. The statistic, the flag rule, the measured precision, and the handoff to the catalogue-prune skill are written up in [docs/catalogue-crawler.md § Label outliers](../../../catalogue-crawler.md#label-outliers-the-review-list-for-what-the-gate-let-through); this page is the box wiring. Zero LLM tokens.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — [`../scripts/label-outliers-sweep.sh`](../scripts/label-outliers-sweep.sh) → [`../scripts/label-outliers-sweep.ts`](../scripts/label-outliers-sweep.ts) (IO: the replica read, the admitted write, the Discord summary) and [`../scripts/label-outliers.ts`](../scripts/label-outliers.ts) (the pure scoring) — riding the image and auto-updating from `main` via pin-watch.

## One tick

1. **Read the device mirror's scoring export, never the replica.** The device mirror is the only owner of its replica (`~/device-mirror/source-replica.db`): it syncs, checkpoints, and rebuilds it inside its own lock. After a successful publish, still inside that lock, the mirror writes a small export of exactly what this sweep scores (embedded catalogue tracks, their vectors, their artist credits, the albums' Discogs styles, and an `exported_at` stamp) to `~/device-mirror/label-outliers-inputs.db`, by writing a temporary file and atomically renaming it into place. It refreshes the export only when it is missing or older than 20 hours, so this costs one hourly tick a day about 0.6 s (measured on a prod-shaped 2.2 GB replica: 50k vectors, a 254 MB export). The copy runs in a child process under a 120 s budget: past it the child is killed, its temporary removed, and the summary records `scoringExport.status: "timeout"`. Every refresh first deletes any `label-outliers-inputs.db.tmp-*` an interrupted export left behind. A failure or timeout is logged and recorded in the mirror's summary; because the export runs after the cutover, it can never delay or fail a publish. The sweep takes no lock and opens no replica, so it cannot slow, block, or skip a mirror tick. If the export is missing, it fails loudly (`reason: "scoring_export_missing"`); if its stamp is older than 36 hours (the mirror has not managed a sync-plus-export for a day and a half), it fails loudly (`reason: "scoring_export_stale"`). Either way it writes nothing.
2. **Score the export** — one streaming pass for the catalogue centroid, then one indexed read per label — in about 1.7 s.
3. **Refuse a broken corpus.** Fewer than 10,000 usable vectors, or fewer than 95% of the embedded catalogue rows carrying a usable (right-size, finite, non-zero) vector, fails the run loudly (`reason: "corpus_below_floor"`) and writes nothing. More than 2,000 flagged units fails it the same way (`reason: "too_many_outliers"`): a partial list is never posted. The Worker enforces the same rules again: it refuses a posted list that repeats a unit id or is shorter than its declared total, a run that scored nothing, and a run that scored fewer than 80% of the archive's live embedded catalogue tracks (a bound that follows a legitimate purge down the next night).
4. **Write, admitted.** The complete list goes to `PUT /api/v1/admin/label-outliers` (`record_label_outliers`, agent tier) inside its own `database-admission-runner.sh phase fluncle-label-outliers` window. The Worker replaces the stored list, keeps dismissals, and returns every unit that is visible and not yet announced.
5. **Alert until acknowledged.** When anything is pending, one Discord summary goes through `DISCORD_ALERT_WEBHOOK` (already in the container env) naming up to eight of them and linking the board. Only after the post lands does the sweep call `PUT /api/v1/admin/label-outliers/alerts` (`acknowledge_label_outlier_alerts`, agent tier, its own admitted phase), which stamps `alerted_at` for each unit at the fingerprint that was announced, so a unit whose tracks changed between the post and the acknowledgement stays pending. A lost response, a failed post, or a failed acknowledgement leaves the units pending, so the next run announces them again: at least once, never silently dropped. A unit whose tracks change is announced again. Nothing pending posts nothing.

The last line of stdout is the `/status` marker summary (`checked` = units scored, `produced` = units posted, `embeddedTracks`, `tracksScored`, `flagged`, `pendingAlerts`, `notified`, `alertAcknowledged`, `replicaSyncedAt`). An admission yield sets `payloadStarted: false` (`reason: "admission_<yield>"`) so the 06:30 retry slot runs the payload.

**No new secret.** The sweep needs `FLUNCLE_API_TOKEN` (the box's agent token, from the shared `~/.fluncle-secrets.env`) and `DISCORD_ALERT_WEBHOOK`, both already present. It reads the export file the device mirror writes; it opens no connection to the hosted database and never touches the mirror's replica or lock.

## Activation (OPERATOR-GATED — the repo half ships; the box enable does not)

The repo carries the scripts, the units, this doc, and the `/status` registration (`cron.label-outliers` in `@fluncle/registry` + the `fluncle-healthcheck` prober). The Worker half (the three ops, the two tables, the board) ships with the normal deploy, and its migration applies in the Cloudflare build. After the merge has deployed and pin-watch has baked the new scripts into the image, install the timer on the rave-02 HOST, from an up-to-date repo checkout, as root:

```bash
sudo bash docs/agents/hermes/install-host-timers.sh --refresh-unit fluncle-label-outliers.service --refresh-unit fluncle-label-outliers.timer
sudo systemctl enable --now fluncle-label-outliers.timer

sudo systemctl start fluncle-label-outliers.service               # one tick now; safe, the write replaces the list
journalctl -u fluncle-label-outliers.service -n 40 --no-pager      # expect { "ok": true, "flagged": …, "pendingAlerts": … }
systemctl list-timers fluncle-label-outliers.timer
```

The first run announces the whole list as new, once. After it, open `/admin/label-outliers`, select the rows you already know are fine (the low-similarity triage's drum & bass verdicts among them), and mark them fine in one go; they stay off the list until their tracks change.

(A full re-provision restores the timer automatically — [`../install-host-timers.sh`](../install-host-timers.sh) installs every `*-timer/` directory.)
