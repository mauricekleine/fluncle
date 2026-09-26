# Follow digest timer

The host timer starts the baked, model-free follow digest sweep every Friday at 17:00 Amsterdam time. A same-Friday 18:15 slot retries an admission skip or incomplete sweep. The shared retry runner ignores Persistent catch-ups on Saturday, Monday, or any other day, and a missed Friday is skipped rather than sent late; the `/status` prober marks that missed slot degraded after the final slot and its grace period. The Worker also refuses off-slot sends, reports a closed window explicitly, and keys deliveries to the scheduled Amsterdam Friday. A closed window after runner admission leaves an incomplete marker so the retry slot or `/status` exposes the miss. It checks the default-enabled kill switch before selecting recipients, limits each request to 50 sends (a run stops at 1,000), and stores each recipient's rendered email and claim-specific Resend idempotency key before calling Resend. A same-Friday retry excludes sent delivery rows and replays an ambiguous claim with its identical payload and key within the safe window; older ambiguous claims become `unknown` and are never sent blindly. The box uses its agent-scoped API token; Resend credentials remain in the Worker.

Install the units from a repository checkout on the host after the image includes `follow-digest-sweep.sh` and `.ts`:

```bash
sudo bash docs/agents/hermes/install-host-timers.sh --refresh-unit fluncle-follow-digest.service --refresh-unit fluncle-follow-digest.timer --refresh-unit 'fluncle-sweep-failure@.service'
sudo systemctl try-restart fluncle-follow-digest.timer
systemctl list-timers fluncle-follow-digest.timer
```

The sweep writes a freshness marker through `cron-output.sh`, which also records sent, failed, skipped, and unknown counts in the telemetry ledger. The `/status` prober reads the marker as `cron.follow-digest`. `fluncle admin digests status`, `pause`, and `resume` control the Worker kill switch. Set `FOLLOW_DIGEST_TEST_RECIPIENT` on the Worker for a test send: the first eligible digest goes to that address with a separate idempotency key, without advancing subscriber delivery state. Remove the override after validation.
