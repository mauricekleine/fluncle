# fluncle-publish-advance-timer — the render → publish auto-advance on a host timer

The rave-02 host trigger for the `--no-agent` **render → publish auto-advance** sweep — the last autonomy gap in the finding pipeline. The render conductor finishes a finding's video; this closes the chain to publish with no operator beat between the two: a freshly-rendered, READY finding goes out as a hands-off PUBLIC YouTube Short and a TikTok inbox draft. (TikTok still needs the operator to finish it in-app — the licensed sound attaches only there. That is a platform limit, not ours, and it stays.)

The box holds no Postiz key, so it just TRIGGERS — one `curl` POST to the admin-tier `/api/admin/social/publish/advance` per tick, and the Worker does the work behind every safety gate. Zero LLM tokens. A host systemd timer `docker exec`s the baked sweep inside the `hermes` container every 30m.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — a lone [`../scripts/publish-advance-sweep.sh`](../scripts/publish-advance-sweep.sh) (no `.ts`; the whole job is one POST) — riding the image and auto-updating from `main` via pin-watch (Unit A). The host timer only triggers it.

## It ships DARK — the timer runs, the advance does not

**The Worker's kill switch defaults to PAUSED.** `is_publish_advance_paused` is default-deny: only the explicit string `"false"` in the `settings` row `publish_advance_paused` means running, so an unset key — which is what a fresh deploy has — reads as paused. Installing this timer therefore posts nothing. The tick fires, the Worker reads the switch, and returns `{ "paused": true }`.

Turning it on is ONE operator flip, no deploy:

```bash
fluncle admin publish resume   # or the toggle in the /admin/findings header
```

Turning it off again is the same flip in reverse (`fluncle admin publish pause`), and it takes effect within one tick — the switch is read FIRST, before any candidate is even selected.

## What the Worker guarantees (why this is safe to leave running)

Every gate lives Worker-side, where it is tested (`apps/web/src/lib/server/publish-advance.ts`, `orpc-publish-advance.test.ts`):

- **Never twice.** The advance only picks a finding with NO `social_posts` row for the platform, and it CLAIMS that row atomically (`insert … on conflict do nothing` against the `(track, platform)` unique index) BEFORE any call to Postiz. Two overlapping ticks race on the index; the loser skips.
- **Never half-rendered.** READY means the render finalized with BOTH masters (`video_url` + `video_squared_at`), it has settled 15 minutes (so a bad render is still the operator's to requeue), the whole publishable bundle is SERVED on R2 (the server-side mirror of the CLI's `bundle_incomplete` guard), and the caption is non-empty.
- **Fail closed, visibly.** A failed push leaves the row `failed` and is NEVER auto-retried — the finding keeps its `post-youtube` / `post-tiktok` row in the `/admin` attention queue, so a broken auto-publisher degrades into the manual flow the operator already knows.
- **Bounded.** One finding per tick; a rolling-24h cap of 6 pushes across both platforms; at most one YouTube push pending its URL at a time; TikTok held once its inbox has 5 unfinished drafts.

## Deploy (on rave-02, one time)

Install all timers at once with [`../install-host-timers.sh`](../install-host-timers.sh), or just this one:

```bash
sudo install -m 0644 docs/agents/hermes/publish-advance-timer/fluncle-publish-advance.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/publish-advance-timer/fluncle-publish-advance.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-publish-advance.timer

# Verify — with the switch still PAUSED (the default), expect `"paused":true` and no posts.
sudo systemctl start fluncle-publish-advance.service            # one tick now
journalctl -u fluncle-publish-advance.service -n 40 --no-pager  # expect {"ok":true,"paused":true,…}
systemctl list-timers fluncle-publish-advance.timer
```

Then, when the operator is ready to let the machine publish: `fluncle admin publish resume`, and watch the first advanced finding land on the channel before walking away. `/status` carries the `cron.publish-advance` row (the sweep self-writes its freshness marker via [`cron-output.sh`](../scripts/cron-output.sh)), so a stalled tick is visible there rather than silent.
