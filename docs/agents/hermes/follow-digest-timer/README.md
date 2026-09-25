# Follow digest timer

The host timer starts the baked, model-free follow digest sweep every Friday at 17:00 Amsterdam time. The Worker checks the default-enabled kill switch before selecting recipients, limits each request to 50 sends (a run stops at 1,000), and uses one Resend idempotency key per subscriber and ISO week. The box uses its agent-scoped API token; Resend credentials remain in the Worker.

Install the units from a repository checkout on the host after the image includes `follow-digest-sweep.sh` and `.ts`:

```bash
sudo bash docs/agents/hermes/install-host-timers.sh --refresh-unit fluncle-follow-digest.service --refresh-unit fluncle-follow-digest.timer
sudo systemctl enable --now fluncle-follow-digest.timer
systemctl list-timers fluncle-follow-digest.timer
```

The sweep writes a freshness marker through `cron-output.sh`, which also records the run in the telemetry ledger. The `/status` prober reads the marker as `cron.follow-digest`. `fluncle admin digests status`, `pause`, and `resume` control the Worker kill switch. Set `FOLLOW_DIGEST_TEST_RECIPIENT` on the Worker for a test send: the first eligible digest goes to that address with a separate idempotency key, without advancing subscriber delivery state. Remove the override after validation.
